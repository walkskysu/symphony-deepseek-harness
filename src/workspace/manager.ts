/**
 * Per-issue workspace lifecycle and safety invariants (SPEC section 9).
 *
 * Workspaces are deterministic, reused across runs, and always kept inside the
 * configured workspace root. Hooks run with the workspace as cwd.
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { HooksConfig, WorkspaceConfig } from '../config/config.js';
import type { Workspace } from '../domain/types.js';
import type { Logger } from '../observability/logger.js';
import { isWindowsReservedName } from '../platform/paths.js';
import { assertInsideRoot } from '../platform/paths.js';
import { resolveShell, runShellScript, truncateOutput, type ShellSpec } from '../platform/shell.js';

const WORKSPACE_KEY_PATTERN = /[^A-Za-z0-9._-]/g;

/**
 * Derive the workspace-key for an issue identifier (SPEC 4.2):
 * characters outside `[A-Za-z0-9._-]` become `_`, and when sanitization changes
 * the identifier the original identifier's stable hash is appended so distinct
 * identifiers that sanitize to the same text keep distinct directories.
 */
export function deriveWorkspaceKey(identifier: string): string {
  const sanitized = identifier.replace(WORKSPACE_KEY_PATTERN, '_');
  // Windows also rejects `.`/`..` and device names even though they are made of
  // allowed characters; those cases take the same hash-suffixed form.
  const needsHash =
    sanitized !== identifier ||
    sanitized === '.' ||
    sanitized === '..' ||
    sanitized === '' ||
    /[. ]$/.test(sanitized) ||
    isWindowsReservedName(sanitized);
  if (!needsHash) return sanitized;
  const digest = createHash('sha256').update(identifier, 'utf8').digest('hex').slice(0, 16);
  return `${sanitized}_${digest}`;
}

export interface HookOutcome {
  hook: 'after_create' | 'before_run' | 'after_run' | 'before_remove';
  ok: boolean;
  timedOut: boolean;
  duration_ms: number;
  exit_code: number | null;
  output: string;
}

/**
 * Extra non-secret environment variables exposed to a hook. The runner uses
 * this to describe the current normalized issue so a workflow that covers
 * several repositories can select the right checkout without provider-specific
 * logic in the workspace layer.
 */
export type HookEnvironment = Record<string, string>;

export interface WorkspaceManagerOptions {
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  /** Test seam: bypass the platform shell resolution. */
  shell?: ShellSpec;
}

/**
 * Owns workspace path computation, creation, hook execution and removal.
 *
 * The manager is constructed from a config snapshot. The service rebuilds it
 * after a workflow reload so workspace root and hook changes apply to future
 * runs (SPEC 6.2).
 */
export class WorkspaceManager {
  private readonly options: WorkspaceManagerOptions;

  constructor(options: WorkspaceManagerOptions) {
    this.options = options;
  }

  get root(): string {
    return this.options.workspace.root;
  }

  /** Deterministic workspace path and key for an identifier. */
  pathFor(identifier: string): { path: string; workspace_key: string } {
    const workspaceKey = deriveWorkspaceKey(identifier);
    const path = resolve(join(this.options.workspace.root, workspaceKey));
    assertInsideRoot(this.options.workspace.root, path);
    return { path, workspace_key: workspaceKey };
  }

  /**
   * Ensure the workspace exists, running `after_create` only on new creation.
   *
   * @throws when the directory cannot be created or the hook fails.
   */
  async ensure(identifier: string, environment: HookEnvironment = {}): Promise<Workspace> {
    const { path, workspace_key } = this.pathFor(identifier);
    const createdNow = await this.ensureDirectory(path);
    if (createdNow === false) return { path, workspace_key, created_now: false };

    const outcome = await this.runHook('after_create', this.options.hooks.after_create, path, {
      issue_identifier: identifier,
      environment,
    });
    if (outcome !== null && outcome.ok === false) {
      // Workspace creation failure is fatal; remove the partially prepared dir.
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(
        `after_create hook failed for ${identifier}: ${outcome.timedOut ? 'timeout' : `exit ${outcome.exit_code ?? 'unknown'}`}`,
      );
    }
    return { path, workspace_key, created_now: true };
  }

