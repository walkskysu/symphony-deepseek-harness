/**
 * Typed configuration view over `WORKFLOW.md` front matter (SPEC section 6).
 *
 * Resolution order: parse -> defaults -> `$VAR`/`~` expansion -> coercion and
 * validation. Environment variables never override YAML globally; they are read
 * only where a config value explicitly references them, or where an adapter
 * documents a host-side fallback for an omitted provider field.
 */
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';

import type { WorkflowDefinition } from '../domain/types.js';
import { ValidationError, type ValidationProblem } from '../domain/errors.js';

export type HarnessKind = 'codex' | 'dsh';

export interface TrackerConfig {
  kind: string;
  provider: Record<string, unknown>;
  required_labels: string[];
  active_states: string[];
  terminal_states: string[];
}

export interface PollingConfig {
  interval_ms: number;
}

export interface WorkspaceConfig {
  /** Absolute, normalized workspace root. */
  root: string;
}

export interface HooksConfig {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  before_remove: string | null;
  timeout_ms: number;
  /** Optional explicit hook shell command, for example `bash -lc` or `pwsh -Command`. */
  shell: string | null;
}

export interface AgentConfig {
  max_concurrent_agents: number;
  max_turns: number;
  max_retry_backoff_ms: number;
  max_concurrent_agents_by_state: Record<string, number>;
}

export interface CodexConfig {
  command: string;
  approval_policy: string | null;
  thread_sandbox: string | null;
  turn_sandbox_policy: string | null;
  turn_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
}

export interface HarnessConfig {
  /** Which agent backend to drive: the Codex app-server or the DSH CLI. */
  kind: HarnessKind;
  /** Executable prefix for the agent, for example `dsh` or `codex app-server`. */
  command: string;
  /** Additional arguments inserted after the command. */
  args: string[];
  /** DSH profile used by the headless backend. */
  profile: string;
  /** Optional model override passed through to the agent. */
  model: string | null;
  /** Guidance sent to continuation turns inside one worker session. */
  continuation_prompt: string | null;
}

export interface ToolsConfig {
  enabled: boolean;
  prompt_hint: boolean;
}

export interface ServerConfig {
  port: number | null;
  host: string;
}

export interface ServiceConfig {
  workflow_path: string;
  workflow_dir: string;
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  harness: HarnessConfig;
  tools: ToolsConfig;
  server: ServerConfig;
  /** Raw front matter, preserved for extension consumers. */
  raw: Record<string, unknown>;
}

/** Adapter-provided defaults for the state lists (SPEC 5.3.1). */
export interface AdapterStateDefaults {
  active_states?: string[];
  terminal_states?: string[];
}

export interface ResolveConfigOptions {
  workflowPath: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults the selected adapter profile documents for omitted state lists. */
  adapterDefaults?: (kind: string, provider: Record<string, unknown>) => AdapterStateDefaults | undefined;
}

export class ConfigError extends ValidationError {}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_AGENTS = 10;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000;
const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const DEFAULT_STALL_TIMEOUT_MS = 300_000;
const DEFAULT_CODEX_COMMAND = 'codex app-server';
const DEFAULT_DSH_COMMAND = 'dsh';
const DEFAULT_SERVER_HOST = '127.0.0.1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function section(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key];
  return isRecord(value) ? value : {};
}

function has(map: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

/** Expand `${VAR}` and `$VAR` using the provided environment. */
export function expandEnvString(value: string, env: NodeJS.ProcessEnv): string {
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => env[name] ?? '');
}

/**
 * Resolve `$VAR` indirection for a whole value: a value that is exactly one
 * environment reference is replaced by that variable's value. A reference to an
 * unset (or empty) variable yields `null`, which callers treat as missing.
 */
export function resolveEnvReference(value: string, env: NodeJS.ProcessEnv): string | null {
  const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value.trim());
  if (match === null) return value;
  const resolved = env[match[1] as string];
  return resolved === undefined || resolved === '' ? null : resolved;
}

/** Expand `~` and environment variables in a filesystem path, then absolutize it. */
export function expandPath(value: string, baseDir: string, env: NodeJS.ProcessEnv): string {
  let text = value.trim();
  const fromEnv = resolveEnvReference(text, env);
  if (fromEnv === null) return '';
  text = fromEnv;
  text = expandEnvString(text, env);
  if (text === '~') text = homedir();
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = resolvePath(homedir(), text.slice(2));
  return isAbsolute(text) ? resolvePath(text) : resolvePath(baseDir, text);
}

