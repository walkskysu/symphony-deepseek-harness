import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolBridge } from '../src/tools/bridge.js';
import { NullLogger } from '../src/observability/logger.js';
import { ok } from '../src/domain/errors.js';
import type { Issue } from '../src/domain/types.js';
import type { AdapterProfile, PullRequestInput, ToolContext, ToolResult, TrackerAdapter } from '../src/tracker/adapter.js';
import { makeIssue } from './helpers.js';

const PROFILE: AdapterProfile = {
  kind: 'stub',
  display_name: 'Stub',
  required_provider_keys: [],
  optional_provider_keys: {},
  secret_environment_names: [],
  tool_names: ['stub_comment'],
};

interface StubCalls {
  pushes: Array<{ branch: string; workspacePath: string | undefined }>;
  pullRequests: PullRequestInput[];
}

/** Adapter that records the workflow capabilities the bridge routes to it. */
function makeStubAdapter(calls: StubCalls): TrackerAdapter {
  return {
    kind: 'stub',
    profile: PROFILE,
    fetchIssuesByStates: async () => ok([]),
    fetchIssuesByIds: async () => ok([]),
    agentToolSpecs: () => [
      {
        name: 'stub_comment',
        description: 'Post a comment.',
        mutates: true,
        input_schema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
      },
    ],
    secretEnvironmentNames: () => [],
    executeAgentTool: async (name): Promise<ToolResult> => ({ ok: true, output: { tool: name } }),
    pushBranch: async (context: ToolContext, branch: string): Promise<ToolResult> => {
      calls.pushes.push({ branch, workspacePath: context.workspacePath });
      return { ok: true, output: { branch, pushed: true } };
    },
    openPullRequest: async (_context: ToolContext, input: PullRequestInput): Promise<ToolResult> => {
      calls.pullRequests.push(input);
      return { ok: true, output: { url: 'https://example/pr/1', ...input } };
    },
    defaultBaseBranch: () => 'main',
  };
}

async function startBridge(adapter: TrackerAdapter): Promise<{ bridge: ToolBridge; shimDir: string }> {
  const shimDir = join(mkdtempSync(join(tmpdir(), 'symphony-publish-')), '.symphony');
  const bridge = new ToolBridge({ adapter, logger: new NullLogger(), shimDir });
  await bridge.start();
  return { bridge, shimDir };
}

async function invoke(bridge: ToolBridge, token: string, name: string, args: Record<string, unknown>): Promise<{ status: number; body: ToolResult }> {
  const response = await fetch(bridge.url as string, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-symphony-tool-token': token },
    body: JSON.stringify({ name, arguments: args }),
  });
  return { status: response.status, body: (await response.json()) as ToolResult };
}

const issue: Issue = makeIssue({ id: 'octo/repo#7', identifier: 'octo/repo#7' });

describe('publish tools', () => {
  it('advertises push and pull-request tools when the adapter supports them', async () => {
    const { bridge } = await startBridge(makeStubAdapter({ pushes: [], pullRequests: [] }));
    try {
      const names = bridge.tools.map((tool) => tool.name);
      assert.ok(names.includes('workspace_push'), 'push tool advertised');
      assert.ok(names.includes('pull_request_open'), 'PR tool advertised');
      assert.ok(names.includes('stub_comment'), 'adapter tools still advertised');
    } finally {
      await bridge.stop();
    }
  });

  it('does not advertise publish tools for an adapter without them', async () => {
    const adapter = makeStubAdapter({ pushes: [], pullRequests: [] });
    delete adapter.pushBranch;
    delete adapter.openPullRequest;
    const { bridge } = await startBridge(adapter);
    try {
      const names = bridge.tools.map((tool) => tool.name);
      assert.deepEqual(names, ['stub_comment']);
    } finally {
      await bridge.stop();
    }
  });

  it('routes workspace_push with the run workspace and the explicit branch', async () => {
    const calls: StubCalls = { pushes: [], pullRequests: [] };
    const { bridge } = await startBridge(makeStubAdapter(calls));
    try {
      const credential = bridge.createRun(issue, 'C:/ws/octo');
      const result = await invoke(bridge, credential.token, 'workspace_push', { branch: 'symphony/octo-repo-7' });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { ok: true, output: { branch: 'symphony/octo-repo-7', pushed: true } });
      assert.deepEqual(calls.pushes, [{ branch: 'symphony/octo-repo-7', workspacePath: 'C:/ws/octo' }]);
    } finally {
      await bridge.stop();
    }
  });

  it('opens a pull request into the adapter default base when none is given', async () => {
    const calls: StubCalls = { pushes: [], pullRequests: [] };
    const { bridge } = await startBridge(makeStubAdapter(calls));
    try {
      const credential = bridge.createRun(issue, 'C:/ws/octo');
      const result = await invoke(bridge, credential.token, 'pull_request_open', {
        title: 'Fix it',
        body: 'Details',
        branch: 'symphony/octo-repo-7',
      });
      assert.equal(result.status, 200);
      assert.deepEqual(calls.pullRequests, [
        { head: 'symphony/octo-repo-7', base: 'main', title: 'Fix it', body: 'Details' },
      ]);
    } finally {
      await bridge.stop();
    }
  });

  it('honours an explicit base branch and rejects a missing title', async () => {
    const calls: StubCalls = { pushes: [], pullRequests: [] };
    const { bridge } = await startBridge(makeStubAdapter(calls));
    try {
      const credential = bridge.createRun(issue, 'C:/ws/octo');
      await invoke(bridge, credential.token, 'pull_request_open', { title: 'T', base: 'release', branch: 'b' });
      assert.equal(calls.pullRequests[0]?.base, 'release');

      const invalid = await invoke(bridge, credential.token, 'pull_request_open', { branch: 'b' });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.ok, false);
    } finally {
      await bridge.stop();
    }
  });

  it('refuses publish tools when the run has no workspace path', async () => {
    const { bridge } = await startBridge(makeStubAdapter({ pushes: [], pullRequests: [] }));
    try {
      const credential = bridge.createRun(issue);
      const result = await invoke(bridge, credential.token, 'workspace_push', { branch: 'b' });
      assert.equal(result.status, 400);
      if (!result.body.ok) assert.equal(result.body.error.category, 'invalid_context');
    } finally {
      await bridge.stop();
    }
  });

  it('keeps adapter tools working alongside the publish tools', async () => {
    const { bridge } = await startBridge(makeStubAdapter({ pushes: [], pullRequests: [] }));
    try {
      const credential = bridge.createRun(issue, 'C:/ws/octo');
      const result = await invoke(bridge, credential.token, 'stub_comment', { body: 'hi' });
      assert.deepEqual(result.body, { ok: true, output: { tool: 'stub_comment' } });
    } finally {
      await bridge.stop();
    }
  });
});