  private async ensureDirectory(path: string): Promise<boolean> {
    let exists = false;
    let isDirectory = false;
    try {
      const info = await stat(path);
      exists = true;
      isDirectory = info.isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (exists && isDirectory) return false;
    if (exists && !isDirectory) {
      // Policy: replace a non-directory occupant rather than reusing it.
      this.options.logger.warn('workspace path occupied by a file; replacing', { path });
      await unlink(path);
    }
    await mkdir(path, { recursive: true });
    return true;
  }

  /** Run `before_run`; failure aborts the current attempt. */
  async beforeRun(workspacePath: string, issueIdentifier?: string, environment: HookEnvironment = {}): Promise<void> {
    const outcome = await this.runHook('before_run', this.options.hooks.before_run, workspacePath, {
      ...(issueIdentifier === undefined ? {} : { issue_identifier: issueIdentifier }),
      environment,
    });
    if (outcome !== null && outcome.ok === false) {
      throw new Error(
        `before_run hook failed: ${outcome.timedOut ? 'timeout' : `exit ${outcome.exit_code ?? 'unknown'}`}`,
      );
    }
  }

  /** Run `after_run`; failures are logged and ignored. */
  async afterRun(workspacePath: string, issueIdentifier?: string, environment: HookEnvironment = {}): Promise<void> {
    await this.runHook('after_run', this.options.hooks.after_run, workspacePath, {
      ignoreFailure: true,
      ...(issueIdentifier === undefined ? {} : { issue_identifier: issueIdentifier }),
      environment,
    });
  }

  /** Remove a workspace, running `before_remove` when the directory exists. */
  async remove(identifier: string, environment: HookEnvironment = {}): Promise<void> {
    const { path } = this.pathFor(identifier);
    let exists = false;
    try {
      exists = (await stat(path)).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) return;
    await this.runHook('before_remove', this.options.hooks.before_remove, path, {
      ignoreFailure: true,
      issue_identifier: identifier,
      environment,
    });
    await rm(path, { recursive: true, force: true });
  }

  /** True when the path is a usable directory inside the workspace root. */
  async isUsableWorkspace(path: string): Promise<boolean> {
    try {
      assertInsideRoot(this.options.workspace.root, path);
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  private async runHook(
    hook: 'after_create' | 'before_run' | 'after_run' | 'before_remove',
    script: string | null,
    workspacePath: string,
    options: { ignoreFailure?: boolean; issue_identifier?: string; environment?: HookEnvironment } = {},
  ): Promise<HookOutcome | null> {
    if (script === null || script.trim() === '') return null;
    const shell = this.options.shell ?? resolveShell(this.options.hooks.shell);
    const startedAt = Date.now();
    const context = options.issue_identifier === undefined ? {} : { issue_identifier: options.issue_identifier };
    this.options.logger.info('hook started', { hook, workspace: workspacePath, ...context });
    const result = await runShellScript(shell, script, {
      cwd: workspacePath,
      // Issue context is additive: hooks still see the process/.env environment.
      env: { ...(this.options.env ?? process.env), ...(options.environment ?? {}) },
      timeoutMs: this.options.hooks.timeout_ms,
    });
    const outcome: HookOutcome = {
      hook,
      ok: result.code === 0 && result.spawnError === null,
      timedOut: result.timedOut,
      duration_ms: Date.now() - startedAt,
      exit_code: result.code,
      output: truncateOutput(`${result.stdout}\n${result.stderr}`),
    };
    if (outcome.ok) {
      this.options.logger.info('hook completed', {
        hook,
        workspace: workspacePath,
        duration_ms: outcome.duration_ms,
        ...context,
      });
    } else {
      const message = result.timedOut
        ? `hook timed out after ${this.options.hooks.timeout_ms}ms`
        : `hook failed${result.spawnError !== null ? `: ${result.spawnError.message}` : `: exit ${result.code ?? 'unknown'}`}`;
      if (options.ignoreFailure === true) {
        this.options.logger.warn('hook failed (ignored)', {
          hook,
          workspace: workspacePath,
          reason: message,
          output: outcome.output,
          ...context,
        });
      } else {
        this.options.logger.error('hook failed', {
          hook,
          workspace: workspacePath,
          reason: message,
          output: outcome.output,
          ...context,
        });
      }
    }
    return outcome;
  }
}
