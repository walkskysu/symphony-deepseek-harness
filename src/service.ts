/**
 * Service assembly: workflow loading and reload, adapter/workspace/backend
 * construction, orchestrator lifecycle, and the optional HTTP surface.
 */
import { stat, watch, type FSWatcher } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, basename, join } from 'node:path';

import { loadWorkflowFile } from './config/workflow.js';
import { resolveConfig, type ServiceConfig } from './config/config.js';
import { logEnvironmentResolution, resolveEnvironment } from './config/env-file.js';
import type { WorkflowDefinition } from './domain/types.js';
import { ValidationError, WorkflowError, describeError } from './domain/errors.js';
import { createLogger, type Logger } from './observability/logger.js';
import type { IssueDetail, RuntimeSnapshot } from './observability/snapshot.js';
import { adapterStateDefaults, createTrackerAdapter } from './tracker/registry.js';
import type { TrackerAdapter } from './tracker/adapter.js';
import { WorkspaceManager } from './workspace/manager.js';
import { createAgentBackend } from './agent/factory.js';
import type { AgentBackend } from './agent/backend.js';
import { ToolBridge } from './tools/bridge.js';
import { Orchestrator, type ServiceSnapshot } from './orchestrator/orchestrator.js';
import { startHttpServer, type RunningHttpServer } from './server/http.js';
import type { ProgramPlan } from './platform/launch.js';

export interface SymphonyServiceOptions {
  workflowPath: string;
  /** Base environment; defaults to `process.env`. `.env` only fills missing names. */
  env?: NodeJS.ProcessEnv;
  /** CLI `--port`; overrides `server.port`. `null` disables the HTTP server. */
  port?: number | null;
  host?: string | null;
  logger?: Logger;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  logFormat?: 'json' | 'pretty';
  logFile?: string | null;
  /** Disable filesystem watching (tests and one-shot runs). */
  watch?: boolean;
  /** Disable retry timers so tests can drive `fireRetry` manually. */
  autoTimers?: boolean;
  /** Explicit `.env` path (CLI `--env-file`). */
  envFile?: string | null;
  /** Skip `.env` loading entirely (CLI `--no-env-file`). */
  envFileDisabled?: boolean;
  /** Base environment; defaults to `process.env`. `.env` only fills gaps. */
  cwd?: string;
  /** Test seam: replace the agent backend entirely. */
  backend?: AgentBackend;
  /** Test seam: replace the agent process launch plan. */
  plan?: (args: string[], env: NodeJS.ProcessEnv) => ProgramPlan;
}

/** Case-insensitive environment lookup (Windows env names ignore case). */
function envValue(env: NodeJS.ProcessEnv, name: string): string {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower && value !== undefined) return value;
  }
  return '';
}

/**
 * Digest the credential-bearing environment values so a reload can tell whether
 * the adapter must be rebuilt. Only the digest leaves this function; values are
 * never logged or persisted.
 */
function digestSecrets(env: NodeJS.ProcessEnv, names: string[]): string {
  const hash = createHash('sha256');
  const unique = [...new Set(names.map((name) => name.toLowerCase()))].sort();
  for (const name of unique) hash.update(`${name}=${envValue(env, name)}\n`);
  return hash.digest('hex').slice(0, 32);
}

export class SymphonyService {
  readonly logger: Logger;
  private readonly options: SymphonyServiceOptions;
  private snapshotValue: ServiceSnapshot | null = null;
  private orchestrator: Orchestrator | null = null;
  private http: RunningHttpServer | null = null;
  private watcher: FSWatcher | null = null;
  private reloadChain: Promise<void> = Promise.resolve();
  private observedMtimeMs: number | null = null;
  private observedSize = -1;
  private stateVersion = 0;
  private started = false;
  private stopped = false;
  private resolvedEnvFile: string | null = null;
  private resolvedEnvNames: string[] = [];
  lastReloadError: string | null = null;

  constructor(options: SymphonyServiceOptions) {
    this.options = options;
    this.logger =
      options.logger ??
      createLogger({
        level: options.logLevel ?? 'info',
        format: options.logFormat ?? 'json',
        ...(options.logFile === null || options.logFile === undefined ? {} : { filePath: options.logFile }),
      });
  }

  /** Absolute workflow path this service is bound to. */
  get workflowPath(): string {
    return this.options.workflowPath;
  }

  /** The current effective configuration, or null before the first load. */
  get config(): ServiceConfig | null {
    return this.snapshotValue?.config ?? null;
  }

  get httpUrl(): string | null {
    return this.http?.url ?? null;
  }

  /** Loopback endpoint of the provider-native tool bridge, when it is running. */
  get toolBridgeUrl(): string | null {
    return this.snapshotValue?.bridge?.url ?? null;
  }

  /** The `.env` file applied to the current configuration, if any. */
  get envFile(): string | null {
    return this.resolvedEnvFile;
  }

  /** Variable names supplied by the `.env` file (never their values). */
  get envFileVariables(): string[] {
    return [...this.resolvedEnvNames];
  }