function readInt(
  value: unknown,
  fallback: number,
  problems: ValidationProblem[],
  field: string,
  constraints: { min?: number; max?: number } = {},
): number {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    problems.push({ code: 'invalid_integer', message: `${field} must be an integer` });
    return fallback;
  }
  if (constraints.min !== undefined && parsed < constraints.min) {
    problems.push({ code: 'invalid_integer', message: `${field} must be >= ${constraints.min}` });
    return fallback;
  }
  if (constraints.max !== undefined && parsed > constraints.max) {
    problems.push({ code: 'invalid_integer', message: `${field} must be <= ${constraints.max}` });
    return fallback;
  }
  return parsed;
}

function readStringArray(value: unknown, problems: ValidationProblem[], field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    problems.push({ code: 'invalid_list', message: `${field} must be a list of strings` });
    return undefined;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      problems.push({ code: 'invalid_list', message: `${field} must contain only strings` });
      return undefined;
    }
    out.push(entry);
  }
  return out;
}

function readOptionalString(value: unknown, problems: ValidationProblem[], field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    problems.push({ code: 'invalid_string', message: `${field} must be a string` });
    return null;
  }
  return value;
}

/**
 * Build the typed service config from a parsed workflow definition.
 *
 * @throws ValidationError when a value cannot be coerced, or when dispatch
 * critical settings are missing.
 */
