/** Shared test helpers: fixtures, fake tracker, stub agent backend. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Issue } from '../src/domain/types.js';
import { ok, type Result, type TrackerError } from '../src/domain/errors.js';
import { resolveConfig, type ServiceConfig } from '../src/config/config.js';
import { parseWorkflow } from '../src/config/workflow.js';
import { adapterStateDefaults } from '../src/tracker/registry.js';
import type { AdapterProfile, ToolContext, ToolResult, ToolSpec, TrackerAdapter } from '../src/tracker/adapter.js';
import type { AgentBackend, AgentSession, AgentSessionStart, AgentTurnOptions, AgentTurnResult } from '../src/agent/backend.js';
import { makeAgentEvent, type AgentEvent } from '../src/agent/events.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { NullLogger } from '../src/observability/logger.js';
import type { ServiceSnapshot } from '../src/orchestrator/orchestrator.js';

export const logger = new NullLogger();

export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: '1',
    native_ref: null,
    identifier: 'DEMO-1',
    title: 'Test issue',
    description: 'Body',
    priority: null,
    state: 'open',
    branch_name: null,
    url: null,
    assignee_id: null,
    labels: [],
    blocked_by: [],
    dispatchable: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function workflowText(frontMatter: string, body = 'Work on {{ issue.identifier }}.'): string {
  return `---\n${frontMatter}\n---\n\n${body}\n`;
}

export interface ConfigOverrides {
  frontMatter?: string;
  body?: string;
  env?: NodeJS.ProcessEnv;
  workflowPath?: string;
}

const MINIMAL_FRONT_MATTER = [
  'tracker:',
  '  kind: memory',
  '  active_states: [open]',
  '  terminal_states: [closed]',
  'harness:',
  '  kind: dsh',
].join('\n');

/** Resolve a config from a synthetic workflow document. */
export function makeConfig(overrides: ConfigOverrides = {}): ServiceConfig {
  const definition = parseWorkflow(workflowText(overrides.frontMatter ?? MINIMAL_FRONT_MATTER, overrides.body ?? 'Work on {{ issue.identifier }}.'));
  return resolveConfig(definition, {
    workflowPath: overrides.workflowPath ?? join(tmpdir(), 'symphony-test', 'WORKFLOW.md'),
    env: overrides.env ?? {},
    adapterDefaults: adapterStateDefaults,
  });
}

/** A tracker whose responses the test drives directly. */
export class FakeTracker implements TrackerAdapter {
  readonly kind = 'fake';
  readonly profile: AdapterProfile = {
    kind: 'fake',
    display_name: 'Fake',
    required_provider_keys: [],
    optional_provider_keys: {},
    secret_environment_names: [],
    tool_names: [],
  };
  byStates: Issue[] = [];
  byIds: Issue[] = [];
  stateCalls: string[][] = [];
  idCalls: string[][] = [];
  stateResult: Result<Issue[], TrackerError> | null = null;
  idResult: Result<Issue[], TrackerError> | null = null;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  toolSpecs: ToolSpec[] = [];

  async fetchIssuesByStates(stateNames: string[]): Promise<Result<Issue[], TrackerError>> {
    this.stateCalls.push(stateNames);
    if (this.stateResult !== null) return this.stateResult;
    if (stateNames.length === 0) return ok([]);
    const wanted = new Set(stateNames.map((state) => state.trim().toLowerCase()));
    return ok(this.byStates.filter((issue) => wanted.has(issue.state.trim().toLowerCase())));
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Result<Issue[], TrackerError>> {
    this.idCalls.push(issueIds);
    if (this.idResult !== null) return this.idResult;
    const wanted = new Set(issueIds);
    return ok(this.byIds.filter((issue) => wanted.has(issue.id)));
  }

  agentToolSpecs(): ToolSpec[] {
    return this.toolSpecs;
  }

  secretEnvironmentNames(): string[] {
    return ['FAKE_TRACKER_TOKEN'];
  }

  async executeAgentTool(name: string, args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    this.toolCalls.push({ name, args });
    return { ok: true, output: { executed: name } };
  }
}

export interface StubTurnContext {
  issue: Issue;
  turn: number;
  prompt: string;
  session: StubSession;
  emit: (init: Parameters<typeof makeAgentEvent>[0]) => void;
}

/** A controllable agent backend; each turn delegates to the handler. */
export class StubBackend implements AgentBackend {
  readonly kind = 'stub';
  startCalls: AgentSessionStart[] = [];
  handler: (context: StubTurnContext) => Promise<AgentTurnResult> | AgentTurnResult;
  startedAt = 0;