  /** Load config, run startup validation and cleanup, then start polling. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const snapshot = await this.buildSnapshot();
    this.snapshotValue = snapshot;
    this.observeFile();

    const config = snapshot.config;
    this.logger.info('symphony starting', {
      workflow: config.workflow_path,
      tracker: config.tracker.kind,
      agent: config.harness.kind,
      workspace_root: config.workspace.root,
      poll_interval_ms: config.polling.interval_ms,
      max_concurrent_agents: config.agent.max_concurrent_agents,
    });

    if (snapshot.bridge !== null) {
      // Tools are an optional extension: a bridge that cannot start must not
      // take the daemon down. Runs simply proceed without tracker tools.
      await snapshot.bridge.start().catch((error: unknown) => {
        this.logger.warn('tool bridge unavailable; running without tracker tools', {
          error: describeError(error),
          shim_dir_hint: 'check that workspace.root is writable',
        });
      });
    }

    const orchestrator = new Orchestrator({
      getSnapshot: () => this.requireSnapshot(),
      logger: this.logger,
      ...(this.options.autoTimers === undefined ? {} : { autoTimers: this.options.autoTimers }),
      beforeTick: async () => {
        await this.reloadIfChanged();
      },
    });
    this.orchestrator = orchestrator;
    await orchestrator.start();

    const port = this.options.port ?? config.server.port;
    if (port !== null && port !== undefined) {
      this.http = await startHttpServer(
        {
          logger: this.logger,
          workflowPath: () => this.workflowPath,
          snapshot: () => this.snapshot(),
          issueDetail: (identifier) => this.issueDetail(identifier),
          requestRefresh: () => this.requestRefresh(),
        },
        { port, host: this.options.host ?? config.server.host },
      );
    }

    if (this.options.watch !== false) this.startWatching();
  }

  /** Stop polling, terminate workers, close the server and watcher. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    await this.orchestrator?.stop();
    await this.http?.close();
    this.http = null;
    await this.snapshotValue?.bridge?.stop();
    await this.snapshotValue?.tracker.dispose?.();
    this.logger.info('symphony stopped');
  }

  /** Current runtime snapshot, or null before startup. */
  snapshot(): RuntimeSnapshot | null {
    return this.orchestrator?.snapshot() ?? null;
  }

  issueDetail(identifier: string): IssueDetail | null {
    return this.orchestrator?.issueDetail(identifier) ?? null;
  }

  requestRefresh(): { queued: boolean; coalesced: boolean } {
    return this.orchestrator?.requestRefresh() ?? { queued: false, coalesced: false };
  }

  /** Exposed for tests and embedding. */
  get activeOrchestrator(): Orchestrator | null {
    return this.orchestrator;
  }

  /* --------------------------------------------------------------- loading */

  private requireSnapshot(): ServiceSnapshot {
    if (this.snapshotValue === null) throw new Error('workflow has not been loaded yet');
    return this.snapshotValue;
  }

