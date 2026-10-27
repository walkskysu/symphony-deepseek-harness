import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { SymphonyService } from '../src/service.js';
import { WorkflowError, ValidationError } from '../src/domain/errors.js';
import { ToolBridge } from '../src/tools/bridge.js';
import { createMemoryAdapter } from '../src/tracker/memory.js';
import { NullLogger } from '../src/observability/logger.js';
import { makeIssue, tempDir } from './helpers.js';

const logger = new NullLogger();

function workflowText(extra: string[] = []): string {
  return [
    '---',
    'tracker:',
    '  kind: memory',
    '  active_states: [open]',
    '  terminal_states: [closed]',
    'workspace:',
    '  root: ./ws',
    ...extra,
    '---',
    'Work on {{ issue.identifier }}.',
  ].join('\n');
}

describe('service startup', () => {
  it('loads the workflow and reports a snapshot after one tick', async () => {
    const dir = await tempDir('symphony-service-');
    const workflowPath = await dir.write('WORKFLOW.md', workflowText());
    const service = new SymphonyService({ workflowPath, watch: false, autoTimers: false, logger });
    try {
      await service.start();
      const snapshot = service.snapshot();
      assert.ok(snapshot);
      assert.equal(snapshot.counts.running, 0);
      assert.equal(service.config?.tracker.kind, 'memory');
      assert.equal(service.httpUrl, null);
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });

  it('fails startup when the workflow file is missing', async () => {
    const dir = await tempDir('symphony-service-');
    const service = new SymphonyService({
      workflowPath: join(dir.path, 'WORKFLOW.md'),
      watch: false,
      logger,
    });
    try {
      await assert.rejects(
        () => service.start(),
        (error: unknown) => error instanceof WorkflowError && error.code === 'missing_workflow_file',
      );
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });

  it('fails startup when the tracker kind is unsupported', async () => {
    const dir = await tempDir('symphony-service-');
    const workflowPath = await dir.write(
      'WORKFLOW.md',
      ['---', 'tracker:', '  kind: linear', '  active_states: [open]', '  terminal_states: [done]', '---', 'Body'].join('\n'),
    );
    const service = new SymphonyService({ workflowPath, watch: false, logger });
    try {
      await assert.rejects(
        () => service.start(),
        (error: unknown) => error instanceof ValidationError && error.problems.some((p) => p.code === 'unsupported_tracker_kind'),
      );
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });

  it('fails startup when the agent command is empty', async () => {
    const dir = await tempDir('symphony-service-');
    const workflowPath = await dir.write(
      'WORKFLOW.md',
      ['---', 'tracker:', '  kind: memory', 'harness:', '  kind: dsh', '  command: ""', '---', 'Body'].join('\n'),
    );
    const service = new SymphonyService({ workflowPath, watch: false, logger });
    try {
      await assert.rejects(() => service.start(), ValidationError);
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });

  it('keeps running without tracker tools when the tool bridge cannot start', async () => {
    const dir = await tempDir('symphony-bridge-fail-');
    // A file where the shim directory should be makes the bridge fail to start.
    await mkdir(join(dir.path, 'ws'), { recursive: true });
    await writeFile(join(dir.path, 'ws', '.symphony'), 'occupied', 'utf8');
    const workflowPath = await dir.write('WORKFLOW.md', workflowText());
    const service = new SymphonyService({ workflowPath, cwd: dir.path, watch: false, autoTimers: false, logger });
    try {
      await service.start();
      assert.equal(service.toolBridgeUrl, null, 'the bridge must not report a usable endpoint');
      assert.equal(service.config?.tracker.kind, 'memory');
      assert.ok(service.snapshot());
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });

  it('serves the HTTP API when a port is configured', async () => {
    const dir = await tempDir('symphony-service-');
    const workflowPath = await dir.write('WORKFLOW.md', workflowText());
    const service = new SymphonyService({ workflowPath, watch: false, autoTimers: false, port: 0, logger });
    try {
      await service.start();
      assert.ok(service.httpUrl);
      const response = await fetch(`${service.httpUrl}/api/v1/state`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { counts: { running: number } };
      assert.equal(body.counts.running, 0);
      const refresh = await fetch(`${service.httpUrl}/api/v1/refresh`, { method: 'POST' });
      assert.equal(refresh.status, 202);
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });
});

describe('workflow reload', () => {
  it('re-applies configuration without a restart', async () => {
    const dir = await tempDir('symphony-reload-');
    const workflowPath = await dir.write('WORKFLOW.md', workflowText());
    const service = new SymphonyService({ workflowPath, watch: false, autoTimers: false, logger });
    try {
      await service.start();
      assert.equal(service.config?.polling.interval_ms, 30_000);

      await writeFile(workflowPath, workflowText(['polling:', '  interval_ms: 1234']), 'utf8');
      await service.reload('test');
      assert.equal(service.config?.polling.interval_ms, 1234);
      assert.equal(service.lastReloadError, null);
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });

  it('reloads prompt changes so the next run uses the new text', async () => {
    const dir = await tempDir('symphony-reload-');
    const workflowPath = await dir.write('WORKFLOW.md', workflowText());
    const service = new SymphonyService({ workflowPath, watch: false, autoTimers: false, logger });
    try {
      await service.start();
      await writeFile(workflowPath, workflowText().replace('Work on {{ issue.identifier }}.', 'New prompt {{ issue.title }}'), 'utf8');
      await service.reloadIfChanged();
      assert.equal(service.lastReloadError, null);
      const snapshot = service.activeOrchestrator?.snapshot();
      assert.ok(snapshot);
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });

  it('keeps the last known good config when a reload has invalid YAML', async () => {
    const dir = await tempDir('symphony-reload-');
    const workflowPath = await dir.write('WORKFLOW.md', workflowText());
    const service = new SymphonyService({ workflowPath, watch: false, autoTimers: false, logger });
    try {
      await service.start();
      await writeFile(workflowPath, '---\ntracker: [broken\n---\nBody\n', 'utf8');
      await service.reload('bad yaml');
      assert.ok(service.lastReloadError !== null);
      assert.match(service.lastReloadError, /invalid YAML/);
      // The last known good config still applies.
      assert.equal(service.config?.tracker.kind, 'memory');
      assert.equal(service.config?.polling.interval_ms, 30_000);
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });

  it('keeps the last known good config when a reload fails validation', async () => {
    const dir = await tempDir('symphony-reload-');
    const workflowPath = await dir.write('WORKFLOW.md', workflowText());
    const service = new SymphonyService({ workflowPath, watch: false, autoTimers: false, logger });
    try {
      await service.start();
      await writeFile(
        workflowPath,
        ['---', 'tracker:', '  kind: memory', '  active_states: [open]', '  terminal_states: [closed]', 'agent:', '  max_turns: 0', '---', 'Body'].join('\n'),
        'utf8',
      );
      await service.reload('invalid config');
      assert.ok(service.lastReloadError !== null);
      assert.equal(service.config?.agent.max_turns, 20);
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });

  it('keeps the tool bridge alive across a prompt-only reload', async () => {
    const dir = await tempDir('symphony-reload-');
    const workflowPath = await dir.write('WORKFLOW.md', workflowText());
    const service = new SymphonyService({ workflowPath, watch: false, autoTimers: false, logger });
    try {
      await service.start();
      const firstUrl = service.toolBridgeUrl;
      assert.ok(firstUrl !== null, 'the memory adapter ships tools, so the bridge should run');

      await writeFile(workflowPath, workflowText().replace('Work on {{ issue.identifier }}.', 'Prompt v2 for {{ issue.identifier }}'), 'utf8');
      await service.reload('prompt only');
      assert.equal(service.lastReloadError, null);
      assert.equal(service.toolBridgeUrl, firstUrl, 'a prompt-only reload must not move the tool endpoint');

      await writeFile(
        workflowPath,
        workflowText(['tracker_extra_ignored: true']).replace(
          '  active_states: [open]',
          '  active_states: [open]\n  required_labels: [symphony]',
        ),
        'utf8',
      );
      await service.reload('tracker changed');
      assert.equal(service.lastReloadError, null);
      assert.ok(service.toolBridgeUrl !== null);
      assert.notEqual(service.toolBridgeUrl, firstUrl, 'a tracker change rebuilds the adapter and bridge');
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });
});

describe('provider-native tool bridge', () => {
  it('executes adapter tools over a token-guarded loopback endpoint', async () => {
    const dir = await tempDir('symphony-bridge-');
    const adapterResult = createMemoryAdapter({
      provider: {
        issues: [
          {
            id: '1',
            identifier: 'DEMO-1',
            title: 'Bridge me',
            state: 'open',
            description: null,
            labels: [],
          },
        ],
      },
      active_states: ['open'],
      terminal_states: ['closed'],
      env: {},
    });
    assert.equal(adapterResult.ok, true);
    if (!adapterResult.ok) return;
    const adapter = adapterResult.value;
    const bridge = new ToolBridge({ adapter, logger, shimDir: resolve(dir.path, '.tools') });
    try {
      await bridge.start();
      assert.ok(bridge.url);
      assert.ok(bridge.shim && existsSync(bridge.shim));

      const issue = makeIssue({ id: '1', identifier: 'DEMO-1' });
      const credential = bridge.createRun(issue);
      // The grant must not be named *TOKEN/*SECRET/*KEY: DSH scrubs those from
      // the agent's child processes, which would strip it before the shim runs.
      assert.ok(credential.env['SYMPHONY_TOOL_GRANT']);
      assert.equal(credential.env['SYMPHONY_TOOL_TOKEN'], undefined);
      assert.equal(credential.env['SYMPHONY_TOOL_ISSUE_ID'], '1');

      const okResponse = await fetch(bridge.url as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-symphony-tool-token': credential.token },
        body: JSON.stringify({ name: 'issue_comment', arguments: { body: 'hello from the agent' } }),
      });
      assert.equal(okResponse.status, 200);
      const body = (await okResponse.json()) as Record<string, unknown>;
      assert.equal(body['ok'], true);
      assert.equal(
        (adapter as unknown as { comments: Array<{ body: string }> }).comments.length,
        1,
      );

      const unauthorized = await fetch(bridge.url as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-symphony-tool-token': 'wrong' },
        body: JSON.stringify({ name: 'issue_comment', arguments: { body: 'x' } }),
      });
      assert.equal(unauthorized.status, 401);

      bridge.releaseRun(credential.token);
      const revoked = await fetch(bridge.url as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-symphony-tool-token': credential.token },
        body: JSON.stringify({ name: 'issue_comment', arguments: { body: 'x' } }),
      });
      assert.equal(revoked.status, 401);
    } finally {
      await bridge.stop();
      await dir.cleanup();
    }
  });

  it('returns a structured failure for invalid tool arguments', async () => {
    const dir = await tempDir('symphony-bridge-bad-');
    const adapterResult = createMemoryAdapter({
      provider: { issues: [{ id: '1', identifier: 'DEMO-1', title: 'T', state: 'open' }] },
      active_states: ['open'],
      terminal_states: ['closed'],
      env: {},
    });
    if (!adapterResult.ok) throw new Error('adapter failed');
    const bridge = new ToolBridge({ adapter: adapterResult.value, logger, shimDir: join(dir.path, 'tools') });
    try {
      await bridge.start();
      const credential = bridge.createRun(makeIssue({ id: '1', identifier: 'DEMO-1' }));
      const response = await fetch(bridge.url as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-symphony-tool-token': credential.token },
        body: JSON.stringify({ name: 'issue_comment', arguments: {} }),
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { ok: boolean; error: { category: string } };
      assert.equal(body.ok, false);
    } finally {
      await bridge.stop();
      await dir.cleanup();
    }
  });
});

describe('github credentials via .env', () => {
  /** A GitHub workflow pointed at a closed local port: config validates, no network. */
  function githubWorkflow(): string {
    return [
      '---',
      'tracker:',
      '  kind: github',
      '  provider:',
      '    repository: octo/repo',
      '    token: $GITHUB_TOKEN',
      '    api_base: http://127.0.0.1:1',
      '  active_states: [open]',
      '  terminal_states: [closed]',
      'workspace:',
      '  root: ./ws',
      '---',
      'Work on {{ issue.identifier }}.',
    ].join('\n');
  }

  it('starts with GITHUB_TOKEN supplied only by .env', async () => {
    const dir = await tempDir('symphony-env-service-');
    const workflowPath = await dir.write('WORKFLOW.md', githubWorkflow());
    await dir.write('.env', '# local secrets\nGITHUB_TOKEN=github_pat_from_env_file\n');
    const service = new SymphonyService({ workflowPath, cwd: dir.path, watch: false, autoTimers: false, logger, env: {} });
    try {
      await service.start();
      assert.ok(service.envFile?.endsWith('.env'));
      assert.deepEqual(service.envFileVariables, ['GITHUB_TOKEN']);
      assert.equal(service.config?.tracker.kind, 'github');
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });

  it('fails startup when neither .env nor the environment provides a token', async () => {
    const dir = await tempDir('symphony-env-service-');
    const workflowPath = await dir.write('WORKFLOW.md', githubWorkflow());
    const service = new SymphonyService({ workflowPath, cwd: dir.path, watch: false, autoTimers: false, logger, env: {} });
    try {
      await assert.rejects(
        () => service.start(),
        (error: unknown) =>
          error instanceof ValidationError && error.problems.some((p) => p.code === 'missing_tracker_secret'),
      );
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });

  it('honours an explicit --env-file path', async () => {
    const dir = await tempDir('symphony-env-service-');
    const workflowPath = await dir.write('WORKFLOW.md', githubWorkflow());
    const secrets = await dir.write(join('secrets', 'github.env'), 'GITHUB_TOKEN=github_pat_explicit\n');
    const service = new SymphonyService({
      workflowPath,
      cwd: dir.path,
      watch: false,
      autoTimers: false,
      logger,
      env: {},
      envFile: secrets,
    });
    try {
      await service.start();
      assert.equal(service.envFile, resolve(secrets));
      assert.deepEqual(service.envFileVariables, ['GITHUB_TOKEN']);
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });

  it('lets the launch environment win over .env', async () => {
    const dir = await tempDir('symphony-env-service-');
    const workflowPath = await dir.write('WORKFLOW.md', githubWorkflow());
    await dir.write('.env', 'GITHUB_TOKEN=file_token\nOTHER=file_only\n');
    const service = new SymphonyService({
      workflowPath,
      cwd: dir.path,
      watch: false,
      autoTimers: false,
      logger,
      env: { GITHUB_TOKEN: 'environment_token' },
    });
    try {
      await service.start();
      assert.deepEqual(service.envFileVariables, ['OTHER']);
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });

  it('can ignore .env entirely', async () => {
    const dir = await tempDir('symphony-env-service-');
    const workflowPath = await dir.write('WORKFLOW.md', githubWorkflow());
    await dir.write('.env', 'GITHUB_TOKEN=file_token\n');
    const service = new SymphonyService({
      workflowPath,
      cwd: dir.path,
      watch: false,
      autoTimers: false,
      logger,
      env: {},
      envFileDisabled: true,
    });
    try {
      await assert.rejects(() => service.start(), ValidationError);
      assert.equal(service.envFile, null);
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });

  it('rebuilds the adapter when the token in .env changes', async () => {
    const dir = await tempDir('symphony-env-service-');
    const workflowPath = await dir.write('WORKFLOW.md', githubWorkflow());
    await dir.write('.env', 'GITHUB_TOKEN=first_token\n');
    const service = new SymphonyService({ workflowPath, cwd: dir.path, watch: false, autoTimers: false, logger, env: {} });
    try {
      await service.start();
      const firstBridge = service.toolBridgeUrl;
      assert.ok(firstBridge !== null);

      await dir.write('.env', 'GITHUB_TOKEN=rotated_token\n');
      await service.reload('token rotated');
      assert.equal(service.lastReloadError, null);
      assert.notEqual(service.toolBridgeUrl, firstBridge, 'a rotated credential must not reuse the old adapter');
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });
});

describe('memory tracker adapter', () => {
  it('serves issues by state and by id', async () => {
    const adapter = createMemoryAdapter({
      provider: {
        issues: [
          { id: '1', identifier: 'A-1', title: 'One', state: 'open' },
          { id: '2', identifier: 'B-2', title: 'Two', state: 'closed' },
        ],
      },
      active_states: ['open'],
      terminal_states: ['closed'],
      env: {},
    });
    if (!adapter.ok) throw new Error('adapter failed');
    const tracker = adapter.value;
    const active = await tracker.fetchIssuesByStates(['open']);
    assert.equal(active.ok, true);
    if (!active.ok) return;
    assert.deepEqual(active.value.map((issue) => issue.identifier), ['A-1']);
    const byId = await tracker.fetchIssuesByIds(['2', 'missing']);
    assert.equal(byId.ok, true);
    if (!byId.ok) return;
    assert.deepEqual(byId.value.map((issue) => issue.identifier), ['B-2']);
  });

  it('refuses malformed records on an id refresh', async () => {
    const adapter = createMemoryAdapter({
      provider: { issues: [{ id: '1', title: 'no identifier', state: 'open' }] },
      active_states: ['open'],
      terminal_states: ['closed'],
      env: {},
    });
    if (!adapter.ok) throw new Error('adapter failed');
    const result = await adapter.value.fetchIssuesByIds(['1']);
    assert.equal(result.ok, false);
  });
});