  constructor(handler: (context: StubTurnContext) => Promise<AgentTurnResult> | AgentTurnResult) {
    this.handler = handler;
  }

  sessionTitle(issue: Issue): string {
    return `${issue.identifier}: ${issue.title}`;
  }

  async startSession(start: AgentSessionStart): Promise<AgentSession> {
    this.startCalls.push(start);
    const session = new StubSession(start, this);
    if (this.startedAt === 0) this.startedAt = Date.now();
    return session;
  }
}

export class StubSession implements AgentSession {
  readonly start: AgentSessionStart;
  private readonly backend: StubBackend;
  private turn = 0;
  stopped = false;

  constructor(start: AgentSessionStart, backend: StubBackend) {
    this.start = start;
    this.backend = backend;
  }

  get threadId(): string | null {
    return `thread-${this.start.issue.id}`;
  }

  get pid(): string | null {
    return '4242';
  }

  async runTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
    this.turn += 1;
    options.onEvent(
      makeAgentEvent({
        event: 'session_started',
        thread_id: this.threadId,
        message: 'session started',
        pid: this.pid,
      }),
    );
    options.onEvent(
      makeAgentEvent({
        event: 'turn_started',
        thread_id: this.threadId,
        turn_id: String(this.turn),
        message: 'turn started',
      }),
    );
    const result = await Promise.race([
      Promise.resolve(
        this.backend.handler({
          issue: this.start.issue,
          turn: this.turn,
          prompt: options.prompt,
          session: this,
          emit: (init) => options.onEvent(makeAgentEvent(init)),
        }),
      ),
      new Promise<AgentTurnResult>((resolve) => {
        const cancelled: AgentTurnResult = {
          ok: false,
          error: { category: 'turn_cancelled', message: 'turn cancelled' },
          session_id: null,
          turn_id: String(this.turn),
          final_text: null,
        };
        if (options.signal.aborted) {
          resolve(cancelled);
          return;
        }
        options.signal.addEventListener('abort', () => resolve(cancelled), { once: true });
      }),
    ]);
    options.onEvent(
      makeAgentEvent({
        event: result.ok ? 'turn_completed' : 'turn_failed',
        thread_id: this.threadId,
        turn_id: String(this.turn),
        message: result.ok ? 'turn completed' : 'turn failed',
      }),
    );
    return result;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

/** Build a snapshot for orchestrator tests. */
export function makeSnapshot(
  config: ServiceConfig,
  tracker: TrackerAdapter,
  backend: AgentBackend,
  overrides: Partial<ServiceSnapshot> = {},
): ServiceSnapshot {
  const workspace = new WorkspaceManager({
    workspace: config.workspace,
    hooks: config.hooks,
    logger,
    env: {},
  });
  return {
    version: 1,
    config,
    prompt_template: 'Work on {{ issue.identifier }}.',
    tracker,
    workspace,
    backend,
    bridge: null,
    env: {},
    secret_digest: 'test',
    ...overrides,
  };
}

export interface TempDir {
  path: string;
  cleanup: () => Promise<void>;
  write: (name: string, contents: string) => Promise<string>;
}

/** Create a throwaway directory for workspace/config fixtures. */
export async function tempDir(prefix = 'symphony-test-'): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    },
    write: async (name: string, contents: string) => {
      const target = join(path, name);
      mkdirSync(join(path, name, '..'), { recursive: true });
      await writeFile(target, contents, 'utf8');
      return target;
    },
  };
}

/** Poll until the predicate holds, or throw after the timeout. */
export async function waitFor(predicate: () => boolean, timeoutMs = 3_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A promise plus its resolvers. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export type { AgentEvent };