export function resolveConfig(definition: WorkflowDefinition, options: ResolveConfigOptions): ServiceConfig {
  const env = options.env ?? process.env;
  const workflowPath = resolvePath(options.workflowPath);
  const workflowDir = dirname(workflowPath);
  const raw = definition.config;
  const problems: ValidationProblem[] = [];

  const trackerRaw = section(raw, 'tracker');
  const provider = isRecord(trackerRaw['provider']) ? (trackerRaw['provider'] as Record<string, unknown>) : {};
  if (has(trackerRaw, 'provider') && trackerRaw['provider'] !== null && !isRecord(trackerRaw['provider'])) {
    problems.push({ code: 'invalid_tracker_provider', message: 'tracker.provider must be a mapping' });
  }

  const kindRaw = trackerRaw['kind'];
  const kind = typeof kindRaw === 'string' ? kindRaw.trim() : '';
  if (kind === '') {
    if (has(trackerRaw, 'kind')) {
      problems.push({ code: 'invalid_tracker_kind', message: 'tracker.kind must be a non-empty string' });
    }
  }

  const adapterDefaults = options.adapterDefaults?.(kind, provider);
  const activeStates = readStringArray(trackerRaw['active_states'], problems, 'tracker.active_states')
    ?? adapterDefaults?.active_states;
  const terminalStates = readStringArray(trackerRaw['terminal_states'], problems, 'tracker.terminal_states')
    ?? adapterDefaults?.terminal_states;
  if (activeStates === undefined || activeStates.length === 0) {
    problems.push({
      code: 'missing_active_states',
      message: 'tracker.active_states is required (the selected adapter profile documents no default)',
    });
  }
  if (terminalStates === undefined || terminalStates.length === 0) {
    problems.push({
      code: 'missing_terminal_states',
      message: 'tracker.terminal_states is required (the selected adapter profile documents no default)',
    });
  }

  const requiredLabels = readStringArray(trackerRaw['required_labels'], problems, 'tracker.required_labels') ?? [];

  const pollingRaw = section(raw, 'polling');
  const intervalMs = readInt(pollingRaw['interval_ms'], DEFAULT_POLL_INTERVAL_MS, problems, 'polling.interval_ms', {
    min: 1,
  });

  const workspaceRaw = section(raw, 'workspace');
  const rootRaw = readOptionalString(workspaceRaw['root'], problems, 'workspace.root');
  const rootSource = rootRaw === null || rootRaw.trim() === '' ? resolvePath(tmpdir(), 'symphony_workspaces') : rootRaw;
  const rootExpanded = expandPath(rootSource, workflowDir, env);
  if (rootExpanded === '') {
    problems.push({
      code: 'missing_workspace_root',
      message: `workspace.root references an unset environment variable: ${rootSource}`,
    });
  }

  const hooksRaw = section(raw, 'hooks');
  const hookTimeout = readInt(hooksRaw['timeout_ms'], DEFAULT_HOOK_TIMEOUT_MS, problems, 'hooks.timeout_ms', { min: 1 });
  const afterCreate = readOptionalString(hooksRaw['after_create'], problems, 'hooks.after_create');
  const beforeRun = readOptionalString(hooksRaw['before_run'], problems, 'hooks.before_run');
  const afterRun = readOptionalString(hooksRaw['after_run'], problems, 'hooks.after_run');
  const beforeRemove = readOptionalString(hooksRaw['before_remove'], problems, 'hooks.before_remove');
  const hookShell = readOptionalString(hooksRaw['shell'], problems, 'hooks.shell');

  const agentRaw = section(raw, 'agent');
  const maxConcurrentAgents = readInt(
    agentRaw['max_concurrent_agents'],
    DEFAULT_MAX_CONCURRENT_AGENTS,
    problems,
    'agent.max_concurrent_agents',
    { min: 1 },
  );
  const maxTurns = readInt(agentRaw['max_turns'], DEFAULT_MAX_TURNS, problems, 'agent.max_turns', { min: 1 });
  const maxRetryBackoff = readInt(
    agentRaw['max_retry_backoff_ms'],
    DEFAULT_MAX_RETRY_BACKOFF_MS,
    problems,
    'agent.max_retry_backoff_ms',
    { min: 0 },
  );

  const byStateRaw = agentRaw['max_concurrent_agents_by_state'];
  const byState: Record<string, number> = {};
  if (byStateRaw !== undefined && byStateRaw !== null) {
    if (!isRecord(byStateRaw)) {
      problems.push({ code: 'invalid_state_limits', message: 'agent.max_concurrent_agents_by_state must be a mapping' });
    } else {
      for (const [stateKey, limitValue] of Object.entries(byStateRaw)) {
        const normalized = stateKey.trim().toLowerCase();
        const limit = typeof limitValue === 'number' ? limitValue : Number(limitValue);
        // Invalid entries are ignored, per SPEC 5.3.5.
        if (normalized === '' || !Number.isInteger(limit) || limit <= 0) continue;
        byState[normalized] = limit;
      }
    }
  }

  const codexRaw = section(raw, 'codex');
  const codexCommandRaw = codexRaw['command'];
  let codexCommand = DEFAULT_CODEX_COMMAND;
  if (typeof codexCommandRaw === 'string' && codexCommandRaw.trim() !== '') {
    const resolved = resolveEnvReference(codexCommandRaw, env);
    if (resolved === null) {
      // A whole-value $VAR that resolves to nothing is a configuration error,
      // not a command literally named "$FOO".
      problems.push({
        code: 'invalid_codex_command',
        message: `codex.command references an unset or empty environment variable: ${codexCommandRaw.trim()}`,
      });
    } else {
      codexCommand = resolved;
    }
  } else if (codexCommandRaw !== undefined && codexCommandRaw !== null) {
    problems.push({ code: 'invalid_codex_command', message: 'codex.command must be a non-empty string' });
  }

  const harnessRaw = section(raw, 'harness');
  const harnessKindRaw = harnessRaw['kind'];
  let harnessKind: HarnessKind = 'codex';
  if (typeof harnessKindRaw === 'string' && harnessKindRaw.trim() !== '') {
    const normalized = harnessKindRaw.trim().toLowerCase();
    if (normalized === 'dsh' || normalized === 'codex') harnessKind = normalized;
    else {
      problems.push({
        code: 'unsupported_harness_kind',
        message: `harness.kind must be one of codex, dsh (got ${JSON.stringify(harnessKindRaw)})`,
      });
    }
  } else if (harnessKindRaw !== undefined && harnessKindRaw !== null) {
    problems.push({ code: 'invalid_harness_kind', message: 'harness.kind must be a string' });
  }

  const harnessCommandRaw = readOptionalString(harnessRaw['command'], problems, 'harness.command');
  const harnessCommandDefault = harnessKind === 'dsh' ? DEFAULT_DSH_COMMAND : codexCommand;
  let harnessCommand = harnessCommandDefault;
  if (harnessCommandRaw !== null) {
    if (harnessCommandRaw.trim() === '') {
      // An explicitly empty command can never launch an agent.
      problems.push({ code: 'missing_harness_command', message: 'harness.command must not be empty when set' });
    } else {
      const resolved = resolveEnvReference(harnessCommandRaw, env);
      if (resolved === null) {
        problems.push({
          code: 'missing_harness_command',
          message: `harness.command references an unset or empty environment variable: ${harnessCommandRaw.trim()}`,
        });
      } else {
        harnessCommand = resolved;
      }
    }
  }
  if (harnessCommand.trim() === '') {
    problems.push({ code: 'missing_harness_command', message: 'the coding-agent command must not be empty' });
  }

  const harnessArgs = readStringArray(harnessRaw['args'], problems, 'harness.args') ?? [];
  const harnessProfile = typeof harnessRaw['profile'] === 'string' && harnessRaw['profile'].trim() !== ''
    ? harnessRaw['profile'].trim()
    : 'headless';
  const harnessModel = readOptionalString(harnessRaw['model'], problems, 'harness.model');
  const continuationPrompt = readOptionalString(
    harnessRaw['continuation_prompt'],
    problems,
    'harness.continuation_prompt',
  );

  const toolsRaw = section(raw, 'tools');
  const toolsEnabled = readBoolean(toolsRaw['enabled'], true, problems, 'tools.enabled');
  const toolsPromptHint = readBoolean(toolsRaw['prompt_hint'], true, problems, 'tools.prompt_hint');

  const serverRaw = section(raw, 'server');
  const portRaw = serverRaw['port'];
  let serverPort: number | null = null;
  if (portRaw !== undefined && portRaw !== null) {
    const parsed = readInt(portRaw, 0, problems, 'server.port', { min: 0, max: 65535 });
    serverPort = Number.isInteger(parsed) ? parsed : null;
  }
  const hostRaw = readOptionalString(serverRaw['host'], problems, 'server.host');

  if (problems.length > 0) throw new ValidationError(problems);

  return {
    workflow_path: workflowPath,
    workflow_dir: workflowDir,
    tracker: {
      kind,
      provider,
      required_labels: requiredLabels.map((label) => label.trim().toLowerCase()),
      active_states: (activeStates ?? []).map((state) => state.trim()),
      terminal_states: (terminalStates ?? []).map((state) => state.trim()),
    },
    polling: { interval_ms: intervalMs },
    workspace: { root: rootExpanded },
    hooks: {
      after_create: afterCreate,
      before_run: beforeRun,
      after_run: afterRun,
      before_remove: beforeRemove,
      timeout_ms: hookTimeout,
      shell: hookShell,
    },
    agent: {
      max_concurrent_agents: maxConcurrentAgents,
      max_turns: maxTurns,
      max_retry_backoff_ms: maxRetryBackoff,
      max_concurrent_agents_by_state: byState,
    },
    codex: {
      command: codexCommand,
      approval_policy: readOptionalString(codexRaw['approval_policy'], problems, 'codex.approval_policy'),
      thread_sandbox: readOptionalString(codexRaw['thread_sandbox'], problems, 'codex.thread_sandbox'),
      turn_sandbox_policy: readOptionalString(codexRaw['turn_sandbox_policy'], problems, 'codex.turn_sandbox_policy'),
      turn_timeout_ms: readInt(codexRaw['turn_timeout_ms'], DEFAULT_TURN_TIMEOUT_MS, problems, 'codex.turn_timeout_ms', {
        min: 1,
      }),
      read_timeout_ms: readInt(codexRaw['read_timeout_ms'], DEFAULT_READ_TIMEOUT_MS, problems, 'codex.read_timeout_ms', {
        min: 1,
      }),
      stall_timeout_ms: readInt(codexRaw['stall_timeout_ms'], DEFAULT_STALL_TIMEOUT_MS, problems, 'codex.stall_timeout_ms'),
    },
    harness: {
      kind: harnessKind,
      command: harnessCommand,
      args: harnessArgs,
      profile: harnessProfile,
      model: harnessModel,
      continuation_prompt: continuationPrompt,
    },
    tools: { enabled: toolsEnabled, prompt_hint: toolsPromptHint },
    server: { port: serverPort, host: hostRaw !== null && hostRaw.trim() !== '' ? hostRaw.trim() : DEFAULT_SERVER_HOST },
    raw,
  };
}

function readBoolean(value: unknown, fallback: boolean, problems: ValidationProblem[], field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes' || normalized === '1') return true;
    if (normalized === 'false' || normalized === 'no' || normalized === '0') return false;
  }
  problems.push({ code: 'invalid_boolean', message: `${field} must be a boolean` });
  return fallback;
}

/** Normalize one issue state for case-insensitive scheduler comparison (SPEC 4.2). */
export function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}

/** Normalize one label for case-insensitive matching. */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}
