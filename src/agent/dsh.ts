/**
 * DeepSeek Harness CLI backend.
 *
 * The DSH `headless` profile answers exactly one task per process and prints
 * its result, so a Symphony "thread" maps to a persisted DSH session id:
 *
 *   turn 1 : dsh --profile headless --json -            (prompt on stdin)
 *   turn n : dsh --profile headless --json --session-id <id> -
 *
 * The `--json` projection emits newline-delimited events
 * (`session`, `status`, `text`, `thinking`, `tool_call`, `tool_result`,
 * `final`, `error`), which are mapped onto Symphony's normalized event set.
 * Continuation turns therefore keep the same agent thread even though each turn
 * is a fresh process; the specification allows this because continuation turns
 * only need the same thread, not the same OS process.
 */
import type { Logger } from '../observability/logger.js';
import type { ServiceConfig } from '../config/config.js';
import { spawnProcess, type RunningProcess, type ShellSpec } from '../platform/shell.js';
import { planProgram, type ProgramPlan } from '../platform/launch.js';
import type { AgentBackend, AgentSession, AgentSessionStart, AgentTurnOptions, AgentTurnResult } from './backend.js';
import { composeSessionId, makeAgentEvent, type AgentEvent, type TokenUsage } from './events.js';

export interface DshBackendOptions {
  config: ServiceConfig;
  logger: Logger;
  /** Test seam: replace the process launch plan. */
  plan?: (args: string[], env: NodeJS.ProcessEnv) => ProgramPlan;
  shell?: ShellSpec;
}

const COMPLETED_REASONS = new Set(['completed', 'complete', 'done', 'success', 'succeeded', 'ok']);
const CANCELLED_REASONS = new Set(['aborted', 'cancelled', 'canceled', 'interrupted', 'stopped']);

interface DshJsonEvent {
  type?: unknown;
  [key: string]: unknown;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Map the DSH `step_end.usage` shape onto Symphony usage. */
export function usageFromDsh(value: unknown): TokenUsage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const input = toNumber(record['inputTokens']) ?? toNumber(record['input_tokens']);
  const output = toNumber(record['outputTokens']) ?? toNumber(record['output_tokens']);
  const total = toNumber(record['totalTokens']) ?? toNumber(record['total_tokens']);
  if (input === null && output === null && total === null) return null;
  return {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    total_tokens: total ?? (input ?? 0) + (output ?? 0),
    absolute: false,
  };
}

export class DshSession implements AgentSession {
  private readonly start: AgentSessionStart;
  private readonly options: DshBackendOptions;
  private thread: string | null = null;
  private activeProcess: RunningProcess | null = null;
  private currentPid: string | null = null;
  private started = false;

  constructor(start: AgentSessionStart, options: DshBackendOptions) {
    this.start = start;
    this.options = options;
  }

  get threadId(): string | null {
    return this.thread;
  }

  get pid(): string | null {
    return this.currentPid;
  }

  private buildArgs(): string[] {
    const config = this.options.config;
    const args: string[] = [];
    if (config.harness.profile !== '') args.push('--profile', config.harness.profile);
    args.push('--json');
    // The headless profile has no model flag: the model comes from the DSH
    // profile/settings, and `harness.args` is the escape hatch for extra flags.
    if (this.thread !== null) args.push('--session-id', this.thread);
    args.push('-');
    return args;
  }

  async runTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
    const config = this.options.config;
    const args = this.buildArgs();
    const plan =
      this.options.plan?.(args, this.start.env) ??
      planProgram(this.options.config.harness.command, [...config.harness.args, ...args]);

    let turnId: string | null = null;
    let turnReason: string | null = null;
    let errorMessage: string | null = null;
    let finalText: string | null = null;
    let malformed = 0;
    let sawLine = false;
    let silenceExpired = false;
    let watchdog: NodeJS.Timeout | null = null;

