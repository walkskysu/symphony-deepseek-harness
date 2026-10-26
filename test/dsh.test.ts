import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { DshBackend, parseTurnEndReason, usageFromDsh } from '../src/agent/dsh.js';
import type { AgentEvent } from '../src/agent/events.js';
import type { ProgramPlan } from '../src/platform/launch.js';
import { makeConfig, makeIssue, logger, tempDir } from './helpers.js';

const FAKE_DSH = `
const mode = process.env.FAKE_DSH_MODE ?? 'ok';
const sessionId = process.env.FAKE_DSH_SESSION ?? 'session-abc';
const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');

if (mode === 'hang') {
  setTimeout(() => process.exit(0), 15000);
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;

  send({ type: 'session', sessionId, cwd: process.cwd() });
  send({ type: 'status', phase: 'turn_start', turn: 1 });
  send({ type: 'thinking', text: 'considering' });
  send({ type: 'text', text: 'input-bytes:' + input.trim().length });
  send({ type: 'tool_call', callId: 'c1', tool: 'bash', input: { command: 'ls' } });
  send({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'ok' });
  send({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });

  if (mode === 'fail') {
    send({ type: 'error', message: 'provider exploded' });
    process.exit(1);
  }
  if (mode === 'turnfail') {
    send({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', error: { message: 'provider exploded', code: 'PROVIDER_ERROR' } } });
    process.exit(0);
  }
  if (mode === 'reasononly') {
    // The shape real DSH emits on an in-turn failure: an object reason, then a
    // non-zero exit. The reason must win over the exit code.
    process.stderr.write('dsh: MISSING_CREDENTIAL: no API key for provider route "deepseek-official"\\n');
    send({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', error: { message: 'no API key for provider route "deepseek-official"', code: 'MISSING_CREDENTIAL' } } });
    send({ type: 'final', text: '' });
    process.exit(1);
  }
  if (mode === 'aborted') {
    send({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'aborted' } });
    process.exit(0);
  }
  send({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
  send({ type: 'final', text: 'all done' });
  send({ type: 'unknown_future_event', detail: 1 });
  process.exit(0);
}
`;

interface DshHarness {
  backend: DshBackend;
  argsSeen: string[][];
  cleanup: () => Promise<void>;
  workspace: string;
}

async function makeDsh(mode: string, frontMatterExtra = '', sessionId = 'session-abc'): Promise<DshHarness> {
  const dir = await tempDir('symphony-dsh-');
  const script = await dir.write('fake-dsh.mjs', FAKE_DSH);
  const workspace = join(dir.path, 'ws');
  await dir.write('ws/.keep', '');
  const config = makeConfig({
    frontMatter: ['tracker:', '  kind: memory', '  active_states: [open]', '  terminal_states: [closed]', frontMatterExtra].join('\n'),
  });
  const argsSeen: string[][] = [];
  const backend = new DshBackend({
    config,
    logger,
    plan: (args): ProgramPlan => {
      argsSeen.push(args);
      return { file: process.execPath, args: [script], via_shell: false, description: 'fake-dsh' };
    },
  });
  return {
    backend,
    argsSeen,
    workspace,
    cleanup: async () => {
      await dir.cleanup();
    },
  };
}

function collect(): { events: AgentEvent[]; sink: (event: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, sink: (event) => events.push(event) };
}

const baseStart = (workspace: string, mode: string, sessionId = 'session-abc') => ({
  workspacePath: workspace,
  issue: makeIssue({ id: '1', identifier: 'A-1', title: 'T' }),
  attempt: null,
  env: { ...process.env, FAKE_DSH_MODE: mode, FAKE_DSH_SESSION: sessionId },
  signal: new AbortController().signal,
});

