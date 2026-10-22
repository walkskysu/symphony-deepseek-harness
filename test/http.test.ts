import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startHttpServer, type RunningHttpServer } from '../src/server/http.js';
import type { RuntimeSnapshot } from '../src/observability/snapshot.js';
import { logger } from './helpers.js';

const snapshot: RuntimeSnapshot = {
  generated_at: '2026-02-24T20:15:30.000Z',
  counts: { running: 1, retrying: 1 },
  running: [
    {
      issue_id: '1',
      issue_identifier: 'MT-649',
      issue_url: 'https://tracker/MT-649',
      state: 'In Progress',
      session_id: 'thread-1-turn-1',
      turn_count: 7,
      last_event: 'turn_completed',
      last_message: '',
      started_at: '2026-02-24T20:10:12.000Z',
      last_event_at: '2026-02-24T20:14:59.000Z',
      tokens: { input_tokens: 1200, output_tokens: 800, total_tokens: 2000 },
      attempt: null,
      workspace_path: '/ws/MT-649',
      phase: 'StreamingTurn',
    },
  ],
  retrying: [
    {
      issue_id: '2',
      issue_identifier: 'MT-650',
      issue_url: null,
      attempt: 3,
      due_at: '2026-02-24T20:16:00.000Z',
      error: 'no available orchestrator slots',
      continuation: false,
    },
  ],
  codex_totals: { input_tokens: 5000, output_tokens: 2400, total_tokens: 7400, seconds_running: 1834.2 },
  rate_limits: null,
  poll_interval_ms: 30000,
  max_concurrent_agents: 10,
  completed_count: 2,
  last_tick_at: '2026-02-24T20:15:00.000Z',
  last_error: null,
};

interface Harness {
  server: RunningHttpServer;
  base: string;
  refreshCalls: number;
  cleanup: () => Promise<void>;
}

async function startServer(options: { withSnapshot?: boolean } = {}): Promise<Harness> {
  let refreshCalls = 0;
  const server = await startHttpServer(
    {
      logger,
      workflowPath: () => '/repo/WORKFLOW.md',
      snapshot: () => (options.withSnapshot === false ? null : snapshot),
      issueDetail: (identifier) =>
        identifier === 'MT-649'
          ? {
              issue_identifier: 'MT-649',
              issue_id: '1',
              status: 'running',
              workspace: { path: '/ws/MT-649' },
              attempts: { restart_count: 1, current_retry_attempt: null },
              running: {
                session_id: 'thread-1-turn-1',
                turn_count: 7,
                state: 'In Progress',
                started_at: '2026-02-24T20:10:12.000Z',
                last_event: 'notification',
                last_message: 'Working on tests',
                last_event_at: '2026-02-24T20:14:59.000Z',
                tokens: { input_tokens: 1200, output_tokens: 800, total_tokens: 2000 },
              },
              retry: null,
              logs: { codex_session_logs: [] },
              recent_events: [],
              last_error: null,
              tracked: {},
            }
          : null,
      requestRefresh: () => {
        refreshCalls += 1;
        return { queued: true, coalesced: false };
      },
    },
    { port: 0, host: '127.0.0.1' },
  );
  return {
    server,
    base: server.url,
    get refreshCalls() {
      return refreshCalls;
    },
    cleanup: async () => {
      await server.close();
    },
  };
}

describe('http extension', () => {
  it('serves the dashboard at /', async () => {
    const harness = await startServer();
    try {
      const response = await fetch(`${harness.base}/`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      const html = await response.text();
      assert.match(html, /Symphony/);
      assert.match(html, /MT-649/);
      assert.match(html, /MT-650/);
    } finally {
      await harness.cleanup();
    }
  });

  it('serves the runtime snapshot at /api/v1/state', async () => {
    const harness = await startServer();
    try {
      const response = await fetch(`${harness.base}/api/v1/state`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, unknown>;
      assert.deepEqual(body['counts'], { running: 1, retrying: 1 });
      assert.equal((body['running'] as unknown[]).length, 1);
      const totals = body['codex_totals'] as Record<string, unknown>;
      assert.equal(totals['total_tokens'], 7400);
      assert.equal(totals['seconds_running'], 1834.2);
    } finally {
      await harness.cleanup();
    }
  });

  it('reports 503 when the runtime state is not available yet', async () => {
    const harness = await startServer({ withSnapshot: false });
    try {
      const response = await fetch(`${harness.base}/api/v1/state`);
      assert.equal(response.status, 503);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'unavailable');
    } finally {
      await harness.cleanup();
    }
  });

  it('returns issue detail and 404 for unknown identifiers', async () => {
    const harness = await startServer();
    try {
      const found = await fetch(`${harness.base}/api/v1/MT-649`);
      assert.equal(found.status, 200);
      const detail = (await found.json()) as Record<string, unknown>;
      assert.equal(detail['issue_identifier'], 'MT-649');
      assert.equal((detail['running'] as Record<string, unknown>)['turn_count'], 7);

      const missing = await fetch(`${harness.base}/api/v1/MT-999`);
      assert.equal(missing.status, 404);
      const body = (await missing.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'issue_not_found');
    } finally {
      await harness.cleanup();
    }
  });

  it('queues a refresh on POST /api/v1/refresh', async () => {
    const harness = await startServer();
    try {
      const response = await fetch(`${harness.base}/api/v1/refresh`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 202);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body['queued'], true);
      assert.deepEqual(body['operations'], ['poll', 'reconcile']);
      assert.equal(harness.refreshCalls, 1);
    } finally {
      await harness.cleanup();
    }
  });

  it('rejects wrong methods with 405 and an Allow header', async () => {
    const harness = await startServer();
    try {
      const response = await fetch(`${harness.base}/api/v1/state`, { method: 'POST' });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET');
      const refreshGet = await fetch(`${harness.base}/api/v1/refresh`);
      assert.equal(refreshGet.status, 405);
      assert.equal(refreshGet.headers.get('allow'), 'POST');
    } finally {
      await harness.cleanup();
    }
  });

  it('returns a JSON error envelope for unknown routes', async () => {
    const harness = await startServer();
    try {
      const response = await fetch(`${harness.base}/nope`);
      assert.equal(response.status, 404);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'not_found');
    } finally {
      await harness.cleanup();
    }
  });
});
