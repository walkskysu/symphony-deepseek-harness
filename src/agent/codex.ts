/**
 * Codex app-server backend (SPEC 10.2).
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio, which is the transport
 * the Codex app-server uses. The client is deliberately tolerant about the
 * exact method names and payload nesting of the targeted app-server version:
 * thread and turn identities are extracted from several known shapes, and the
 * turn end signal is recognized from either `turn/*` notifications or the
 * `codex/event` wrapper used by earlier builds.
 *
 * Method sequence:
 *   1. `initialize`         - client identity and capabilities
 *   2. `thread/start`       - create the agent thread in the workspace cwd
 *   3. `turn/start`         - send the prompt (repeated for continuation turns)
 *
 * Approvals are auto-approved for the session when `codex.approval_policy` is
 * not `never`; a user-input request fails the turn instead of stalling it, as
 * the documented policy in `docs/TRUST.md` requires.
 */
import { composeSessionId, makeAgentEvent, type AgentEvent, type TokenUsage } from './events.js';
import type { AgentBackend, AgentSession, AgentSessionStart, AgentTurnOptions, AgentTurnResult } from './backend.js';
import type { ServiceConfig } from '../config/config.js';
import type { Logger } from '../observability/logger.js';
import { planProgram, type ProgramPlan } from '../platform/launch.js';
import { spawnProcess, type RunningProcess } from '../platform/shell.js';

