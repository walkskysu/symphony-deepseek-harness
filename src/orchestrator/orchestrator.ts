/**
 * The single-authority orchestrator (SPEC 7, 8, 16).
 *
 * Responsibilities: poll ticks, reconciliation, dispatch, claims, retries and
 * workspace cleanup. All scheduler state mutation happens here; workers only
 * report outcomes back through callbacks.
 */
import type {
  CancelReason,
  CodexTotals,
  Issue,
  LiveSession,
  OrchestratorState,
  RecentEvent,
  RetryEntry,
  RunningEntry,
  RunAttemptPhase,
  WorkerOutcome,
} from '../domain/types.js';
import type { ServiceConfig } from '../config/config.js';
import { normalizeState } from '../config/config.js';
import type { Logger } from '../observability/logger.js';
import type { IssueDetail, RuntimeSnapshot, SnapshotRunningRow, SnapshotRetryRow } from '../observability/snapshot.js';
import type { TrackerAdapter } from '../tracker/adapter.js';
import type { AgentBackend } from '../agent/backend.js';
import type { AgentEvent } from '../agent/events.js';
import { summarizeEvent } from '../agent/events.js';
import type { ToolBridge } from '../tools/bridge.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import { describeError, type ValidationProblem } from '../domain/errors.js';
import { isSupportedTrackerKind } from '../tracker/registry.js';
import { AgentRunner, type AttemptCallbacks, type AttemptResult } from '../runner/runner.js';
import {
  globalConcurrency,
  hasStateSlot,
  isActiveState,
  isRoutable,
  isTerminalState,
  sortForDispatch,
  stateConcurrencyLimit,
  hasRequiredIdentity,
} from './eligibility.js';

const CONTINUATION_RETRY_DELAY_MS = 1_000;
const BASE_RETRY_DELAY_MS = 10_000;
const MAX_RECENT_EVENTS = 25;
const MAX_HISTORY = 200;
/** How long a canceled worker may linger before its slot is reclaimed. */
const CANCELED_GRACE_MS = 60_000;

/** One effective, validation-passed configuration snapshot. */
export interface ServiceSnapshot {
  version: number;
  config: ServiceConfig;
  prompt_template: string;
  tracker: TrackerAdapter;
  workspace: WorkspaceManager;
  backend: AgentBackend;
  bridge: ToolBridge | null;
  env: NodeJS.ProcessEnv;
  /**
   * Digest of the credential-bearing environment values used to build the
   * adapter. A changed digest forces the adapter (and its tool bridge) to be
   * rebuilt on reload, so rotating a token in `.env` takes effect.
   */
  secret_digest: string;
}

export interface OrchestratorOptions {
  getSnapshot(): ServiceSnapshot;
  logger: Logger;
  /** Force manual retry scheduling (tests drive `fireRetry` themselves). */
  autoTimers?: boolean;
  /** Called after each tick/state change so a status surface can refresh. */
  onStateChange?: () => void;
  /** Awaited at the start of every tick, before the snapshot is read. */
  beforeTick?: () => Promise<void>;
}

interface IssueHistory {
  issue_id: string;
  issue_identifier: string;
  issue_url: string | null;
  status: 'running' | 'retrying' | 'completed' | 'released';
  workspace_path: string | null;
  last_error: string | null;
  last_event_at: string | null;
  restart_count: number;
  recent_events: RecentEvent[];
  updated_at_ms: number;
}

function emptyLiveSession(): LiveSession {
  return {
    session_id: null,
    thread_id: null,
    turn_id: null,
    codex_app_server_pid: null,
    last_codex_event: null,
    last_codex_timestamp: null,
    last_codex_message: null,
    codex_input_tokens: 0,
    codex_output_tokens: 0,
    codex_total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    turn_count: 0,
  };
}

function emptyTotals(): CodexTotals {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 };
}

function isoTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

/** The orchestrator. Construct with an effective-config accessor; call `start()`. */
export class Orchestrator {
  private state: OrchestratorState;
  private readonly logger: Logger;
  private readonly options: OrchestratorOptions;
  private tickTimer: NodeJS.Timeout | null = null;
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly workers = new Set<Promise<void>>();
  private readonly history = new Map<string, IssueHistory>();
  private ticking = false;
  private refreshRequested = false;
  private stopping = false;
  private started = false;
  private lastTickAt: string | null = null;
  private lastError: string | null = null;

  constructor(options: OrchestratorOptions) {
    this.options = options;
    this.logger = options.logger;
    this.state = this.initialState(options.getSnapshot().config);
  }

