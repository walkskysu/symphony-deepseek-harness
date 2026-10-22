/**
 * Operator-facing runtime snapshot (SPEC 13.3) and per-issue debug detail.
 */

export interface SnapshotTokens {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface SnapshotRunningRow {
  issue_id: string;
  issue_identifier: string;
  issue_url: string | null;
  state: string;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  last_event_at: string | null;
  tokens: SnapshotTokens;
  attempt: number | null;
  workspace_path: string | null;
  phase: string;
}

export interface SnapshotRetryRow {
  issue_id: string;
  issue_identifier: string;
  issue_url: string | null;
  attempt: number;
  due_at: string;
  error: string | null;
  continuation: boolean;
}

export interface SnapshotTotals extends SnapshotTokens {
  /** Aggregate runtime seconds including currently active sessions. */
  seconds_running: number;
}

export interface RuntimeSnapshot {
  generated_at: string;
  counts: { running: number; retrying: number };
  running: SnapshotRunningRow[];
  retrying: SnapshotRetryRow[];
  codex_totals: SnapshotTotals;
  rate_limits: unknown | null;
  poll_interval_ms: number;
  max_concurrent_agents: number;
  completed_count: number;
  last_tick_at: string | null;
  last_error: string | null;
}

export interface RecentEventRow {
  at: string;
  event: string;
  message: string;
}

export interface IssueDetail {
  issue_identifier: string;
  issue_id: string;
  status: 'running' | 'retrying' | 'completed' | 'released' | 'unknown';
  workspace: { path: string | null };
  attempts: { restart_count: number; current_retry_attempt: number | null };
  running: {
    session_id: string | null;
    turn_count: number;
    state: string;
    started_at: string;
    last_event: string | null;
    last_message: string | null;
    last_event_at: string | null;
    tokens: SnapshotTokens;
  } | null;
  retry: {
    attempt: number;
    due_at: string;
    error: string | null;
  } | null;
  logs: { codex_session_logs: Array<{ label: string; path: string; url: string | null }> };
  recent_events: RecentEventRow[];
  last_error: string | null;
  tracked: Record<string, unknown>;
}
