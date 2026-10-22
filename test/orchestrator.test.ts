import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Orchestrator, type ServiceSnapshot } from '../src/orchestrator/orchestrator.js';
import { compareForDispatch, sortForDispatch } from '../src/orchestrator/eligibility.js';
import { deriveWorkspaceKey } from '../src/workspace/manager.js';
import { isActiveState, isTerminalState } from '../src/orchestrator/eligibility.js';
import type { AgentTurnResult } from '../src/agent/backend.js';
import type { FailureKind } from '../src/domain/types.js';
import { trackerError } from '../src/domain/errors.js';
import { makeConfig, makeIssue, makeSnapshot, FakeTracker, StubBackend, logger, waitFor, Deferred, tempDir, type StubTurnContext } from './helpers.js';

const yamlPath = (path: string): string => `'${path.replace(/'/g, "''")}'`;

interface Harness {
  orchestrator: Orchestrator;
  tracker: FakeTracker;
  backend: StubBackend;
  snapshot: ServiceSnapshot;
  cleanup: () => Promise<void>;
}

interface HarnessOptions {
  issues: ReturnType<typeof makeIssue>[];
  handler: (context: StubTurnContext) => AgentTurnResult | Promise<AgentTurnResult>;
  frontMatter?: string;
  workspaceRoot?: string;
  autoStart?: boolean;
}

async function makeHarness(options: HarnessOptions): Promise<Harness> {
  const dir = await tempDir('symphony-orch-');
  const workspaceRoot = options.workspaceRoot ?? join(dir.path, 'ws');
  const config = makeConfig({
    frontMatter: [`tracker:`, `  kind: memory`, `  active_states: [open]`, `  terminal_states: [done]`].join('\n') +
      `\nworkspace:\n  root: ${yamlPath(workspaceRoot)}\n` +
      (options.frontMatter ?? ''),
  });
  const tracker = new FakeTracker();
  tracker.byStates = options.issues;
  tracker.byIds = options.issues;
  const backend = new StubBackend(options.handler);
  const snapshot = makeSnapshot(config, tracker, backend);
  const orchestrator = new Orchestrator({
    getSnapshot: () => snapshot,
    logger,
    autoTimers: false,
  });
  return {
    orchestrator,
    tracker,
    backend,
    snapshot,
    cleanup: async () => {
      await orchestrator.stop();
      await dir.cleanup();
    },
  };
}

function success(text = 'done'): AgentTurnResult {
  return { ok: true, error: null, session_id: null, turn_id: null, final_text: text };
}

function failure(category: FailureKind = 'turn_failed'): AgentTurnResult {
  return {
    ok: false,
    error: { category, message: 'agent failed' },
    session_id: null,
    turn_id: null,
    final_text: null,
  };
}

describe('dispatch ordering', () => {
  it('sorts priorities 1..4 first, then oldest creation, then identifier', () => {
    const sorted = sortForDispatch([
      makeIssue({ id: 'a', identifier: 'A-1', priority: null, created_at: '2026-01-01T00:00:00Z' }),
      makeIssue({ id: 'b', identifier: 'B-1', priority: 2, created_at: '2026-03-01T00:00:00Z' }),
      makeIssue({ id: 'c', identifier: 'C-1', priority: 1, created_at: '2026-02-01T00:00:00Z' }),
      makeIssue({ id: 'd', identifier: 'D-1', priority: 5, created_at: '2025-01-01T00:00:00Z' }),
      makeIssue({ id: 'e', identifier: 'E-1', priority: null, created_at: null }),
    ]);
    assert.deepEqual(sorted.map((issue) => issue.identifier), ['C-1', 'B-1', 'D-1', 'A-1', 'E-1']);
  });

  it('sorts unbucketed priorities before null, then by creation time', () => {
    const left = makeIssue({ identifier: 'A', priority: 9, created_at: null });
    const right = makeIssue({ identifier: 'B', priority: null, created_at: null });
    assert.equal(compareForDispatch(left, right) < 0, true);
    assert.equal(compareForDispatch(right, left) > 0, true);
  });

  it('falls back to identifier lexicographic comparison', () => {
    const left = makeIssue({ identifier: 'AAA-2', priority: null, created_at: null });
    const right = makeIssue({ identifier: 'AAA-1', priority: null, created_at: null });
    assert.equal(compareForDispatch(left, right) > 0, true);
  });
});