describe('dsh headless event mapping', () => {
  it('maps a successful turn and extracts thread and turn identities', async () => {
    const harness = await makeDsh('ok');
    try {
      const session = await harness.backend.startSession(baseStart(harness.workspace, 'ok'));
      const { events, sink } = collect();
      const result = await session.runTurn({ prompt: 'hello agent', title: 'A-1: T', onEvent: sink, signal: new AbortController().signal });
      assert.equal(result.ok, true);
      assert.equal(result.error, null);
      assert.equal(session.threadId, 'session-abc');
      assert.equal(result.turn_id, '1');
      assert.equal(result.session_id, 'session-abc-1');
      assert.equal(result.final_text, 'all done');

      const names = events.map((event) => event.event);
      assert.ok(names.includes('session_started'));
      assert.ok(names.includes('turn_started'));
      assert.ok(names.includes('turn_completed'));
      assert.ok(names.includes('other_message'), 'unknown future events must not break the stream');
      const usage = events.find((event) => event.usage !== null);
      assert.ok(usage);
      assert.equal(usage.usage?.input_tokens, 10);
      assert.equal(usage.usage?.output_tokens, 5);
      assert.equal(usage.usage?.absolute, false);
    } finally {
      await harness.cleanup();
    }
  });

  it('passes the prompt on stdin and resumes the session on continuation turns', async () => {
    const harness = await makeDsh('ok');
    try {
      const session = await harness.backend.startSession(baseStart(harness.workspace, 'ok'));
      const signal = new AbortController().signal;
      await session.runTurn({ prompt: 'first prompt', title: 't', onEvent: () => undefined, signal });
      await session.runTurn({ prompt: 'second prompt', title: 't', onEvent: () => undefined, signal });
      assert.deepEqual(harness.argsSeen[0], ['--profile', 'headless', '--json', '-']);
      assert.deepEqual(harness.argsSeen[1], ['--profile', 'headless', '--json', '--session-id', 'session-abc', '-']);
    } finally {
      await harness.cleanup();
    }
  });

  it('never passes a model flag to the dsh CLI', async () => {
    const harness = await makeDsh('ok', 'harness:\n  model: deepseek-chat');
    try {
      const session = await harness.backend.startSession(baseStart(harness.workspace, 'ok'));
      await session.runTurn({ prompt: 'go', title: 't', onEvent: () => undefined, signal: new AbortController().signal });
      assert.deepEqual(harness.argsSeen[0], ['--profile', 'headless', '--json', '-']);
    } finally {
      await harness.cleanup();
    }
  });

  it('reports an agent error event as a response error', async () => {
    const harness = await makeDsh('fail');
    try {
      const session = await harness.backend.startSession(baseStart(harness.workspace, 'fail'));
      const result = await session.runTurn({ prompt: 'go', title: 't', onEvent: () => undefined, signal: new AbortController().signal });
      assert.equal(result.ok, false);
      assert.equal(result.error?.category, 'response_error');
      assert.match(result.error?.message ?? '', /provider exploded/);
    } finally {
      await harness.cleanup();
    }
  });

  it('reports a failed turn reason as turn_failed', async () => {
    const harness = await makeDsh('turnfail');
    try {
      const session = await harness.backend.startSession(baseStart(harness.workspace, 'turnfail'));
      const result = await session.runTurn({ prompt: 'go', title: 't', onEvent: () => undefined, signal: new AbortController().signal });
      assert.equal(result.ok, false);
      assert.equal(result.error?.category, 'turn_failed');
      assert.match(result.error?.message ?? '', /PROVIDER_ERROR: provider exploded/);
    } finally {
      await harness.cleanup();
    }
  });

  it('prefers the turn_end reason over the exit code', async () => {
    const harness = await makeDsh('reasononly');
    try {
      const session = await harness.backend.startSession(baseStart(harness.workspace, 'reasononly'));
      const result = await session.runTurn({ prompt: 'go', title: 't', onEvent: () => undefined, signal: new AbortController().signal });
      assert.equal(result.ok, false);
      assert.equal(result.error?.category, 'turn_failed', 'a non-zero exit with an error reason is a turn failure');
      assert.match(result.error?.message ?? '', /MISSING_CREDENTIAL/);
      assert.match(result.error?.message ?? '', /no API key/);
    } finally {
      await harness.cleanup();
    }
  });

  it('reports an aborted turn as turn_cancelled', async () => {
    const harness = await makeDsh('aborted');
    try {
      const session = await harness.backend.startSession(baseStart(harness.workspace, 'aborted'));
      const result = await session.runTurn({ prompt: 'go', title: 't', onEvent: () => undefined, signal: new AbortController().signal });
      assert.equal(result.ok, false);
      assert.equal(result.error?.category, 'turn_cancelled');
    } finally {
      await harness.cleanup();
    }
  });

  it('enforces the startup read timeout when the agent never speaks', async () => {
    const harness = await makeDsh('hang', 'codex:\n  read_timeout_ms: 150\n');
    try {
      const session = await harness.backend.startSession(baseStart(harness.workspace, 'hang'));
      const started = Date.now();
      const result = await session.runTurn({ prompt: 'go', title: 't', onEvent: () => undefined, signal: new AbortController().signal });
      assert.equal(result.ok, false);
      assert.equal(result.error?.category, 'turn_timeout');
      assert.ok(Date.now() - started < 10_000, 'timeout must end the turn quickly');
    } finally {
      await harness.cleanup();
    }
  });

  it('maps a missing executable to codex_not_found', async () => {
    const harness = await makeDsh('ok');
    try {
      const failing = new DshBackend({
        config: makeConfig(),
        logger,
        plan: (): ProgramPlan => ({ file: join(harness.workspace, 'does-not-exist-binary'), args: [], via_shell: false, description: 'missing' }),
      });
      const session = await failing.startSession(baseStart(harness.workspace, 'ok'));
      const result = await session.runTurn({ prompt: 'go', title: 't', onEvent: () => undefined, signal: new AbortController().signal });
      assert.equal(result.ok, false);
      assert.equal(result.error?.category, 'codex_not_found');
    } finally {
      await harness.cleanup();
    }
  });

  it('honours cancellation through the abort signal', async () => {
    const harness = await makeDsh('hang', 'codex:\n  read_timeout_ms: 60000\n');
    try {
      const controller = new AbortController();
      const session = await harness.backend.startSession({
        ...baseStart(harness.workspace, 'hang'),
        signal: controller.signal,
      });
      const pending = session.runTurn({ prompt: 'go', title: 't', onEvent: () => undefined, signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.error?.category, 'turn_cancelled');
    } finally {
      await harness.cleanup();
    }
  });
});

describe('turn_end reason parsing', () => {
  it('accepts the object shape current DSH emits', () => {
    assert.deepEqual(parseTurnEndReason({ kind: 'completed' }), { kind: 'completed', message: null });
    assert.deepEqual(
      parseTurnEndReason({ kind: 'error', error: { message: 'no API key', code: 'MISSING_CREDENTIAL' } }),
      { kind: 'error', message: 'MISSING_CREDENTIAL: no API key' },
    );
    assert.deepEqual(parseTurnEndReason({ kind: 'aborted' }), { kind: 'aborted', message: null });
  });

  it('still accepts a plain string reason from earlier builds', () => {
    assert.deepEqual(parseTurnEndReason('completed'), { kind: 'completed', message: null });
    assert.deepEqual(parseTurnEndReason('Aborted'), { kind: 'aborted', message: null });
    assert.equal(parseTurnEndReason(''), null);
    assert.equal(parseTurnEndReason(null), null);
  });
});

describe('dsh usage normalization', () => {
  it('reads camelCase and snake_case usage keys', () => {
    assert.deepEqual(usageFromDsh({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }), {
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
      absolute: false,
    });
    assert.deepEqual(usageFromDsh({ input_tokens: 4, output_tokens: 5 }), {
      input_tokens: 4,
      output_tokens: 5,
      total_tokens: 9,
      absolute: false,
    });
    assert.equal(usageFromDsh({ nothing: true }), null);
    assert.equal(usageFromDsh(null), null);
  });
});
