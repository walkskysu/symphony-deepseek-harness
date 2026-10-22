/**
 * Core domain model of the Symphony service (SPEC.md section 4).
 *
 * The orchestrator only ever sees these normalized types. Provider payloads,
 * provider state spelling and provider identity quirks stay inside adapters.
 */

/** A best-effort reference to another work item that blocks this one. */
export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

/**
 * Normalized schedulable work item (SPEC 4.1.1).
 *
 * Every field is required to be present; nullable fields use `null` and
 * collection fields use `[]` so consumers never have to distinguish "absent"
 * from "empty".
 */
export interface Issue {
  /** Opaque, stable dispatch identity within the configured tracker scope. */
  id: string;
  /** Non-secret provider identifiers for provider-native tools. Opaque here. */
  native_ref: Record<string, unknown> | null;
  /** Human-readable key, unique within the tracker scope (names workspaces). */
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  /** Provider-native state name; compared case-insensitively by the scheduler. */
  state: string;
  branch_name: string | null;
  url: string | null;
  assignee_id: string | null;
  /** Lowercased, trimmed, de-duplicated labels. */
  labels: string[];
  blocked_by: BlockerRef[];
  /** Explicit adapter-derived eligibility; never reconstructed by the scheduler. */
  dispatchable: boolean;
  /** RFC 3339 instant or null. */
  created_at: string | null;
  /** RFC 3339 instant or null. */
  updated_at: string | null;
}

/** Parsed `WORKFLOW.md` payload: raw front matter plus prompt body. */
export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
}

/** A filesystem workspace assigned to one issue identifier (SPEC 4.1.4). */
export interface Workspace {
  path: string;
  workspace_key: string;
  created_now: boolean;
}

/** Phases of one run attempt (SPEC 7.2). */
export type RunAttemptPhase =
  | 'PreparingWorkspace'
  | 'BuildingPrompt'
  | 'LaunchingAgentProcess'
  | 'InitializingSession'
  | 'StreamingTurn'
  | 'Finishing'
  | 'Succeeded'
  | 'Failed'
  | 'TimedOut'
  | 'Stalled'
  | 'CanceledByReconciliation';

/** Terminal reasons a worker outcome can carry. */
export type WorkerOutcome =
  | { kind: 'normal' }
  | { kind: 'failed'; error: string; reason: FailureKind }
  | { kind: 'canceled'; reason: string };

export type FailureKind =
  | 'codex_not_found'
  | 'invalid_workspace_cwd'
  | 'response_timeout'
  | 'turn_timeout'
  | 'port_exit'
  | 'response_error'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_input_required'
  | 'workspace_error'
  | 'hook_error'
  | 'prompt_error'
  | 'tracker_error'
  | 'worker_error';

/**
 * Live coding-agent session metadata tracked while a worker runs (SPEC 4.1.6).
 *
 * The `codex_*` field names are normative in the specification, so they are
 * kept verbatim even though this implementation also drives non-Codex agents.
 */
export interface LiveSession {
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  codex_app_server_pid: string | null;
  last_codex_event: string | null;
  last_codex_timestamp: string | null;
  last_codex_message: string | null;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  /** Number of coding-agent turns started within the current worker lifetime. */
  turn_count: number;
}

/** One entry of a run's event ring buffer, for operator debugging. */
export interface RecentEvent {
  at: string;
  event: string;
  message: string;
}

/** Scheduled retry state for one issue (SPEC 4.1.7). */
export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  error: string | null;
  /** Continuation retries are the short fixed-delay ones after a clean exit. */
  continuation: boolean;
}

/** A running worker as tracked by the orchestrator. */
export interface RunningEntry {
  issue: Issue;
  identifier: string;
  attempt: number | null;
  started_at_ms: number;
  workspace_path: string | null;
  session: LiveSession;
  phase: RunAttemptPhase;
  last_error: string | null;
  recent_events: RecentEvent[];
  /** Set by reconciliation/shutdown so a later worker exit does not retry again. */
  cancel_reason: CancelReason | null;
  /** When the cancellation was requested, for slot reclamation. */
  canceled_at_ms: number | null;
  abort: AbortController;
}

export type CancelReason = 'terminal' | 'not_active' | 'stalled' | 'shutdown' | 'released';

/** Live token/rate-limit accounting shared across sessions. */
export interface CodexTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /**
   * Cumulative seconds of *ended* sessions. Snapshots add the live elapsed
   * time of currently running sessions on top of this value.
   */
  seconds_running: number;
}

/** Single authoritative in-memory orchestrator state (SPEC 4.1.8). */
export interface OrchestratorState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  completed: Set<string>;
  codex_totals: CodexTotals;
  codex_rate_limits: unknown | null;
}

/** Why an issue was considered released rather than dispatched. */
export type ReleaseReason = 'terminal' | 'not_active' | 'missing' | 'not_routable' | 'shutdown';