describe('dispatch eligibility', () => {
  it('dispatches active, routable issues and ignores the rest', async () => {
    const harness = await makeHarness({
      issues: [
        makeIssue({ id: '1', identifier: 'A-1' }),
        makeIssue({ id: '2', identifier: 'B-1', dispatchable: false }),
        makeIssue({ id: '3', identifier: 'C-1', state: 'done' }),
        makeIssue({ id: '4', identifier: 'D-1', state: 'backlog' }),
      ],
      handler: () => success(),
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await harness.orchestrator.drain();
      const started = harness.backend.startCalls.map((start) => start.issue.identifier);
      assert.deepEqual(started, ['A-1']);
    } finally {
      await harness.cleanup();
    }
  });

  it('applies required labels case-insensitively after normalization', async () => {
    const harness = await makeHarness({
      issues: [
        makeIssue({ id: '1', identifier: 'A-1', labels: ['Symphony'] }),
        makeIssue({ id: '2', identifier: 'B-1', labels: ['bug'] }),
      ],
      handler: () => success(),
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    harness.snapshot.config.tracker.required_labels = ['symphony'];
    try {
      await harness.orchestrator.start();
      await harness.orchestrator.drain();
      assert.deepEqual(harness.backend.startCalls.map((start) => start.issue.identifier), ['A-1']);
    } finally {
      await harness.cleanup();
    }
  });

  it('respects the global concurrency limit', async () => {
    const gate = new Deferred<void>();
    const harness = await makeHarness({
      issues: [
        makeIssue({ id: '1', identifier: 'A-1', created_at: '2026-01-01T00:00:00Z' }),
        makeIssue({ id: '2', identifier: 'B-1', created_at: '2026-01-02T00:00:00Z' }),
      ],
      handler: async () => {
        await gate.promise;
        return success();
      },
      frontMatter: 'agent:\n  max_concurrent_agents: 1\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await waitFor(() => harness.backend.startCalls.length === 1, 2_000, 'first dispatch');
      assert.equal(harness.orchestrator.getState().running.size, 1);
      await harness.orchestrator.tick();
      assert.equal(harness.backend.startCalls.length, 1, 'second issue waits for a slot');
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it('respects per-state concurrency limits', async () => {
    const gate = new Deferred<void>();
    const harness = await makeHarness({
      issues: [
        makeIssue({ id: '1', identifier: 'A-1', state: 'open' }),
        makeIssue({ id: '2', identifier: 'B-1', state: 'open' }),
      ],
      handler: async () => {
        await gate.promise;
        return success();
      },
      frontMatter: 'agent:\n  max_concurrent_agents: 4\n  max_concurrent_agents_by_state:\n    open: 1\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await waitFor(() => harness.backend.startCalls.length === 1, 2_000, 'first dispatch');
      await harness.orchestrator.tick();
      assert.equal(harness.backend.startCalls.length, 1);
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it('does not re-dispatch a claimed issue', async () => {
    const gate = new Deferred<void>();
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1' })],
      handler: async () => {
        await gate.promise;
        return success();
      },
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await waitFor(() => harness.backend.startCalls.length === 1, 2_000, 'dispatch');
      await harness.orchestrator.tick();
      await harness.orchestrator.tick();
      assert.equal(harness.backend.startCalls.length, 1);
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });
});

describe('worker exit and retry scheduling', () => {
  it('schedules a short continuation retry after a normal exit', async () => {
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1' })],
      handler: () => success(),
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await harness.orchestrator.drain();
      const retry = harness.orchestrator.getState().retry_attempts.get('1');
      assert.ok(retry);
      assert.equal(retry.attempt, 1);
      assert.equal(retry.continuation, true);
      assert.equal(retry.error, null);
      assert.equal(retry.identifier, 'A-1');
      const delay = retry.due_at_ms - Date.now();
      assert.ok(delay <= 1_050 && delay > 0, `continuation delay should be ~1s, got ${delay}`);
      assert.equal(harness.orchestrator.getState().completed.has('1'), true);
      assert.equal(harness.orchestrator.getState().claimed.has('1'), true);
    } finally {
      await harness.cleanup();
    }
  });

  it('uses 10s-based exponential backoff with the configured cap for failures', async () => {
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1' })],
      handler: () => failure(),
      frontMatter: 'agent:\n  max_turns: 1\n  max_retry_backoff_ms: 15000\n',
    });
    try {
      await harness.orchestrator.start();
      await harness.orchestrator.drain();
      let retry = harness.orchestrator.getState().retry_attempts.get('1');
      assert.ok(retry);
      assert.equal(retry.attempt, 1);
      assert.equal(retry.continuation, false);
      assert.match(retry.error ?? '', /agent failed/);
      const firstDelay = retry.due_at_ms - Date.now();
      assert.ok(firstDelay > 9_000 && firstDelay <= 10_050, `first backoff should be ~10s, got ${firstDelay}`);

      // Force the next attempt to fail as well: attempt 2 base delay is 20s but
      // the configured cap is 15s.
      await harness.orchestrator.fireRetry('1');
      await harness.orchestrator.drain();
      retry = harness.orchestrator.getState().retry_attempts.get('1');
      assert.ok(retry);
      assert.equal(retry.attempt, 2);
      const secondDelay = retry.due_at_ms - Date.now();
      assert.ok(secondDelay > 14_000 && secondDelay <= 15_050, `capped backoff should be ~15s, got ${secondDelay}`);
    } finally {
      await harness.cleanup();
    }
  });

  it('redispenses a retry through the tracker snapshot with the retry attempt', async () => {
    let turns = 0;
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1' })],
      handler: () => {
        turns += 1;
        return turns === 1 ? failure() : success();
      },
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await harness.orchestrator.drain();
      await harness.orchestrator.fireRetry('1');
      await harness.orchestrator.drain();
      assert.equal(harness.backend.startCalls.length, 2);
      assert.equal(harness.backend.startCalls[1]?.attempt, 1);
    } finally {
      await harness.cleanup();
    }
  });

  it('requeues a retry when no orchestrator slots are available', async () => {
    const gate = new Deferred<void>();
    let blocking = false;
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1' })],
      handler: async (context) => {
        if (context.issue.id === '2') {
          blocking = true;
          await gate.promise;
        }
        return context.issue.id === '1' ? failure() : success();
      },
      frontMatter: 'agent:\n  max_concurrent_agents: 1\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await harness.orchestrator.drain();
      assert.ok(harness.orchestrator.getState().retry_attempts.get('1'));

      // Occupy the only slot with a second issue.
      const other = makeIssue({ id: '2', identifier: 'B-1' });
      harness.tracker.byStates.push(other);
      harness.tracker.byIds.push(other);
      await harness.orchestrator.tick();
      await waitFor(() => blocking, 2_000, 'second issue running');

      await harness.orchestrator.fireRetry('1');
      const retry = harness.orchestrator.getState().retry_attempts.get('1');
      assert.ok(retry);
      assert.equal(retry.error, 'no available orchestrator slots');
      assert.equal(retry.attempt, 2);
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it('releases the claim when a retried issue is no longer visible', async () => {
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1' })],
      handler: () => failure(),
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await harness.orchestrator.drain();
      harness.tracker.byIds = [];
      await harness.orchestrator.fireRetry('1');
      assert.equal(harness.orchestrator.getState().claimed.has('1'), false);
      assert.equal(harness.orchestrator.getState().retry_attempts.has('1'), false);
    } finally {
      await harness.cleanup();
    }
  });

  it('releases a retried issue that is no longer active', async () => {
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1' })],
      handler: () => failure(),
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await harness.orchestrator.drain();
      harness.tracker.byIds = [makeIssue({ id: '1', identifier: 'A-1', state: 'backlog' })];
      await harness.orchestrator.fireRetry('1');
      assert.equal(harness.orchestrator.getState().claimed.has('1'), false);
      assert.equal(harness.backend.startCalls.length, 1);
    } finally {
      await harness.cleanup();
    }
  });
});

describe('reconciliation', () => {
  it('is a no-op when nothing is running', async () => {
    const harness = await makeHarness({
      issues: [],
      handler: () => success(),
    });
    try {
      await harness.orchestrator.start();
      const callsBefore = harness.tracker.idCalls.length;
      await harness.orchestrator.tick();
      assert.equal(harness.tracker.idCalls.length, callsBefore);
    } finally {
      await harness.cleanup();
    }
  });

  it('updates the running snapshot when the issue is still active', async () => {
    const gate = new Deferred<void>();
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1', state: 'open' })],
      handler: async () => {
        await gate.promise;
        return success();
      },
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await waitFor(() => harness.orchestrator.getState().running.size === 1, 2_000, 'dispatch');
      harness.tracker.byIds = [makeIssue({ id: '1', identifier: 'A-1', state: 'open', labels: ['refreshed'] })];
      await harness.orchestrator.tick();
      const entry = harness.orchestrator.getState().running.get('1');
      assert.deepEqual(entry?.issue.labels, ['refreshed']);
      assert.equal(entry?.cancel_reason, null);
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it('stops a run without cleanup when the issue leaves the active states', async () => {
    const gate = new Deferred<void>();
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1', state: 'open' })],
      handler: async () => {
        await gate.promise;
        return success();
      },
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await waitFor(
        () => harness.orchestrator.getState().running.get('1')?.workspace_path !== null,
        2_000,
        'workspace preparation',
      );
      const entry = harness.orchestrator.getState().running.get('1');
      const workspacePath = entry?.workspace_path ?? '';
      assert.ok(workspacePath !== '');

      harness.tracker.byIds = [makeIssue({ id: '1', identifier: 'A-1', state: 'backlog' })];
      await harness.orchestrator.tick();
      assert.equal(entry?.cancel_reason, 'not_active');
      await harness.orchestrator.drain();
      assert.equal(existsSync(workspacePath), true, 'workspace must be preserved for non-terminal states');
      assert.equal(harness.orchestrator.getState().claimed.has('1'), false);
      assert.equal(harness.orchestrator.getState().retry_attempts.size, 0);
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it('stops a run and cleans the workspace when the issue becomes terminal', async () => {
    const gate = new Deferred<void>();
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1', state: 'open' })],
      handler: async () => {
        await gate.promise;
        return success();
      },
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await waitFor(() => harness.orchestrator.getState().running.size === 1, 2_000, 'dispatch');
      const workspacePath = harness.orchestrator.getState().running.get('1')?.workspace_path ?? '';
      harness.tracker.byIds = [makeIssue({ id: '1', identifier: 'A-1', state: 'done' })];
      await harness.orchestrator.tick();
      await harness.orchestrator.drain();
      await waitFor(() => !existsSync(workspacePath), 2_000, 'workspace cleanup');
      assert.equal(harness.orchestrator.getState().claimed.has('1'), false);
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it('terminates a run when the issue is no longer visible', async () => {
    const gate = new Deferred<void>();
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1' })],
      handler: async () => {
        await gate.promise;
        return success();
      },
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await waitFor(() => harness.orchestrator.getState().running.size === 1, 2_000, 'dispatch');
      harness.tracker.byIds = [];
      await harness.orchestrator.tick();
      const entry = harness.orchestrator.getState().running.get('1');
      assert.equal(entry?.cancel_reason, 'not_active');
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it('keeps workers running when the refresh call fails', async () => {
    const gate = new Deferred<void>();
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1' })],
      handler: async () => {
        await gate.promise;
        return success();
      },
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await waitFor(() => harness.orchestrator.getState().running.size === 1, 2_000, 'dispatch');
      harness.tracker.idResult = { ok: false, error: trackerError('tracker_request', 'boom') };
      await harness.orchestrator.tick();
      const entry = harness.orchestrator.getState().running.get('1');
      assert.equal(entry?.cancel_reason, null, 'a failed refresh must not kill workers');
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it('kills a stalled session and schedules a retry', async () => {
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1' })],
      handler: () => new Promise<AgentTurnResult>(() => undefined),
      frontMatter: 'codex:\n  stall_timeout_ms: 60\nagent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await waitFor(() => harness.orchestrator.getState().running.size === 1, 2_000, 'dispatch');
      await new Promise((resolve) => setTimeout(resolve, 120));
      await harness.orchestrator.tick();
      const retry = harness.orchestrator.getState().retry_attempts.get('1');
      assert.ok(retry);
      assert.match(retry.error ?? '', /stalled/);
      assert.equal(retry.attempt, 1);
    } finally {
      await harness.cleanup();
    }
  });

  it('skips stall detection when the timeout is disabled', async () => {
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1' })],
      handler: () => new Promise<AgentTurnResult>(() => undefined),
      frontMatter: 'codex:\n  stall_timeout_ms: 0\nagent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await waitFor(() => harness.orchestrator.getState().running.size === 1, 2_000, 'dispatch');
      await new Promise((resolve) => setTimeout(resolve, 80));
      await harness.orchestrator.tick();
      assert.equal(harness.orchestrator.getState().retry_attempts.size, 0);
    } finally {
      await harness.cleanup();
    }
  });
});

describe('startup terminal cleanup', () => {
  it('removes workspaces for terminal issues at startup', async () => {
    const dir = await tempDir('symphony-startup-');
    const workspaceRoot = join(dir.path, 'ws');
    const terminal = makeIssue({ id: '9', identifier: 'DONE-9', state: 'done' });
    const harness = await makeHarness({
      issues: [terminal],
      handler: () => success(),
      workspaceRoot,
    });
    try {
      const workspaceDir = join(workspaceRoot, deriveWorkspaceKey('DONE-9'));
      const { mkdir } = await import('node:fs/promises');
      await mkdir(workspaceDir, { recursive: true });
      assert.equal(existsSync(workspaceDir), true);
      await harness.orchestrator.start();
      assert.equal(existsSync(workspaceDir), false);
    } finally {
      await harness.cleanup();
    }
  });

  it('continues startup when the terminal fetch fails', async () => {
    const harness = await makeHarness({ issues: [], handler: () => success() });
    try {
      harness.tracker.stateResult = { ok: false, error: trackerError('tracker_request', 'offline') };
      await harness.orchestrator.start();
      harness.tracker.stateResult = null;
      assert.ok(harness.orchestrator.snapshot().generated_at);
    } finally {
      await harness.cleanup();
    }
  });
});

describe('token and runtime accounting', () => {
  it('accounts absolute usage by delta and delta usage directly', async () => {
    const gate = new Deferred<void>();
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1' })],
      handler: async (context) => {
        // Absolute totals: 100 then 250 reported by the agent.
        context.emit({
          event: 'notification',
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, absolute: true },
          message: 'usage',
        });
        context.emit({
          event: 'notification',
          usage: { input_tokens: 250, output_tokens: 50, total_tokens: 300, absolute: true },
          message: 'usage',
        });
        context.emit({
          event: 'notification',
          usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10, absolute: false },
          message: 'delta',
        });
        await gate.promise;
        return success();
      },
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await waitFor(() => harness.orchestrator.getState().running.size === 1, 2_000, 'dispatch');
      await waitFor(() => harness.orchestrator.getState().codex_totals.total_tokens >= 310, 2_000, 'tokens');
      const totals = harness.orchestrator.getState().codex_totals;
      assert.equal(totals.input_tokens, 255);
      assert.equal(totals.output_tokens, 55);
      assert.equal(totals.total_tokens, 310);
      const session = harness.orchestrator.getState().running.get('1')?.session;
      assert.equal(session?.codex_total_tokens, 310);
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it('accumulates runtime seconds for ended sessions', async () => {
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1' })],
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return success();
      },
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await harness.orchestrator.drain();
      const totals = harness.orchestrator.snapshot().codex_totals;
      assert.ok(totals.seconds_running >= 0.02, `expected some runtime seconds, got ${totals.seconds_running}`);
    } finally {
      await harness.cleanup();
    }
  });

  it('tracks the latest rate-limit payload', async () => {
    const gate = new Deferred<void>();
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1' })],
      handler: async (context) => {
        context.emit({ event: 'notification', rate_limits: { remaining: 42 }, message: 'limits' });
        await gate.promise;
        return success();
      },
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await waitFor(() => harness.orchestrator.snapshot().rate_limits !== null, 2_000, 'rate limits');
      assert.deepEqual(harness.orchestrator.snapshot().rate_limits, { remaining: 42 });
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });
});

describe('runtime snapshot and issue detail', () => {
  it('reports running rows, retry rows and totals', async () => {
    const gate = new Deferred<void>();
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1', url: 'https://tracker/1' })],
      handler: async () => {
        await gate.promise;
        return success();
      },
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await waitFor(
        () => (harness.orchestrator.getState().running.get('1')?.session.turn_count ?? 0) >= 1,
        2_000,
        'turn start',
      );
      const snapshot = harness.orchestrator.snapshot();
      assert.equal(snapshot.counts.running, 1);
      assert.equal(snapshot.counts.retrying, 0);
      const row = snapshot.running[0];
      assert.ok(row);
      assert.equal(row.issue_identifier, 'A-1');
      assert.equal(row.issue_url, 'https://tracker/1');
      assert.equal(row.turn_count, 1);
      assert.equal(row.attempt, null);
      assert.equal(typeof row.session_id, 'string');
      assert.deepEqual(Object.keys(row.tokens).sort(), ['input_tokens', 'output_tokens', 'total_tokens']);
      assert.ok(snapshot.codex_totals.seconds_running >= 0);

      const detail = harness.orchestrator.issueDetail('A-1');
      assert.ok(detail);
      assert.equal(detail.status, 'running');
      assert.equal(detail.running?.turn_count, 1);
      assert.equal(harness.orchestrator.issueDetail('missing'), null);
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it('reports retry rows with due time and error', async () => {
    const harness = await makeHarness({
      issues: [makeIssue({ id: '1', identifier: 'A-1' })],
      handler: () => failure(),
      frontMatter: 'agent:\n  max_turns: 1\n',
    });
    try {
      await harness.orchestrator.start();
      await harness.orchestrator.drain();
      const snapshot = harness.orchestrator.snapshot();
      assert.equal(snapshot.counts.retrying, 1);
      const row = snapshot.retrying[0];
      assert.ok(row);
      assert.equal(row.attempt, 1);
      assert.ok(Date.parse(row.due_at) > Date.now() - 1_000);
      assert.match(row.error ?? '', /agent failed/);
      const detail = harness.orchestrator.issueDetail('A-1');
      assert.equal(detail?.status, 'retrying');
      assert.equal(detail?.retry?.attempt, 1);
    } finally {
      await harness.cleanup();
    }
  });
});

describe('dispatch validation', () => {
  it('refuses to start when the tracker kind is unsupported', async () => {
    const dir = await tempDir('symphony-invalid-');
    const config = makeConfig({
      frontMatter: ['tracker:', '  kind: memory', '  active_states: [open]', '  terminal_states: [done]'].join('\n') +
        `\nworkspace:\n  root: ${yamlPath(join(dir.path, 'ws'))}`,
    });
    const broken = { ...config, tracker: { ...config.tracker, kind: 'jira' } };
    const tracker = new FakeTracker();
    const backend = new StubBackend(() => success());
    const orchestrator = new Orchestrator({
      getSnapshot: () => makeSnapshot(broken, tracker, backend),
      logger,
      autoTimers: false,
    });
    try {
      await assert.rejects(() => orchestrator.start(), /startup validation failed/);
    } finally {
      await orchestrator.stop();
      await dir.cleanup();
    }
  });
});

describe('issue state predicates', () => {
  it('compares states case-insensitively and by configuration', async () => {
    const config = makeConfig();
    assert.equal(isActiveState(makeIssue({ state: 'OPEN' }), config), true);
    assert.equal(isTerminalState(makeIssue({ state: 'Closed' }), config), true);
    assert.equal(isActiveState(makeIssue({ state: 'backlog' }), config), false);
  });
});