export interface CodexBackendOptions {
  config: ServiceConfig;
  logger: Logger;
  plan?: (args: string[], env: NodeJS.ProcessEnv) => ProgramPlan;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingTurn {
  resolve: (outcome: { status: 'completed' | 'failed' | 'cancelled'; message: string }) => void;
}

const COMPLETED_METHODS = new Set(['turn/completed', 'turn/finished', 'turn/ended']);
const FAILED_METHODS = new Set(['turn/failed', 'turn/error']);
const CANCELLED_METHODS = new Set(['turn/cancelled', 'turn/canceled', 'turn/aborted']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Extract absolute token usage from the several payload shapes the protocol uses. */
export function usageFromCodex(value: unknown): TokenUsage | null {
  const record = asRecord(value);
  if (record === null) return null;
  const total = asRecord(record['total_token_usage']) ?? asRecord(record['totalTokenUsage']) ?? asRecord(record['total']) ?? record;
  const input = numberOrNull(total['input_tokens']) ?? numberOrNull(total['inputTokens']);
  const output = numberOrNull(total['output_tokens']) ?? numberOrNull(total['outputTokens']);
  const sum = numberOrNull(total['total_tokens']) ?? numberOrNull(total['totalTokens']);
  if (input === null && output === null && sum === null) return null;
  return {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    total_tokens: sum ?? (input ?? 0) + (output ?? 0),
    absolute: true,
  };
}

export class CodexSession implements AgentSession {
  private readonly start: AgentSessionStart;
  private readonly options: CodexBackendOptions;
  private process: RunningProcess | null = null;
  private thread: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private pendingTurn: PendingTurn | null = null;
  private currentPid: string | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastEventAt = 0;
  private inputRequired = false;
  private lastError: string | null = null;
  private lastAgentMessage: string | null = null;
  private rateLimits: unknown = null;

  constructor(start: AgentSessionStart, options: CodexBackendOptions) {
    this.start = start;
    this.options = options;
  }

  get threadId(): string | null {
    return this.thread;
  }

  get pid(): string | null {
    return this.currentPid;
  }

  /** Start the app-server subprocess and initialize the thread. */
  async connect(): Promise<void> {
    const config = this.options.config;
    const plan =
      this.options.plan?.(config.harness.args, this.start.env) ??
      planProgram(config.codex.command, config.harness.args);
    const transport = spawnProcess({
      file: plan.file,
      args: plan.args,
      cwd: this.start.workspacePath,
      env: this.start.env,
      keepStdinOpen: true,
      signal: this.start.signal,
      onStdoutLine: (line) => this.handleLine(line),
      onStderrLine: (line) => {
        if (line.trim() === '') return;
        this.touch();
        this.options.logger.debug('codex stderr', { line: line.slice(0, 500) });
      },
    });
    this.process = transport;
    this.currentPid = transport.pid === null ? null : String(transport.pid);
    transport.result
      .then((result) => {
        if (result.spawnError !== null) {
          this.failAll(new Error(`coding-agent launch failed: ${result.spawnError.message}`));
        } else if (this.pendingTurn !== null) {
          this.settleTurn({ status: 'failed', message: `app-server exited with code ${result.code ?? 'null'}` });
        }
      })
      .catch((error: unknown) => this.failAll(error instanceof Error ? error : new Error(String(error))));

    await this.request(
      'initialize',
      {
        clientInfo: { name: 'symphony-deepseek', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
      config.codex.read_timeout_ms,
    );

    const threadResult = await this.startThread(config.codex.read_timeout_ms);
    if (threadResult === null) {
      throw new Error('codex app-server did not return a thread identity');
    }
    this.thread = threadResult;
    this.emit({
      event: 'session_started',
      thread_id: threadResult,
      session_id: composeSessionId(threadResult, null),
      message: 'thread started',
    });
  }

  private async startThread(timeoutMs: number): Promise<string | null> {
    const config = this.options.config;
    const baseParams: Record<string, unknown> = {
      cwd: this.start.workspacePath,
      ...(config.codex.approval_policy === null ? {} : { approvalPolicy: config.codex.approval_policy }),
      ...(config.codex.thread_sandbox === null ? {} : { sandbox: config.codex.thread_sandbox }),
      ...(config.harness.model === null ? {} : { model: config.harness.model }),
    };
    const attempts: Array<{ method: string; params: Record<string, unknown> }> = [
      { method: 'thread/start', params: baseParams },
      { method: 'newConversation', params: baseParams },
    ];
    let lastError: unknown = null;
    for (const attempt of attempts) {
      try {
        const result = await this.request(attempt.method, attempt.params, timeoutMs);
        const record = asRecord(result);
        if (record === null) return null;
        const thread = asRecord(record['thread']);
        const candidate =
          (typeof thread?.['id'] === 'string' ? thread['id'] : null) ??
          (typeof record['threadId'] === 'string' ? record['threadId'] : null) ??
          (typeof record['conversationId'] === 'string' ? record['conversationId'] : null) ??
          (typeof record['id'] === 'string' ? record['id'] : null);
        if (candidate !== null) return candidate;
        return null;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('thread/start failed');
  }

  async runTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
    const config = this.options.config;
    if (this.process === null || this.thread === null) {
      return {
        ok: false,
        error: { category: 'response_error', message: 'codex session is not connected' },
        session_id: null,
        turn_id: null,
        final_text: null,
      };
    }
    const params: Record<string, unknown> = {
      threadId: this.thread,
      cwd: this.start.workspacePath,
      input: [{ type: 'text', text: options.prompt }],
      title: options.title,
      ...(config.codex.turn_sandbox_policy === null ? {} : { sandboxPolicy: config.codex.turn_sandbox_policy }),
    };

    this.inputRequired = false;
    this.lastError = null;
    this.lastAgentMessage = null;
    this.setEventSink(options.onEvent);
    this.armWatchdog(config.codex.read_timeout_ms);

    let turnId: string | null = null;
    let turnPromise: Promise<{ status: 'completed' | 'failed' | 'cancelled'; message: string }>;
    try {
      const started = await this.request('turn/start', params, config.codex.read_timeout_ms);
      const record = asRecord(started);
      const turn = asRecord(record?.['turn']);
      turnId = (typeof turn?.['id'] === 'string' ? turn['id'] : null) ?? (typeof record?.['turnId'] === 'string' ? record['turnId'] : null);
      this.armWatchdog(config.codex.turn_timeout_ms);
      turnPromise = new Promise((resolve) => {
        this.pendingTurn = { resolve };
      });
    } catch (error) {
      this.clearWatchdog();
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ event: 'turn_ended_with_error', message });
      return {
        ok: false,
        error: { category: 'response_error', message },
        session_id: composeSessionId(this.thread, null),
        turn_id: null,
        final_text: null,
      };
    }

    this.emit({
      event: 'turn_started',
      thread_id: this.thread,
      turn_id: turnId,
      session_id: composeSessionId(this.thread, turnId),
      message: 'turn started',
    });

    const outcome = await turnPromise;
    this.clearWatchdog();
    this.pendingTurn = null;
    const sessionId = composeSessionId(this.thread, turnId);

    if (this.inputRequired) {
      return {
        ok: false,
        error: { category: 'turn_input_required', message: 'agent requested user input; failing the turn by policy' },
        session_id: sessionId,
        turn_id: turnId,
        final_text: null,
      };
    }
    if (outcome.status === 'cancelled') {
      return {
        ok: false,
        error: { category: 'turn_cancelled', message: outcome.message },
        session_id: sessionId,
        turn_id: turnId,
        final_text: null,
      };
    }
    if (outcome.status === 'failed') {
      return {
        ok: false,
        error: { category: 'turn_failed', message: this.lastError ?? outcome.message },
        session_id: sessionId,
        turn_id: turnId,
        final_text: null,
      };
    }
    return { ok: true, error: null, session_id: sessionId, turn_id: turnId, final_text: this.lastAgentMessage };
  }

  /* --------------------------------------------------------- transport */

  private send(message: Record<string, unknown>): void {
    const child = this.process?.child;
    if (child === null || child === undefined) throw new Error('codex app-server is not running');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private respond(id: number, result: unknown): void {
    try {
      this.send({ jsonrpc: '2.0', id, result });
    } catch {
      // The transport is gone; the turn will fail through the exit path.
    }
  }

  private respondError(id: number, code: number, message: string): void {
    try {
      this.send({ jsonrpc: '2.0', id, error: { code, message } });
    } catch {
      // Ignore.
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    this.touch();
    let message: Record<string, unknown> | null = null;
    try {
      message = asRecord(JSON.parse(trimmed));
    } catch {
      this.emit({ event: 'malformed', message: trimmed.slice(0, 200) });
      return;
    }
    if (message === null) return;

    const id = message['id'];
    const method = typeof message['method'] === 'string' ? message['method'] : null;
    const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(message, 'error');

    if (method === null) {
      if (typeof id === 'number' && (hasResult || hasError)) {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (hasError) {
          const errorRecord = asRecord(message['error']);
          pending.reject(new Error(typeof errorRecord?.['message'] === 'string' ? (errorRecord['message'] as string) : 'codex request failed'));
        } else {
          pending.resolve(message['result']);
        }
      }
      return;
    }

    // Server -> client request needs a response so the session never stalls.
    if (typeof id === 'number' && method !== null) {
      this.handleServerRequest(id, method, asRecord(message['params']) ?? {});
      return;
    }

    this.handleNotification(method, asRecord(message['params']) ?? {});
  }

  private handleServerRequest(id: number, method: string, params: Record<string, unknown>): void {
    const lower = method.toLowerCase();
    if (lower.includes('approval')) {
      const policy = this.options.config.codex.approval_policy;
      const approved = policy !== 'never';
      this.emit({
        event: approved ? 'approval_auto_approved' : 'unsupported_tool_call',
        message: `${method} ${approved ? 'approved_for_session' : 'denied'}`,
      });
      this.respond(id, { decision: approved ? 'approved_for_session' : 'denied' });
      return;
    }
    if (lower.includes('input') || lower.includes('question')) {
      this.inputRequired = true;
      this.emit({ event: 'turn_input_required', message: `${method} requested user input` });
      this.respondError(id, -32001, 'user input is not available in this deployment');
      this.settleTurn({ status: 'failed', message: 'agent requested user input' });
      return;
    }
    this.emit({ event: 'unsupported_tool_call', message: `unsupported server request: ${method}` });
    this.respondError(id, -32601, `unsupported request: ${method}`);
    void params;
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (COMPLETED_METHODS.has(method)) {
      const turn = asRecord(params['turn']);
      const status = typeof turn?.['status'] === 'string' ? (turn['status'] as string) : 'completed';
      this.emit({ event: 'turn_completed', message: `turn completed status=${status}` });
      this.settleTurn({ status: 'completed', message: status });
      return;
    }
    if (FAILED_METHODS.has(method)) {
      const message = typeof params['message'] === 'string' ? (params['message'] as string) : 'turn failed';
      this.lastError = message;
      this.emit({ event: 'turn_failed', message });
      this.settleTurn({ status: 'failed', message });
      return;
    }
    if (CANCELLED_METHODS.has(method)) {
      const message = typeof params['message'] === 'string' ? (params['message'] as string) : 'turn cancelled';
      this.emit({ event: 'turn_cancelled', message });
      this.settleTurn({ status: 'cancelled', message });
      return;
    }
    if (method === 'thread/tokenUsage/updated' || method === 'thread/tokenUsage/update') {
      const usage = usageFromCodex(params['tokenUsage'] ?? params['usage'] ?? params);
      if (usage !== null) this.emit({ event: 'notification', message: 'token usage', usage });
      return;
    }
    if (method === 'account/rateLimits/updated' || method === 'account/rateLimits/update') {
      this.rateLimits = params['rateLimits'] ?? params;
      this.emit({ event: 'notification', message: 'rate limits updated', rate_limits: this.rateLimits });
      return;
    }
    if (method === 'codex/event') {
      const envelope = asRecord(params['msg']) ?? params;
      const type = typeof envelope['type'] === 'string' ? (envelope['type'] as string) : '';
      if (type === 'task_complete' || type === 'turn_complete') {
        this.emit({ event: 'turn_completed', message: 'turn completed' });
        this.settleTurn({ status: 'completed', message: type });
        return;
      }
      if (type === 'turn_aborted') {
        this.emit({ event: 'turn_cancelled', message: type });
        this.settleTurn({ status: 'cancelled', message: type });
        return;
      }
      if (type === 'error') {
        const message = typeof envelope['message'] === 'string' ? (envelope['message'] as string) : 'agent error';
        this.lastError = message;
        this.emit({ event: 'turn_ended_with_error', message });
        this.settleTurn({ status: 'failed', message });
        return;
      }
      this.emit({ event: 'notification', message: `codex event ${type || 'unknown'}`, payload: { type } });
      return;
    }
    if (method === 'item/completed' || method === 'item/started') {
      const item = asRecord(params['item']);
      const type = typeof item?.['type'] === 'string' ? (item['type'] as string) : 'item';
      if (type === 'agent_message') {
        const text = typeof item?.['text'] === 'string' ? (item['text'] as string) : null;
        if (text !== null) this.lastAgentMessage = text;
      }
      this.emit({ event: 'notification', message: `${method} ${type}`, payload: { type } });
      return;
    }
    this.emit({ event: 'other_message', message: `unhandled notification ${method}`, payload: { method } });
  }

  private settleTurn(outcome: { status: 'completed' | 'failed' | 'cancelled'; message: string }): void {
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    if (pending !== null) pending.resolve(outcome);
  }

  private emit(init: Parameters<typeof makeAgentEvent>[0]): void {
    const event: AgentEvent = makeAgentEvent(init, this.currentPid);
    this.startOnEvent(event);
  }

  private startOnEvent: (event: AgentEvent) => void = () => undefined;

  /** Wire the event sink used by the current turn. */
  setEventSink(sink: (event: AgentEvent) => void): void {
    this.startOnEvent = sink;
  }

  private touch(): void {
    this.lastEventAt = Date.now();
  }

  private armWatchdog(timeoutMs: number): void {
    this.clearWatchdog();
    this.touch();
    this.watchdog = setTimeout(() => {
      this.emit({ event: 'turn_ended_with_error', message: `no app-server output for ${timeoutMs}ms` });
      this.lastError = `no app-server output for ${timeoutMs}ms`;
      this.settleTurn({ status: 'failed', message: this.lastError });
    }, timeoutMs);
    this.watchdog.unref();
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (this.pendingTurn !== null) {
      this.settleTurn({ status: 'failed', message: error.message });
    }
  }

  async stop(): Promise<void> {
    this.clearWatchdog();
    this.failAll(new Error('session stopped'));
    if (this.process !== null) {
      this.process.kill('session stopped');
      this.process = null;
    }
    this.currentPid = null;
  }
}

/** Backend that drives a Codex app-server subprocess. */
export class CodexBackend implements AgentBackend {
  readonly kind = 'codex';
  private readonly options: CodexBackendOptions;

  constructor(options: CodexBackendOptions) {
    this.options = options;
  }

  sessionTitle(issue: { identifier: string; title: string }): string {
    return `${issue.identifier}: ${issue.title}`;
  }

  async startSession(start: AgentSessionStart): Promise<AgentSession> {
    const session = new CodexSession(start, this.options);
    await session.connect();
    return session;
  }
}
