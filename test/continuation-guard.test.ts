import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { AgentTurnResult } from '../src/agent/backend.js';
import { makeConfig, makeIssue, makeSnapshot, FakeTracker, StubBackend, logger, tempDir } from './helpers.js';

const yamlPath = (path: string): string => `'${path.replace(/'/g, "''")}'`;

const success = (): AgentTurnResult => ({ ok: true, error: null, session_id: null, turn_id: null, final_text: 'done' });

interface Harness {
  orchestrator: Orchestrator;
  tracker: FakeTracker;
  backend: StubBackend;
  cleanup: () => Promise<void>;
}

async function harness(issueState: string, extraFrontMatter: string): Promise<Harness> {
  const dir = await tempDir('symphony-guard-');
  const config = makeConfig({
    frontMatter: [
      'tracker:',
      '  kind: memory',
      '  active_states: [open, in-progress]',
      '  terminal_states: [done]',
      `workspace:`,
      `  root: ${yamlPath(join(dir.path, 'ws'))}`,
      extraFrontMatter,
    ].join('\n'),
  });
  const issue = makeIssue({ id: '1', identifier: 'A-1', state: issueState });
  const tracker = new FakeTracker();
  tracker.byStates = [issue];
  tracker.byIds = [issue];
  const backend = new StubBackend(() => success());
  const orchestrator = new Orchestrator({ getSnapshot: () => makeSnapshot(config, tracker, backend), logger, autoTimers: false });
  return {
    orchestrator,
    tracker,
    backend,
    cleanup: async () => {
      await orchestrator.stop();
      await dir.cleanup();
    },
  };
}

describe('continuation guard', () => {
  it('pauses an issue after N normal sessions that never hand it off', async () => {
    const h = await harness('open', 'agent:\n  max_turns: 1\n  max_continuation_cycles: 2\n');
    try {
      await h.orchestrator.start();
      await h.orchestrator.drain();
      assert.equal(h.backend.startCalls.length, 1, 'first session dispatched');

      await h.orchestrator.fireRetry('1');
      await h.orchestrator.drain();
      assert.equal(h.backend.startCalls.length, 2, 'second session dispatched');

      // Third cycle must be refused: the issue never left the active state.
      await h.orchestrator.fireRetry('1');
      await h.orchestrator.drain();
      assert.equal(h.backend.startCalls.length, 2, 'no third session');
      assert.equal(h.orchestrator.getState().claimed.has('1'), false, 'claim released while paused');

      // A normal tick must not dispatch it either.
      await h.orchestrator.tick();
      await h.orchestrator.drain();
      assert.equal(h.backend.startCalls.length, 2, 'tick respects the pause');
    } finally {
      await h.cleanup();
    }
  });

  it('resumes once the tracker state changes', async () => {
    const h = await harness('open', 'agent:\n  max_turns: 1\n  max_continuation_cycles: 1\n');
    try {
      await h.orchestrator.start();
      await h.orchestrator.drain();
      assert.equal(h.backend.startCalls.length, 1);

      // One session is enough to hit the limit of 1.
      await h.orchestrator.fireRetry('1');
      await h.orchestrator.drain();
      assert.equal(h.backend.startCalls.length, 1, 'paused after a single unfinished session');

      // A human moves the issue; the guard resets and dispatch resumes.
      const moved = makeIssue({ id: '1', identifier: 'A-1', state: 'in-progress' });
      h.tracker.byStates = [moved];
      h.tracker.byIds = [moved];
      await h.orchestrator.tick();
      await h.orchestrator.drain();
      assert.equal(h.backend.startCalls.length, 2, 'state change resumes dispatch');
    } finally {
      await h.cleanup();
    }
  });

  it('does not pause when the worker hands the issue off', async () => {
    const h = await harness('open', 'agent:\n  max_turns: 1\n  max_continuation_cycles: 1\n');
    try {
      // The agent moves the issue to review during the first turn.
      const moved = makeIssue({ id: '1', identifier: 'A-1', state: 'review' });
      h.backend.handler = () => {
        h.tracker.byStates = [moved];
        h.tracker.byIds = [moved];
        return success();
      };
      await h.orchestrator.start();
      await h.orchestrator.drain();
      assert.equal(h.backend.startCalls.length, 1);
      await h.orchestrator.fireRetry('1');
      await h.orchestrator.drain();
      assert.equal(h.backend.startCalls.length, 1, 'a handed-off issue is not re-dispatched');
      assert.equal(h.orchestrator.getState().claimed.has('1'), false);
    } finally {
      await h.cleanup();
    }
  });
});

describe('max_continuation_cycles config', () => {
  it('defaults to 3 and accepts 0 (guard disabled)', () => {
    assert.equal(makeConfig().agent.max_continuation_cycles, 3);
    assert.equal(makeConfig({ frontMatter: `${'tracker:\n  kind: memory'}\nagent:\n  max_continuation_cycles: 0` }).agent.max_continuation_cycles, 0);
  });

  it('rejects a negative value', () => {
    assert.throws(() => makeConfig({ frontMatter: 'tracker:\n  kind: memory\nagent:\n  max_continuation_cycles: -1' }));
  });
});
