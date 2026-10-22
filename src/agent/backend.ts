/**
 * The coding-agent backend contract (SPEC 10.2, 10.7).
 *
 * A backend owns one live agent thread. In-worker continuation turns reuse the
 * same backend session so the agent keeps its thread history, which is why the
 * runner asks the session to `runTurn` more than once.
 */
import type { Issue, FailureKind } from '../domain/types.js';
import type { AgentEvent } from './events.js';

export interface AgentTurnOptions {
  prompt: string;
  /** `<identifier>: <title>` when the protocol supports turn/session titles. */
  title: string;
  onEvent: (event: AgentEvent) => void;
  signal: AbortSignal;
}

export interface AgentTurnResult {
  ok: boolean;
  error: { category: FailureKind; message: string } | null;
  session_id: string | null;
  turn_id: string | null;
  /** Final assistant text when the backend reports one. */
  final_text: string | null;
}

export interface AgentSessionStart {
  workspacePath: string;
  issue: Issue;
  attempt: number | null;
  /** Child environment, already stripped of tracker credentials. */
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

export interface AgentSession {
  /** Thread identity, known after the session starts (or after turn 1). */
  readonly threadId: string | null;
  /** OS pid of the live agent process, when one is currently running. */
  readonly pid: string | null;
  runTurn(options: AgentTurnOptions): Promise<AgentTurnResult>;
  stop(): Promise<void>;
}

export interface AgentBackend {
  readonly kind: string;
  /** Default turn title used when the protocol supports it. */
  sessionTitle(issue: Issue): string;
  startSession(start: AgentSessionStart): Promise<AgentSession>;
}