  private initialState(config: ServiceConfig): OrchestratorState {
    return {
      poll_interval_ms: config.polling.interval_ms,
      max_concurrent_agents: config.agent.max_concurrent_agents,
      running: new Map(),
      claimed: new Set(),
      retry_attempts: new Map(),
      completed: new Set(),
      codex_totals: emptyTotals(),
      codex_rate_limits: null,
    };
  }

  /* ------------------------------------------------------------- lifecycle */

  /** Validate, clean stale terminal workspaces, then run the first tick. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const snapshot = this.options.getSnapshot();
    this.applyConfig(snapshot.config);
    const problems = this.validateDispatch(snapshot);
    if (problems.length > 0) {
      this.reportValidation(problems);
      throw new Error(`startup validation failed: ${problems.map((problem) => problem.message).join('; ')}`);
    }
    await this.startupTerminalCleanup(snapshot);
    await this.tick();
  }

  /** Cancel timers, abort workers and release claims. */
  async stop(reason = 'shutdown'): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.tickTimer !== null) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    for (const [issueId, timer] of this.retryTimers) {
      clearTimeout(timer);
      this.retryTimers.delete(issueId);
    }
    for (const entry of this.state.running.values()) {
      if (entry.cancel_reason === null) {
        entry.cancel_reason = 'shutdown';
        entry.canceled_at_ms = Date.now();
        entry.abort.abort();
      }
    }
    this.state.retry_attempts.clear();
    this.state.claimed.clear();
    this.logger.info('orchestrator stopping', { reason, running: this.state.running.size });
    await Promise.allSettled([...this.workers]);
    this.state.running.clear();
    this.notify();
  }

  /** Run one poll tick now (also used by tests and `POST /api/v1/refresh`). */
  async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.ticking) {
      this.refreshRequested = true;
      return;
    }
    this.ticking = true;
    try {
      await this.options.beforeTick?.();
      const snapshot = this.options.getSnapshot();
      this.applyConfig(snapshot.config);
      await this.reconcileRunning(snapshot);

      const problems = this.validateDispatch(snapshot);
      if (problems.length > 0) {
        this.reportValidation(problems);
        return;
      }

      const fetched = await snapshot.tracker.fetchIssuesByStates(snapshot.config.tracker.active_states);
      if (!fetched.ok) {
        this.lastError = `${fetched.error.category}: ${fetched.error.message}`;
        this.logger.warn('candidate fetch failed; skipping dispatch for this tick', {
          category: fetched.error.category,
          error: fetched.error.message,
        });
        return;
      }

      const candidates = sortForDispatch(fetched.value);
      for (const issue of candidates) {
        if (globalConcurrency(snapshot.config, this.state.running.size) <= 0) break;
        if (!this.shouldDispatch(issue, snapshot.config, null)) continue;
        if (!hasStateSlot(snapshot.config, this.state.running, issue.state)) {
          this.logger.debug('per-state concurrency limit reached', {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            state: issue.state,
            limit: stateConcurrencyLimit(snapshot.config, issue.state),
          });
          continue;
        }
        this.dispatchIssue(issue, snapshot, null);
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = describeError(error);
      this.logger.error('poll tick failed', { error: this.lastError });
    } finally {
      this.ticking = false;
      this.lastTickAt = new Date().toISOString();
      this.notify();
      this.scheduleNextTick();
      if (this.refreshRequested) {
        this.refreshRequested = false;
        setImmediate(() => {
          void this.tick();
        });
      }
    }
  }

  /** Request an immediate poll + reconcile cycle (best effort, coalesced). */
  requestRefresh(): { queued: boolean; coalesced: boolean } {
    if (this.stopping) return { queued: false, coalesced: false };
    if (this.ticking) {
      const already = this.refreshRequested;
      this.refreshRequested = true;
      return { queued: true, coalesced: already };
    }
    setImmediate(() => {
      void this.tick();
    });
    return { queued: true, coalesced: false };
  }

  private applyConfig(config: ServiceConfig): void {
    if (this.state.poll_interval_ms !== config.polling.interval_ms) {
      this.logger.info('poll interval updated', { poll_interval_ms: config.polling.interval_ms });
      this.state.poll_interval_ms = config.polling.interval_ms;
    }
    if (this.state.max_concurrent_agents !== config.agent.max_concurrent_agents) {
      this.logger.info('concurrency limit updated', { max_concurrent_agents: config.agent.max_concurrent_agents });
      this.state.max_concurrent_agents = config.agent.max_concurrent_agents;
    }
  }

  private scheduleNextTick(): void {
    if (this.stopping) return;
    if (this.tickTimer !== null) clearTimeout(this.tickTimer);
    const interval = this.state.poll_interval_ms;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      void this.tick();
    }, interval);
    this.tickTimer.unref();
  }

  private notify(): void {
    try {
      this.options.onStateChange?.();
    } catch {
      // Observers must never break scheduling.
    }
  }

  /* --------------------------------------------------------- reconciliation */

  /** Part A (stall detection) + Part B (tracker state refresh), SPEC 8.5. */
  private async reconcileRunning(snapshot: ServiceSnapshot): Promise<void> {
    const config = snapshot.config;
    const now = Date.now();

    if (config.codex.stall_timeout_ms > 0) {
      for (const entry of [...this.state.running.values()]) {
        if (entry.cancel_reason !== null) continue;
        const lastEvent = entry.session.last_codex_timestamp === null ? null : Date.parse(entry.session.last_codex_timestamp);
        const since = lastEvent !== null && Number.isFinite(lastEvent) ? lastEvent : entry.started_at_ms;
        const elapsed = now - since;
        if (elapsed <= config.codex.stall_timeout_ms) continue;
        this.logger.warn('session stalled; terminating and retrying', {
          issue_id: entry.issue.id,
          issue_identifier: entry.identifier,
          session_id: entry.session.session_id,
          elapsed_ms: elapsed,
          stall_timeout_ms: config.codex.stall_timeout_ms,
        });
        entry.cancel_reason = 'stalled';
        entry.canceled_at_ms = now;
        entry.phase = 'Stalled';
        entry.abort.abort();
        this.scheduleRetry(
          entry.issue.id,
          (entry.attempt ?? 0) + 1,
          {
            identifier: entry.identifier,
            error: `stalled: no agent activity for ${elapsed}ms`,
            continuation: false,
          },
          config,
        );
      }
    }

    // Reclaim slots for canceled workers that never reported an exit.
    for (const entry of [...this.state.running.values()]) {
      if (entry.cancel_reason === null || entry.canceled_at_ms === null) continue;
      if (Date.now() - entry.canceled_at_ms < CANCELED_GRACE_MS) continue;
      this.state.running.delete(entry.issue.id);
      this.state.codex_totals.seconds_running += (Date.now() - entry.started_at_ms) / 1000;
      if (entry.cancel_reason !== 'stalled') this.releaseClaim(entry.issue.id);
    }

    const ids = [...this.state.running.entries()]
      .filter(([, entry]) => entry.cancel_reason === null)
      .map(([id]) => id);
    if (ids.length === 0) return;

    const refreshed = await snapshot.tracker.fetchIssuesByIds(ids);
    if (!refreshed.ok) {
      this.logger.warn('reconciliation state refresh failed; keeping workers running', {
        category: refreshed.error.category,
        error: refreshed.error.message,
      });
      return;
    }

    const byId = new Map(refreshed.value.map((issue) => [issue.id, issue] as const));
    for (const id of ids) {
      const entry = this.state.running.get(id);
      if (entry === undefined) continue;
      const issue = byId.get(id);
      if (issue === undefined) {
        // Omitted IDs are "no longer visible", not a synthetic state.
        this.logger.info('running issue no longer visible; terminating', {
          issue_id: entry.issue.id,
          issue_identifier: entry.identifier,
        });
        this.terminate(entry, { cleanup_workspace: false, reason: 'not_active' }, snapshot);
        continue;
      }
      if (isTerminalState(issue, config)) {
        this.logger.info('issue reached a terminal state; terminating and cleaning workspace', {
          issue_id: entry.issue.id,
          issue_identifier: entry.identifier,
          state: issue.state,
        });
        this.terminate(entry, { cleanup_workspace: true, reason: 'terminal' }, snapshot);
        continue;
      }
      if (isActiveState(issue, config) && isRoutable(issue, config)) {
        entry.issue = issue;
        continue;
      }
      this.logger.info('issue is no longer active or routable; terminating', {
        issue_id: entry.issue.id,
        issue_identifier: entry.identifier,
        state: issue.state,
      });
      this.terminate(entry, { cleanup_workspace: false, reason: 'not_active' }, snapshot);
    }
  }

  private terminate(
    entry: RunningEntry,
    options: { cleanup_workspace: boolean; reason: CancelReason },
    snapshot: ServiceSnapshot,
  ): void {
    if (entry.cancel_reason === null) {
      entry.cancel_reason = options.reason;
      entry.canceled_at_ms = Date.now();
      entry.phase = 'CanceledByReconciliation';
      entry.abort.abort();
    }
    if (options.cleanup_workspace) {
      void this.cleanupWorkspace(snapshot, entry.identifier);
    }
    if (options.reason === 'terminal' || options.reason === 'not_active') {
      this.releaseClaim(entry.issue.id);
      this.recordRelease(entry.issue.id, `released: ${options.reason}`);
    }
  }

  /** Startup sweep of workspaces whose issues are already terminal (SPEC 8.6). */
  private async startupTerminalCleanup(snapshot: ServiceSnapshot): Promise<void> {
    const states = snapshot.config.tracker.terminal_states;
    if (states.length === 0) return;
    const result = await snapshot.tracker.fetchIssuesByStates(states);
    if (!result.ok) {
      this.logger.warn('startup terminal cleanup fetch failed; continuing', {
        category: result.error.category,
        error: result.error.message,
      });
      return;
    }
    let removed = 0;
    for (const issue of result.value) {
      try {
        await snapshot.workspace.remove(issue.identifier);
        removed += 1;
      } catch (error) {
        this.logger.warn('startup workspace cleanup failed', {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          error: describeError(error),
        });
      }
    }
    this.logger.info('startup terminal cleanup completed', {
      terminal_issues: result.value.length,
      workspaces_removed: removed,
    });
  }

  private async cleanupWorkspace(snapshot: ServiceSnapshot, identifier: string): Promise<void> {
    try {
      await snapshot.workspace.remove(identifier);
      this.logger.info('workspace removed', { issue_identifier: identifier });
    } catch (error) {
      this.logger.warn('workspace cleanup failed', {
        issue_identifier: identifier,
        error: describeError(error),
      });
    }
  }

  /* --------------------------------------------------------------- dispatch */

  private validateDispatch(snapshot: ServiceSnapshot): ValidationProblem[] {
    const problems: ValidationProblem[] = [];
    const config = snapshot.config;
    if (config.tracker.kind.trim() === '') {
      problems.push({ code: 'missing_tracker_kind', message: 'tracker.kind is required for dispatch' });
    } else if (!isSupportedTrackerKind(config.tracker.kind)) {
      problems.push({
        code: 'unsupported_tracker_kind',
        message: `tracker.kind ${JSON.stringify(config.tracker.kind)} is not supported`,
      });
    }
    const command = config.harness.kind === 'dsh' ? config.harness.command : config.codex.command;
    if (command.trim() === '') {
      problems.push({ code: 'missing_agent_command', message: 'the coding-agent command must not be empty' });
    }
    if (config.tracker.active_states.length === 0) {
      problems.push({ code: 'missing_active_states', message: 'tracker.active_states must not be empty' });
    }
    if (config.tracker.terminal_states.length === 0) {
      problems.push({ code: 'missing_terminal_states', message: 'tracker.terminal_states must not be empty' });
    }
    return problems;
  }

  private reportValidation(problems: ValidationProblem[]): void {
    this.lastError = problems.map((problem) => `${problem.code}: ${problem.message}`).join('; ');
    this.logger.error('dispatch validation failed; skipping dispatch for this tick', {
      problems: problems.map((problem) => problem.code).join(','),
      detail: this.lastError,
    });
  }

  /** Full dispatch eligibility (SPEC 8.2). */
  private shouldDispatch(issue: Issue, config: ServiceConfig, ignoreClaimFor: string | null): boolean {
    if (!hasRequiredIdentity(issue)) return false;
    if (this.state.running.has(issue.id)) return false;
    if (issue.id !== ignoreClaimFor && this.state.claimed.has(issue.id)) return false;
    if (!isActiveState(issue, config)) return false;
    if (isTerminalState(issue, config)) return false;
    if (!isRoutable(issue, config)) return false;
    return true;
  }

  private dispatchIssue(issue: Issue, snapshot: ServiceSnapshot, attempt: number | null): void {
    this.clearRetry(issue.id);
    const entry: RunningEntry = {
      issue,
      identifier: issue.identifier,
      attempt,
      started_at_ms: Date.now(),
      workspace_path: null,
      session: emptyLiveSession(),
      phase: 'PreparingWorkspace',
      last_error: null,
      recent_events: [],
      cancel_reason: null,
      canceled_at_ms: null,
      abort: new AbortController(),
    };
    this.state.running.set(issue.id, entry);
    this.state.claimed.add(issue.id);

    const logger = this.logger.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    logger.info('dispatching issue', {
      attempt: attempt,
      state: issue.state,
      priority: issue.priority,
      retry: attempt !== null,
    });
    this.history.set(issue.id, {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      issue_url: issue.url,
      status: 'running',
      workspace_path: null,
      last_error: null,
      last_event_at: null,
      restart_count: attempt ?? 0,
      recent_events: [],
      updated_at_ms: Date.now(),
    });
    this.trimHistory();

    const promise = this.runWorker(entry, snapshot, logger).catch((error: unknown) => {
      logger.error('worker crashed', { error: describeError(error) });
    });
    this.workers.add(promise);
    void promise.finally(() => {
      this.workers.delete(promise);
    });
    this.notify();
  }

  private createRunner(snapshot: ServiceSnapshot): AgentRunner {
    return new AgentRunner({
      config: snapshot.config,
      promptTemplate: snapshot.prompt_template,
      tracker: snapshot.tracker,
      workspace: snapshot.workspace,
      backend: snapshot.backend,
      logger: this.logger,
      bridge: snapshot.bridge,
      parentEnv: snapshot.env,
    });
  }

  private async runWorker(entry: RunningEntry, snapshot: ServiceSnapshot, logger: Logger): Promise<void> {
    const runner = this.createRunner(snapshot);
    const callbacks = this.buildCallbacks(entry, logger);
    let result: AttemptResult;
    try {
      result = await runner.run(entry.issue, entry.attempt, entry.abort.signal, callbacks);
    } catch (error) {
      result = {
        outcome: { kind: 'failed', error: describeError(error), reason: 'worker_error' },
        workspace_path: entry.workspace_path,
        turns: entry.session.turn_count,
        final_text: null,
      };
    }
    if (result.workspace_path !== null) entry.workspace_path = result.workspace_path;
    entry.session.turn_count = Math.max(entry.session.turn_count, result.turns);
    const seconds = (Date.now() - entry.started_at_ms) / 1000;
    this.onWorkerExit(entry, result.outcome, logger, seconds);
  }

  private buildCallbacks(entry: RunningEntry, logger: Logger): AttemptCallbacks {
    return {
      onPhase: (phase: RunAttemptPhase) => {
        entry.phase = phase;
        logger.debug('run attempt phase', { phase, attempt: entry.attempt ?? 1 });
      },
      onWorkspace: (path: string) => {
        entry.workspace_path = path;
        const history = this.history.get(entry.issue.id);
        if (history !== undefined) history.workspace_path = path;
      },
      onTurnStart: (turn: number, maxTurns: number) => {
        entry.session.turn_count = turn;
        logger.info('agent turn started', {
          session_id: entry.session.session_id,
          turn,
          max_turns: maxTurns,
        });
      },
      onAgentEvent: (event: AgentEvent) => this.recordAgentEvent(entry, event, logger),
      onSessionUpdate: (update: Partial<LiveSession>) => {
        Object.assign(entry.session, update);
      },
      onIssueRefreshed: (issue: Issue) => {
        entry.issue = issue;
        logger.debug('issue snapshot refreshed between turns', { state: issue.state });
      },
      onLog: (message: string, context?: Record<string, unknown>) => {
        logger.info(message, context);
      },
    };
  }

  /** Update live session metrics, token totals and rate limits from an event. */
  private recordAgentEvent(entry: RunningEntry, event: AgentEvent, logger: Logger): void {
    const session = entry.session;
    session.last_codex_event = event.event;
    session.last_codex_timestamp = event.timestamp;
    session.last_codex_message = event.message === null ? null : event.message.slice(0, 500);
    if (event.codex_app_server_pid !== null) session.codex_app_server_pid = event.codex_app_server_pid;
    if (event.thread_id !== null) session.thread_id = event.thread_id;
    if (event.turn_id !== null) session.turn_id = event.turn_id;
    if (session.thread_id !== null && session.turn_id !== null) {
      session.session_id = `${session.thread_id}-${session.turn_id}`;
    }

    if (event.usage !== null) {
      const usage = event.usage;
      if (usage.absolute) {
        const deltaInput = Math.max(0, usage.input_tokens - session.last_reported_input_tokens);
        const deltaOutput = Math.max(0, usage.output_tokens - session.last_reported_output_tokens);
        const deltaTotal = Math.max(0, usage.total_tokens - session.last_reported_total_tokens);
        session.codex_input_tokens += deltaInput;
        session.codex_output_tokens += deltaOutput;
        session.codex_total_tokens += deltaTotal;
        this.state.codex_totals.input_tokens += deltaInput;
        this.state.codex_totals.output_tokens += deltaOutput;
        this.state.codex_totals.total_tokens += deltaTotal;
        session.last_reported_input_tokens = usage.input_tokens;
        session.last_reported_output_tokens = usage.output_tokens;
        session.last_reported_total_tokens = usage.total_tokens;
      } else {
        session.codex_input_tokens += usage.input_tokens;
        session.codex_output_tokens += usage.output_tokens;
        session.codex_total_tokens += usage.total_tokens;
        this.state.codex_totals.input_tokens += usage.input_tokens;
        this.state.codex_totals.output_tokens += usage.output_tokens;
        this.state.codex_totals.total_tokens += usage.total_tokens;
        session.last_reported_input_tokens = session.codex_input_tokens;
        session.last_reported_output_tokens = session.codex_output_tokens;
        session.last_reported_total_tokens = session.codex_total_tokens;
      }
    }
    if (event.rate_limits !== null && event.rate_limits !== undefined) {
      this.state.codex_rate_limits = event.rate_limits;
    }

    this.pushRecentEvent(entry, { at: event.timestamp, event: event.event, message: event.message ?? '' });
    const level = event.event === 'malformed' || event.event === 'turn_ended_with_error' ? 'warn' : 'debug';
    logger[level](summarizeEvent(event), { session_id: session.session_id, event: event.event });
  }

  private pushRecentEvent(entry: RunningEntry, event: RecentEvent): void {
    entry.recent_events.push(event);
    if (entry.recent_events.length > MAX_RECENT_EVENTS) entry.recent_events.shift();
    const history = this.history.get(entry.issue.id);
    if (history !== undefined) {
      history.recent_events.push(event);
      if (history.recent_events.length > MAX_RECENT_EVENTS) history.recent_events.shift();
      history.last_event_at = event.at;
      history.updated_at_ms = Date.now();
    }
  }

  /* ------------------------------------------------------------ exits/retry */

  private onWorkerExit(entry: RunningEntry, outcome: WorkerOutcome, logger: Logger, seconds: number): void {
    const id = entry.issue.id;
    if (this.state.running.get(id) !== entry) return;
    this.state.running.delete(id);
    this.state.codex_totals.seconds_running += seconds;

    const history = this.history.get(id);
    if (history !== undefined) {
      history.updated_at_ms = Date.now();
      history.workspace_path = entry.workspace_path;
    }

    const config = this.options.getSnapshot().config;
    if (entry.cancel_reason !== null) {
      if (entry.cancel_reason === 'stalled') {
        logger.info('worker canceled after stall; retry already queued', {
          session_id: entry.session.session_id,
          seconds: Math.round(seconds * 10) / 10,
        });
      } else {
        this.releaseClaim(id);
        this.recordRelease(id, `released: ${entry.cancel_reason}`);
        logger.info('worker canceled by reconciliation', {
          session_id: entry.session.session_id,
          reason: entry.cancel_reason,
        });
      }
      this.notify();
      return;
    }

    if (outcome.kind === 'normal') {
      this.state.completed.add(id);
      if (history !== undefined) history.status = 'completed';
      logger.info('worker exited normally; scheduling continuation retry', {
        session_id: entry.session.session_id,
        turns: entry.session.turn_count,
        seconds: Math.round(seconds * 10) / 10,
      });
      this.scheduleRetry(id, 1, { identifier: entry.identifier, error: null, continuation: true }, config);
    } else if (outcome.kind === 'failed') {
      const nextAttempt = (entry.attempt ?? 0) + 1;
      if (history !== undefined) {
        history.status = 'retrying';
        history.last_error = outcome.error;
      }
      logger.warn('worker failed; scheduling retry', {
        session_id: entry.session.session_id,
        reason: outcome.reason,
        error: outcome.error,
        attempt: nextAttempt,
      });
      this.scheduleRetry(id, nextAttempt, { identifier: entry.identifier, error: outcome.error, continuation: false }, config);
    } else {
      this.releaseClaim(id);
      this.recordRelease(id, 'released: canceled');
      logger.info('worker reported cancellation', { session_id: entry.session.session_id });
    }
    this.notify();
  }

  /** Queue a retry, replacing any existing timer for the issue (SPEC 8.4). */
  private scheduleRetry(
    issueId: string,
    attempt: number,
    options: { identifier: string; error: string | null; continuation: boolean },
    config: ServiceConfig,
  ): void {
    this.clearRetry(issueId);
    const normalizedAttempt = Math.max(1, Math.trunc(attempt));
    const delay = options.continuation
      ? CONTINUATION_RETRY_DELAY_MS
      : Math.min(BASE_RETRY_DELAY_MS * 2 ** (normalizedAttempt - 1), config.agent.max_retry_backoff_ms);
    const dueAt = Date.now() + delay;
    const entry: RetryEntry = {
      issue_id: issueId,
      identifier: options.identifier,
      attempt: normalizedAttempt,
      due_at_ms: dueAt,
      error: options.error,
      continuation: options.continuation,
    };
    this.state.retry_attempts.set(issueId, entry);
    this.state.claimed.add(issueId);
    this.logger.info('retry scheduled', {
      issue_id: issueId,
      issue_identifier: options.identifier,
      attempt: normalizedAttempt,
      delay_ms: delay,
      due_at: isoTimestamp(dueAt),
      error: options.error,
    });
    const history = this.history.get(issueId);
    if (history !== undefined) {
      history.status = 'retrying';
      history.last_error = options.error;
      history.restart_count = Math.max(history.restart_count, normalizedAttempt);
    }
    if (this.options.autoTimers === false || this.stopping) return;
    const timer = setTimeout(() => {
      void this.fireRetry(issueId);
    }, delay);
    timer.unref();
    this.retryTimers.set(issueId, timer);
    this.notify();
  }

  /** Fire a queued retry now (the timer callback, and the test entry point). */
  async fireRetry(issueId: string): Promise<void> {
    const retry = this.state.retry_attempts.get(issueId);
    if (retry === undefined) return;
    this.state.retry_attempts.delete(issueId);
    const timer = this.retryTimers.get(issueId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.retryTimers.delete(issueId);
    }
    if (this.stopping) return;
    if (this.state.running.has(issueId)) return;

    const snapshot = this.options.getSnapshot();
    const config = snapshot.config;
    const logger = this.logger.child({ issue_id: issueId, issue_identifier: retry.identifier });
    logger.info('retry timer fired', { attempt: retry.attempt });

    const refreshed = await snapshot.tracker.fetchIssuesByIds([issueId]);
    if (!refreshed.ok) {
      logger.warn('retry refresh failed; requeueing', {
        category: refreshed.error.category,
        error: refreshed.error.message,
      });
      this.scheduleRetry(issueId, retry.attempt + 1, {
        identifier: retry.identifier,
        error: 'retry refresh failed',
        continuation: false,
      }, config);
      return;
    }
    const issue = refreshed.value[0];
    if (issue === undefined) {
      this.releaseClaim(issueId);
      this.recordRelease(issueId, 'released: issue no longer visible');
      logger.info('retry released: issue no longer visible');
      return;
    }
    if (isTerminalState(issue, config)) {
      await this.cleanupWorkspace(snapshot, issue.identifier);
      this.releaseClaim(issueId);
      this.recordRelease(issueId, 'released: terminal');
      logger.info('retry released: issue is terminal', { state: issue.state });
      return;
    }
    if (!isActiveState(issue, config) || !isRoutable(issue, config)) {
      this.releaseClaim(issueId);
      this.recordRelease(issueId, 'released: not active or not routable');
      logger.info('retry released: issue is not active or not routable', { state: issue.state });
      return;
    }
    if (globalConcurrency(config, this.state.running.size) <= 0 || !hasStateSlot(config, this.state.running, issue.state)) {
      logger.info('retry requeued: no available orchestrator slots');
      this.scheduleRetry(issueId, retry.attempt + 1, {
        identifier: issue.identifier,
        error: 'no available orchestrator slots',
        continuation: false,
      }, config);
      return;
    }
    this.dispatchIssue(issue, snapshot, retry.attempt);
  }

  private clearRetry(issueId: string): void {
    const timer = this.retryTimers.get(issueId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.retryTimers.delete(issueId);
    }
    this.state.retry_attempts.delete(issueId);
  }

  private releaseClaim(issueId: string): void {
    this.clearRetry(issueId);
    this.state.claimed.delete(issueId);
  }

  private recordRelease(issueId: string, reason: string): void {
    const history = this.history.get(issueId);
    if (history === undefined) return;
    history.status = 'released';
    history.last_error = reason;
    history.updated_at_ms = Date.now();
  }

  /* ------------------------------------------------------------- snapshots */

  /** Synchronous runtime snapshot for dashboards and monitoring (SPEC 13.3). */
  snapshot(): RuntimeSnapshot {
    const now = Date.now();
    const running: SnapshotRunningRow[] = [...this.state.running.values()].map((entry) => ({
      issue_id: entry.issue.id,
      issue_identifier: entry.identifier,
      issue_url: entry.issue.url,
      state: entry.issue.state,
      session_id: entry.session.session_id,
      turn_count: entry.session.turn_count,
      last_event: entry.session.last_codex_event,
      last_message: entry.session.last_codex_message,
      started_at: isoTimestamp(entry.started_at_ms),
      last_event_at: entry.session.last_codex_timestamp,
      tokens: {
        input_tokens: entry.session.codex_input_tokens,
        output_tokens: entry.session.codex_output_tokens,
        total_tokens: entry.session.codex_total_tokens,
      },
      attempt: entry.attempt,
      workspace_path: entry.workspace_path,
      phase: entry.phase,
    }));

    const retrying: SnapshotRetryRow[] = [...this.state.retry_attempts.values()].map((retry) => {
      const history = this.history.get(retry.issue_id);
      return {
        issue_id: retry.issue_id,
        issue_identifier: retry.identifier,
        issue_url: history?.issue_url ?? null,
        attempt: retry.attempt,
        due_at: isoTimestamp(retry.due_at_ms),
        error: retry.error,
        continuation: retry.continuation,
      };
    });

    let liveSeconds = 0;
    for (const entry of this.state.running.values()) liveSeconds += (now - entry.started_at_ms) / 1000;

    return {
      generated_at: isoTimestamp(now),
      counts: { running: running.length, retrying: retrying.length },
      running,
      retrying,
      codex_totals: {
        ...this.state.codex_totals,
        seconds_running: Math.round((this.state.codex_totals.seconds_running + liveSeconds) * 100) / 100,
      },
      rate_limits: this.state.codex_rate_limits,
      poll_interval_ms: this.state.poll_interval_ms,
      max_concurrent_agents: this.state.max_concurrent_agents,
      completed_count: this.state.completed.size,
      last_tick_at: this.lastTickAt,
      last_error: this.lastError,
    };
  }

  /** Debug detail for one issue identifier, or null when unknown. */
  issueDetail(identifier: string): IssueDetail | null {
    const wanted = identifier.trim();
    if (wanted === '') return null;
    const runningEntry = [...this.state.running.values()].find((entry) => entry.identifier === wanted);
    if (runningEntry !== undefined) {
      return {
        issue_identifier: runningEntry.identifier,
        issue_id: runningEntry.issue.id,
        status: 'running',
        workspace: { path: runningEntry.workspace_path },
        attempts: {
          restart_count: this.history.get(runningEntry.issue.id)?.restart_count ?? runningEntry.attempt ?? 0,
          current_retry_attempt: null,
        },
        running: {
          session_id: runningEntry.session.session_id,
          turn_count: runningEntry.session.turn_count,
          state: runningEntry.issue.state,
          started_at: isoTimestamp(runningEntry.started_at_ms),
          last_event: runningEntry.session.last_codex_event,
          last_message: runningEntry.session.last_codex_message,
          last_event_at: runningEntry.session.last_codex_timestamp,
          tokens: {
            input_tokens: runningEntry.session.codex_input_tokens,
            output_tokens: runningEntry.session.codex_output_tokens,
            total_tokens: runningEntry.session.codex_total_tokens,
          },
        },
        retry: null,
        logs: { codex_session_logs: [] },
        recent_events: [...runningEntry.recent_events],
        last_error: runningEntry.last_error,
        tracked: { phase: runningEntry.phase, attempt: runningEntry.attempt },
      };
    }

    const retry = [...this.state.retry_attempts.values()].find((entry) => entry.identifier === wanted);
    if (retry !== undefined) {
      const history = this.history.get(retry.issue_id);
      return {
        issue_identifier: retry.identifier,
        issue_id: retry.issue_id,
        status: 'retrying',
        workspace: { path: history?.workspace_path ?? null },
        attempts: { restart_count: history?.restart_count ?? retry.attempt, current_retry_attempt: retry.attempt },
        running: null,
        retry: { attempt: retry.attempt, due_at: isoTimestamp(retry.due_at_ms), error: retry.error },
        logs: { codex_session_logs: [] },
        recent_events: history?.recent_events ?? [],
        last_error: retry.error,
        tracked: { continuation: retry.continuation },
      };
    }

    for (const history of this.history.values()) {
      if (history.issue_identifier !== wanted) continue;
      return {
        issue_identifier: history.issue_identifier,
        issue_id: history.issue_id,
        status: history.status,
        workspace: { path: history.workspace_path },
        attempts: { restart_count: history.restart_count, current_retry_attempt: null },
        running: null,
        retry: null,
        logs: { codex_session_logs: [] },
        recent_events: history.recent_events,
        last_error: history.last_error,
        tracked: {},
      };
    }
    return null;
  }

  /** Direct access to the authoritative state, for tests and the status view. */
  getState(): OrchestratorState {
    return this.state;
  }

  /** Await all in-flight workers (tests and graceful shutdown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.workers]);
  }

  private trimHistory(): void {
    if (this.history.size <= MAX_HISTORY) return;
    const entries = [...this.history.entries()].sort((a, b) => a[1].updated_at_ms - b[1].updated_at_ms);
    for (const [id] of entries.slice(0, this.history.size - MAX_HISTORY)) {
      this.history.delete(id);
    }
  }
}
