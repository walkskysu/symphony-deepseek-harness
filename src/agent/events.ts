/**
 * Normalized runtime events emitted by an agent backend (SPEC 10.4).
 *
 * Event names follow the specification's vocabulary; the orchestrator only
 * depends on the subset it needs for accounting and observability.
 */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /**
   * `true` when the payload is an absolute thread/progress total that must be
   * diffed against the last reported value; `false` for delta accounting.
   */
  absolute: boolean;
}

export type AgentEventName =
  | 'session_started'
  | 'startup_failed'
  | 'turn_started'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_ended_with_error'
  | 'turn_input_required'
  | 'approval_auto_approved'
  | 'unsupported_tool_call'
  | 'notification'
  | 'other_message'
  | 'malformed';

export interface AgentEvent {
  event: AgentEventName;
  /** UTC timestamp. */
  timestamp: string;
  codex_app_server_pid: string | null;
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  /** Short human-readable summary; never a raw payload dump. */
  message: string | null;
  usage: TokenUsage | null;
  rate_limits: unknown | null;
  /** Small structured payload for observability only. */
  payload: Record<string, unknown> | null;
}

export interface AgentEventInit {
  event: AgentEventName;
  session_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  message?: string | null;
  usage?: TokenUsage | null;
  rate_limits?: unknown | null;
  payload?: Record<string, unknown> | null;
  pid?: string | null;
}

/** Compose a session id from thread and turn identity (SPEC 4.2). */
export function composeSessionId(threadId: string | null, turnId: string | null): string | null {
  if (threadId === null || turnId === null) return null;
  return `${threadId}-${turnId}`;
}

/** Build an event with a UTC timestamp and the current pid attached. */
export function makeAgentEvent(init: AgentEventInit, pid: string | null = null): AgentEvent {
  return {
    event: init.event,
    timestamp: new Date().toISOString(),
    codex_app_server_pid: init.pid ?? pid,
    session_id: init.session_id ?? null,
    thread_id: init.thread_id ?? null,
    turn_id: init.turn_id ?? null,
    message: init.message ?? null,
    usage: init.usage ?? null,
    rate_limits: init.rate_limits ?? null,
    payload: init.payload ?? null,
  };
}

/** Render an event as one structured log message (key=value phrasing). */
export function summarizeEvent(event: AgentEvent): string {
  const parts: string[] = [`event=${event.event}`];
  if (event.message !== null && event.message !== '') parts.push(`summary=${JSON.stringify(truncate(event.message, 160))}`);
  if (event.usage !== null) {
    parts.push(
      `input=${event.usage.input_tokens}`,
      `output=${event.usage.output_tokens}`,
      `total=${event.usage.total_tokens}`,
    );
  }
  return parts.join(' ');
}

function truncate(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max)}…`;
}