    const emit = (event: AgentEvent): void => {
      if (event.event === 'session_started') this.started = true;
      options.onEvent(event);
    };
    const clearWatchdog = (): void => {
      if (watchdog !== null) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };
    const armWatchdog = (timeoutMs: number): void => {
      clearWatchdog();
      watchdog = setTimeout(() => {
        silenceExpired = true;
        this.options.logger.warn('agent turn silence timeout', {
          timeout_ms: timeoutMs,
          hint: 'emitted=session',
        });
        this.activeProcess?.kill('turn silence timeout');
      }, timeoutMs);
      watchdog.unref();
    };

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === '') return;
      armWatchdog(config.codex.turn_timeout_ms);
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        malformed += 1;
        emit(
          makeAgentEvent(
            {
              event: 'malformed',
              message: trimmed.slice(0, 200),
              pid: this.currentPid,
            },
            this.currentPid,
          ),
        );
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) return;
      const event = parsed as DshJsonEvent;
      const type = typeof event['type'] === 'string' ? (event['type'] as string) : '';
      switch (type) {
        case 'session': {
          const sessionId = typeof event['sessionId'] === 'string' ? event['sessionId'] : null;
          if (sessionId !== null) this.thread = this.thread ?? sessionId;
          emit(
            makeAgentEvent(
              {
                event: 'session_started',
                thread_id: this.thread,
                session_id: composeSessionId(this.thread, null),
                message: 'session started',
                payload: { cwd: typeof event['cwd'] === 'string' ? event['cwd'] : null },
              },
              this.currentPid,
            ),
          );
          return;
        }
        case 'status': {
          const phase = typeof event['phase'] === 'string' ? event['phase'] : '';
          const turn = event['turn'];
          if (phase === 'turn_start') {
            if (typeof turn === 'number') turnId = String(turn);
            armWatchdog(config.codex.turn_timeout_ms);
            emit(
              makeAgentEvent(
                {
                  event: 'turn_started',
                  thread_id: this.thread,
                  turn_id: turnId,
                  session_id: composeSessionId(this.thread, turnId),
                  message: 'turn started',
                },
                this.currentPid,
              ),
            );
            return;
          }
          if (phase === 'step_end') {
            const usage = usageFromDsh(event['usage']);
            if (usage !== null) {
              emit(
                makeAgentEvent(
                  {
                    event: 'notification',
                    thread_id: this.thread,
                    turn_id: turnId,
                    session_id: composeSessionId(this.thread, turnId),
                    message: 'step usage',
                    usage,
                    payload: { phase },
                  },
                  this.currentPid,
                ),
              );
            }
            return;
          }
          if (phase === 'turn_end') {
            turnReason = typeof event['reason'] === 'string' ? event['reason'] : null;
            const cancelled = turnReason !== null && CANCELLED_REASONS.has(turnReason.toLowerCase());
            emit(
              makeAgentEvent(
                {
                  event: cancelled ? 'turn_cancelled' : 'turn_completed',
                  thread_id: this.thread,
                  turn_id: turnId,
                  session_id: composeSessionId(this.thread, turnId),
                  message: `turn ended reason=${turnReason ?? 'unknown'}`,
                },
                this.currentPid,
              ),
            );
            return;
          }
          emit(
            makeAgentEvent(
              {
                event: 'notification',
                thread_id: this.thread,
                turn_id: turnId,
                message: `phase=${phase}`,
                payload: { phase },
              },
              this.currentPid,
            ),
          );
          return;
        }
        case 'text': {
          const text = typeof event['text'] === 'string' ? event['text'] : '';
          if (text.trim() === '') return;
          emit(
            makeAgentEvent(
              {
                event: 'notification',
                thread_id: this.thread,
                turn_id: turnId,
                session_id: composeSessionId(this.thread, turnId),
                message: text,
                payload: { kind: 'assistant_text' },
              },
              this.currentPid,
            ),
          );
          return;
        }
        case 'thinking': {
          const text = typeof event['text'] === 'string' ? event['text'] : '';
          if (text.trim() === '') return;
          emit(
            makeAgentEvent(
              {
                event: 'notification',
                thread_id: this.thread,
                turn_id: turnId,
                message: text,
                payload: { kind: 'reasoning' },
              },
              this.currentPid,
            ),
          );
          return;
        }
        case 'tool_call': {
          const tool = typeof event['tool'] === 'string' ? event['tool'] : 'unknown';
          emit(
            makeAgentEvent(
              {
                event: 'notification',
                thread_id: this.thread,
                turn_id: turnId,
                message: `tool_call ${tool}`,
                payload: { tool, call_id: typeof event['callId'] === 'string' ? event['callId'] : null },
              },
              this.currentPid,
            ),
          );
          return;
        }
        case 'tool_result': {
          const status = typeof event['status'] === 'string' ? event['status'] : 'completed';
          emit(
            makeAgentEvent(
              {
                event: 'notification',
                thread_id: this.thread,
                turn_id: turnId,
                message: `tool_result ${status}`,
                payload: { status },
              },
              this.currentPid,
            ),
          );
          return;
        }
        case 'final': {
          finalText = typeof event['text'] === 'string' ? event['text'] : null;
          return;
        }
        case 'error': {
          errorMessage = typeof event['message'] === 'string' ? event['message'] : 'agent reported an error';
          emit(
            makeAgentEvent(
              {
                event: 'turn_ended_with_error',
                thread_id: this.thread,
                turn_id: turnId,
                message: errorMessage,
              },
              this.currentPid,
            ),
          );
          return;
        }
        default: {
          emit(
            makeAgentEvent(
              {
                event: 'other_message',
                thread_id: this.thread,
                turn_id: turnId,
                message: `unhandled event type=${type || 'unknown'}`,
                payload: { type },
              },
              this.currentPid,
            ),
          );
        }
      }
    };

    const process = spawnProcess({
      file: plan.file,
      args: plan.args,
      cwd: this.start.workspacePath,
      env: this.start.env,
      stdin: options.prompt,
      signal: options.signal,
      onStdoutLine: (line) => {
        sawLine = true;
        handleLine(line);
      },
      onStderrLine: (line) => {
        if (line.trim() === '') return;
        armWatchdog(config.codex.turn_timeout_ms);
        this.options.logger.debug('agent stderr', {
          process: plan.description,
          line: line.slice(0, 500),
        });
      },
    });
    this.activeProcess = process;
    this.currentPid = process.pid === null ? null : String(process.pid);
    armWatchdog(sawLine ? config.codex.turn_timeout_ms : config.codex.read_timeout_ms);

    let result;
    try {
      result = await process.result;
    } finally {
      clearWatchdog();
      this.activeProcess = null;
      this.currentPid = null;
    }

    // Read the turn outcome through typed locals: the values are assigned inside
    // the stdout callback, which control-flow analysis cannot track.
    const endedTurnId = turnId as string | null;
    const endedReason = turnReason as string | null;
    const endedError = errorMessage as string | null;
    const endedText = finalText as string | null;
    const turnSessionId = composeSessionId(this.thread, endedTurnId);

    if (options.signal.aborted) {
      emit(
        makeAgentEvent(
          { event: 'turn_cancelled', thread_id: this.thread, turn_id: endedTurnId, message: 'turn cancelled', session_id: turnSessionId },
          null,
        ),
      );
      return { ok: false, error: { category: 'turn_cancelled', message: 'turn cancelled' }, session_id: turnSessionId, turn_id: endedTurnId, final_text: endedText };
    }
    if (result.spawnError !== null) {
      const notFound = (result.spawnError as NodeJS.ErrnoException).code === 'ENOENT';
      const category = notFound ? 'codex_not_found' : 'response_error';
      const message = notFound
        ? `coding-agent executable not found: ${plan.description}`
        : `failed to launch coding agent: ${result.spawnError.message}`;
      emit(makeAgentEvent({ event: 'startup_failed', thread_id: this.thread, message }, null));
      return { ok: false, error: { category, message }, session_id: turnSessionId, turn_id: endedTurnId, final_text: endedText };
    }
    if (silenceExpired) {
      const message = `no agent output for ${sawLine ? config.codex.turn_timeout_ms : config.codex.read_timeout_ms}ms`;
      return { ok: false, error: { category: 'turn_timeout', message }, session_id: turnSessionId, turn_id: endedTurnId, final_text: endedText };
    }
    if (endedError !== null) {
      return {
        ok: false,
        error: { category: 'response_error', message: endedError },
        session_id: turnSessionId,
        turn_id: endedTurnId,
        final_text: endedText,
      };
    }
    if (endedReason !== null && CANCELLED_REASONS.has(endedReason.toLowerCase())) {
      return {
        ok: false,
        error: { category: 'turn_cancelled', message: `turn ended reason=${endedReason}` },
        session_id: turnSessionId,
        turn_id: endedTurnId,
        final_text: endedText,
      };
    }
    if (result.code !== 0) {
      return {
        ok: false,
        error: {
          category: 'port_exit',
          message: `agent process exited with code ${result.code ?? 'null'}${result.signal === null ? '' : ` (signal ${result.signal})`}`,
        },
        session_id: turnSessionId,
        turn_id: endedTurnId,
        final_text: endedText,
      };
    }
    if (endedReason !== null && !COMPLETED_REASONS.has(endedReason.toLowerCase())) {
      return {
        ok: false,
        error: { category: 'turn_failed', message: `turn ended reason=${endedReason}` },
        session_id: turnSessionId,
        turn_id: endedTurnId,
        final_text: endedText,
      };
    }
    return { ok: true, error: null, session_id: turnSessionId, turn_id: endedTurnId, final_text: endedText };
  }

  async stop(): Promise<void> {
    if (this.activeProcess !== null) {
      this.activeProcess.kill('session stopped');
      this.activeProcess = null;
    }
  }
}

/** Backend that drives the DSH CLI (`dsh --profile <profile> --json`). */
export class DshBackend implements AgentBackend {
  readonly kind = 'dsh';
  private readonly options: DshBackendOptions;

  constructor(options: DshBackendOptions) {
    this.options = options;
  }

  sessionTitle(issue: { identifier: string; title: string }): string {
    return `${issue.identifier}: ${issue.title}`;
  }

  async startSession(start: AgentSessionStart): Promise<AgentSession> {
    return new DshSession(start, this.options);
  }
}