  private async buildSnapshot(previous?: ServiceSnapshot | null): Promise<ServiceSnapshot> {
    // Resolve the environment first: `.env` values feed config expansion, the
    // tracker credential, hooks and the agent child environment.
    const resolution = await resolveEnvironment({
      workflowDir: dirname(this.options.workflowPath),
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      explicitPath: this.options.envFile ?? null,
      ...(this.options.envFileDisabled === undefined ? {} : { disabled: this.options.envFileDisabled }),
      ...(this.options.env === undefined ? {} : { base: this.options.env }),
    });
    const env = resolution.env;
    this.resolvedEnvFile = resolution.file;
    this.resolvedEnvNames = [...resolution.applied];
    logEnvironmentResolution(this.logger, resolution);

    // DSH reserves its `DSH_*` names for the launching environment and refuses
    // to start when one of them is supplied through a `.env` file. Symphony
    // passes `.env` values to the agent child, so warn instead of failing later
    // with an opaque agent error.
    const reservedFromFile = resolution.applied.filter((name) => /^DSH_/i.test(name));
    if (reservedFromFile.length > 0) {
      this.logger.warn(
        '.env supplies DSH-reserved variables; DSH refuses to start with them, export them in the launch environment instead',
        { names: reservedFromFile.join(',') },
      );
    }

    const definition: WorkflowDefinition = await loadWorkflowFile(this.options.workflowPath);
    const config = resolveConfig(definition, {
      workflowPath: this.options.workflowPath,
      env,
      adapterDefaults: adapterStateDefaults,
    });

    if (config.harness.kind === 'dsh' && config.harness.model !== null) {
      this.logger.warn(
        'harness.model is ignored by the dsh backend; choose the model in the DSH profile or pass flags via harness.args',
        { model: config.harness.model },
      );
    }

    // Reuse the adapter (and the tool bridge that wraps it) when the tracker
    // configuration did not change, so an in-flight run's tool calls keep
    // working across a reload that only touched the prompt, hooks or timeouts.
    // The credential digest is part of the comparison: rotating a token in
    // `.env` must rebuild the adapter instead of silently reusing the old one.
    const secretDigest = digestSecrets(env, previous?.tracker.secretEnvironmentNames?.() ?? []);
    const sameTracker =
      previous !== undefined &&
      previous !== null &&
      previous.secret_digest === secretDigest &&
      JSON.stringify(previous.config.tracker) === JSON.stringify(config.tracker);
    const sameShimLocation =
      previous !== undefined && previous !== null && previous.config.workspace.root === config.workspace.root;

    let tracker: TrackerAdapter;
    if (sameTracker) {
      tracker = previous.tracker;
    } else {
      const trackerResult = createTrackerAdapter(config.tracker.kind, {
        provider: config.tracker.provider,
        active_states: config.tracker.active_states,
        terminal_states: config.tracker.terminal_states,
        env,
        onWarning: (message, context) => this.logger.warn(message, context),
      });
      if (!trackerResult.ok) {
        throw new ValidationError([{ code: trackerResult.error.category, message: trackerResult.error.message }]);
      }
      tracker = trackerResult.value;
    }

    const workspace = new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger: this.logger,
      env,
    });

    const backend =
      this.options.backend ??
      createAgentBackend({
        config,
        logger: this.logger,
        ...(this.options.plan === undefined ? {} : { plan: this.options.plan }),
      });

    let bridge: ToolBridge | null = null;
    if (config.tools.enabled) {
      const reusableBridge = previous !== undefined && previous !== null && previous.bridge !== null && sameTracker && sameShimLocation;
      bridge = reusableBridge
        ? previous.bridge
        : new ToolBridge({
            adapter: tracker,
            logger: this.logger,
            shimDir: join(config.workspace.root, '.symphony'),
          });
    }

    this.stateVersion += 1;
    return {
      version: this.stateVersion,
      config,
      prompt_template: definition.prompt_template,
      tracker,
      workspace,
      backend,
      bridge,
      env,
      secret_digest: secretDigest,
    };
  }

  /**
   * Re-read and re-apply the workflow. Invalid reloads keep the last known good
   * configuration and surface an operator-visible error (SPEC 6.2).
   */
  async reload(reason: string): Promise<void> {
    const task = this.reloadChain.then(async () => {
      if (this.stopped) return;
      try {
        const previous = this.snapshotValue;
        const next = await this.buildSnapshot(previous);
        this.snapshotValue = next;
        this.lastReloadError = null;
        this.observeFile();
        if (previous !== null) {
          if (previous.bridge !== null && previous.bridge !== next.bridge) {
            await previous.bridge.stop().catch(() => undefined);
          }
          if (previous.tracker !== next.tracker) await previous.tracker.dispose?.();
        }
        if (next.bridge !== null && next.bridge !== previous?.bridge) {
          await next.bridge.start().catch((error: unknown) => {
            this.logger.warn('tool bridge unavailable after reload; running without tracker tools', {
              error: describeError(error),
            });
          });
        }
        this.logger.info('workflow reloaded', {
          reason,
          version: next.version,
          tracker: next.config.tracker.kind,
          agent: next.config.harness.kind,
          poll_interval_ms: next.config.polling.interval_ms,
          max_concurrent_agents: next.config.agent.max_concurrent_agents,
        });
      } catch (error) {
        this.lastReloadError = describeError(error);
        const code = error instanceof WorkflowError || error instanceof ValidationError ? error.name : 'reload_error';
        this.logger.error('workflow reload failed; keeping last known good configuration', {
          reason,
          code,
          error: this.lastReloadError,
        });
      }
    });
    this.reloadChain = task.catch(() => undefined);
    await task;
  }

  /** Reload defensively when the file changed since the last observed state. */
  async reloadIfChanged(): Promise<void> {
    const info = await new Promise<{ mtimeMs: number; size: number } | null>((resolve) => {
      stat(this.options.workflowPath, (error, stats) => {
        resolve(error !== null ? null : { mtimeMs: stats.mtimeMs, size: stats.size });
      });
    });
    if (info === null) return;
    if (this.observedMtimeMs === null) {
      this.observedMtimeMs = info.mtimeMs;
      this.observedSize = info.size;
      return;
    }
    if (info.mtimeMs === this.observedMtimeMs && info.size === this.observedSize) return;
    await this.reload('file changed');
  }

  private observeFile(): void {
    stat(this.options.workflowPath, (error, stats) => {
      if (error !== null) return;
      this.observedMtimeMs = stats.mtimeMs;
      this.observedSize = stats.size;
    });
  }

  private startWatching(): void {
    const directory = dirname(this.options.workflowPath);
    const file = basename(this.options.workflowPath);
    let debounce: NodeJS.Timeout | null = null;
    try {
      this.watcher = watch(directory, { persistent: false }, (_event, filename) => {
        if (filename !== null && String(filename) !== file) return;
        if (debounce !== null) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = null;
          void this.reload('workflow file changed');
        }, 250);
        debounce.unref();
      });
    } catch (error) {
      this.logger.warn('cannot watch workflow file; falling back to stat polling', {
        workflow: this.options.workflowPath,
        error: describeError(error),
      });
    }
  }
}

export type { ServiceConfig };
