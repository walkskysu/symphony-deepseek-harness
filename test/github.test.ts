import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGitHubAdapter, priorityFromLabels, deriveLabelState } from '../src/tracker/github.js';
import { normalizeLabels, parseInstant, normalizePriority } from '../src/tracker/normalize.js';
import type { TrackerAdapter } from '../src/tracker/adapter.js';
import { makeIssue } from './helpers.js';

interface FakeResponseInit {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  text?: string;
}

function fakeFetch(handler: (url: string) => FakeResponseInit): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    const init = handler(url);
    const status = init.status ?? 200;
    const headers = new Headers(init.headers ?? {});
    const body = init.text ?? (init.body === undefined ? '' : JSON.stringify(init.body));
    return new Response(status === 204 ? null : body, { status, headers });
  }) as typeof fetch;
  return { fetch: impl, urls };
}

async function makeAdapter(
  provider: Record<string, unknown>,
  options: {
    active?: string[];
    terminal?: string[];
    fetch?: typeof fetch;
    onWarning?: (message: string, context?: Record<string, unknown>) => void;
  } = {},
): Promise<TrackerAdapter> {
  const result = createGitHubAdapter({
    provider,
    active_states: options.active ?? ['todo', 'in-progress'],
    terminal_states: options.terminal ?? ['done'],
    env: { GITHUB_TOKEN: 'secret-token' },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
  });
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  return result.value;
}

const issuePayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 12,
  node_id: 'I_12',
  title: 'Ship it',
  body: 'Details',
  state: 'open',
  html_url: 'https://github.com/octo/repo/issues/12',
  labels: [{ name: 'Status:Todo' }, { name: 'P1' }],
  assignee: { login: 'octocat' },
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-01-03T03:04:05Z',
  ...overrides,
});

describe('github normalization helpers', () => {
  it('normalizes labels to lowercase without blanks or duplicates', () => {
    assert.deepEqual(normalizeLabels([' Bug ', 'bug', '', 5, 'URGENT']), ['bug', 'urgent']);
  });

  it('parses instants to ISO strings and rejects garbage', () => {
    assert.equal(parseInstant('2026-01-02T03:04:05Z'), '2026-01-02T03:04:05.000Z');
    assert.equal(parseInstant('not a date'), null);
    assert.equal(parseInstant(12), null);
  });

  it('normalizes priorities', () => {
    assert.equal(normalizePriority(2), 2);
    assert.equal(normalizePriority('3'), 3);
    assert.equal(normalizePriority('high'), null);
  });

  it('maps priority labels', () => {
    assert.equal(priorityFromLabels(['p1']), 1);
    assert.equal(priorityFromLabels(['priority:4']), 4);
    assert.equal(priorityFromLabels(['p10', 'bug']), null);
  });

  it('derives label states from the configured prefix', () => {
    assert.equal(deriveLabelState(['status:in-progress', 'bug'], 'status:'), 'in-progress');
    assert.equal(deriveLabelState(['bug'], 'status:'), null);
  });

  it('resolves several status labels deterministically with state_priority', () => {
    const labels = ['status:todo', 'status:in-progress', 'status:review'];
    // Without a priority list the first label in payload order wins.
    assert.equal(deriveLabelState(labels, 'status:'), 'todo');
    // With one, the highest-priority present state wins.
    assert.equal(deriveLabelState(labels, 'status:', ['done', 'review', 'in-progress', 'todo']), 'review');
    assert.equal(deriveLabelState(labels, 'status:', ['in-progress', 'review']), 'in-progress');
    // States that are neither present nor listed fall back to payload order.
    assert.equal(deriveLabelState(labels, 'status:', ['done', 'cancelled']), 'todo');
    // A single label is unaffected by the priority list.
    assert.equal(deriveLabelState(['status:done'], 'status:', ['review', 'done']), 'done');
  });

  it('prefers the highest-priority status label when normalizing an issue', async () => {
    const { fetch } = fakeFetch(() => ({
      body: issuePayload({ labels: [{ name: 'status:todo' }, { name: 'status:review' }] }),
    }));
    const adapter = await makeAdapter(
      {
        repository: 'octo/repo',
        state_source: 'labels',
        label_prefix: 'status:',
        state_priority: ['done', 'review', 'in-progress', 'todo'],
      },
      { fetch, active: ['todo', 'in-progress'], terminal: ['done'] },
    );
    const result = await adapter.fetchIssuesByIds(['octo/repo#12']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value[0]?.state, 'review');
  });

  it('rejects a non-list state_priority', () => {
    const result = createGitHubAdapter({
      provider: { repository: 'octo/repo', state_priority: 'review' },
      active_states: ['open'],
      terminal_states: ['closed'],
      env: { GITHUB_TOKEN: 'x' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, 'invalid_tracker_config');
  });
});

describe('github adapter configuration', () => {
  it('rejects a missing repository selector', () => {
    const result = createGitHubAdapter({
      provider: {},
      active_states: ['open'],
      terminal_states: ['closed'],
      env: { GITHUB_TOKEN: 'x' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, 'invalid_tracker_config');
  });

  it('reports a missing token as a portable secret error without echoing values', () => {
    const result = createGitHubAdapter({
      provider: { repository: 'octo/repo' },
      active_states: ['open'],
      terminal_states: ['closed'],
      env: {},
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.category, 'missing_tracker_secret');
      assert.match(result.error.message, /GITHUB_TOKEN/);
    }
  });

  it('declares credential environment names for child-process scrubbing', async () => {
    const adapter = await makeAdapter({ repository: 'octo/repo' });
    assert.ok(adapter.secretEnvironmentNames?.().includes('GITHUB_TOKEN'));
  });

  it('publishes the documented adapter profile', async () => {
    const adapter = await makeAdapter({ repository: 'octo/repo' });
    assert.equal(adapter.profile.kind, 'github');
    assert.ok(adapter.profile.tool_names.includes('issue_comment'));
    assert.deepEqual(adapter.profile.default_states, { active_states: ['open'], terminal_states: ['closed'] });
  });

  it('rejects an invalid state_source', () => {
    const result = createGitHubAdapter({
      provider: { repository: 'octo/repo', state_source: 'labels-ish' },
      active_states: ['open'],
      terminal_states: ['closed'],
      env: { GITHUB_TOKEN: 'x' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, 'invalid_tracker_config');
  });
});

describe('github issue reads', () => {
  it('returns empty for an empty state list without calling the provider', async () => {
    const { fetch, urls } = fakeFetch(() => ({ body: [] }));
    const adapter = await makeAdapter({ repository: 'octo/repo' }, { fetch });
    const result = await adapter.fetchIssuesByStates([]);
    assert.deepEqual(result, { ok: true, value: [] });
    assert.equal(urls.length, 0);
  });

  it('returns empty for an empty id list without calling the provider', async () => {
    const { fetch, urls } = fakeFetch(() => ({ body: [] }));
    const adapter = await makeAdapter({ repository: 'octo/repo' }, { fetch });
    const result = await adapter.fetchIssuesByIds([]);
    assert.deepEqual(result, { ok: true, value: [] });
    assert.equal(urls.length, 0);
  });

  it('normalizes a GitHub issue into the stable issue model', async () => {
    const { fetch } = fakeFetch(() => ({ body: [issuePayload()] }));
    const adapter = await makeAdapter({ repository: 'octo/repo', state_source: 'labels', label_prefix: 'status:' }, { fetch });
    const result = await adapter.fetchIssuesByStates(['todo']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.length, 1);
    const issue = result.value[0];
    assert.ok(issue);
    assert.equal(issue.id, 'octo/repo#12');
    assert.equal(issue.identifier, 'octo/repo#12');
    assert.equal(issue.native_ref?.['number'], 12);
    assert.equal(issue.state, 'todo');
    assert.deepEqual(issue.labels, ['status:todo', 'p1']);
    assert.equal(issue.priority, 1);
    assert.equal(issue.assignee_id, 'octocat');
    assert.equal(issue.dispatchable, true);
    assert.equal(issue.created_at, '2026-01-02T03:04:05.000Z');
  });

  it('uses the native issue state when state_source is issue_state', async () => {
    const { fetch } = fakeFetch(() => ({ body: [issuePayload()] }));
    const adapter = await makeAdapter(
      { repository: 'octo/repo' },
      { fetch, active: ['open'], terminal: ['closed'] },
    );
    const result = await adapter.fetchIssuesByStates(['open']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value[0]?.state, 'open');
  });

  it('skips pull requests returned by the issues endpoint', async () => {
    const { fetch } = fakeFetch(() => ({
      body: [issuePayload(), issuePayload({ number: 13, pull_request: { url: 'x' } })],
    }));
    const adapter = await makeAdapter({ repository: 'octo/repo' }, { fetch, active: ['open'], terminal: ['closed'] });
    const result = await adapter.fetchIssuesByStates(['open']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.map((issue) => issue.id), ['octo/repo#12']);
  });

  it('follows Link pagination and preserves order', async () => {
    const { fetch, urls } = fakeFetch((url) => {
      if (url.includes('page=2')) {
        return { body: [issuePayload({ number: 2, title: 'second' })] };
      }
      return {
        body: [issuePayload({ number: 1, title: 'first' })],
        headers: {
          link: '<https://api.github.com/repos/octo/repo/issues?page=2>; rel="next"',
        },
      };
    });
    const adapter = await makeAdapter({ repository: 'octo/repo', api_base: 'https://api.github.com' }, { fetch, active: ['open'], terminal: ['closed'] });
    const result = await adapter.fetchIssuesByStates(['open']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.map((issue) => issue.title), ['first', 'second']);
    assert.equal(urls.length, 2);
  });

  it('detects pagination loops', async () => {
    const { fetch } = fakeFetch(() => ({
      body: [issuePayload()],
      headers: { link: '<https://api.github.com/repos/octo/repo/issues?page=1>; rel="next"' },
    }));
    const adapter = await makeAdapter(
      { repository: 'octo/repo', api_base: 'https://api.github.com' },
      { fetch, active: ['open'], terminal: ['closed'] },
    );
    const result = await adapter.fetchIssuesByStates(['open']);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, 'tracker_pagination');
  });

  it('logs and skips malformed records during a state list read', async () => {
    const warnings: string[] = [];
    const { fetch } = fakeFetch(() => ({
      body: [{ title: 'no id or number' }, issuePayload()],
    }));
    const adapter = await makeAdapter(
      { repository: 'octo/repo' },
      { fetch, active: ['open'], terminal: ['closed'], onWarning: (message) => warnings.push(message) },
    );
    const result = await adapter.fetchIssuesByStates(['open']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.length, 1);
    assert.equal(warnings.length, 1);
  });

  it('fails an id refresh on a malformed requested record instead of omitting it', async () => {
    const { fetch } = fakeFetch(() => ({ body: { title: 'missing identity fields' } }));
    const adapter = await makeAdapter({ repository: 'octo/repo' }, { fetch, active: ['open'], terminal: ['closed'] });
    const result = await adapter.fetchIssuesByIds(['octo/repo#12']);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, 'tracker_response');
  });

  it('omits ids that are no longer visible in scope', async () => {
    const { fetch } = fakeFetch((url) => (url.endsWith('/issues/404') ? { status: 404, text: 'not found' } : { body: issuePayload() }));
    const adapter = await makeAdapter({ repository: 'octo/repo' }, { fetch, active: ['open'], terminal: ['closed'] });
    const result = await adapter.fetchIssuesByIds(['octo/repo#404']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, []);
  });

  it('refuses an unparseable dispatch id on refresh', async () => {
    const { fetch } = fakeFetch(() => ({ body: issuePayload() }));
    const adapter = await makeAdapter({ repository: 'octo/repo' }, { fetch, active: ['open'], terminal: ['closed'] });
    const result = await adapter.fetchIssuesByIds(['not-an-id']);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, 'tracker_response');
  });

  it('maps transport failures, rate limits and HTTP errors to portable categories', async () => {
    const transport = await makeAdapter(
      { repository: 'octo/repo' },
      {
        fetch: (async () => {
          throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch,
        active: ['open'],
        terminal: ['closed'],
      },
    );
    const transportResult = await transport.fetchIssuesByStates(['open']);
    assert.equal(transportResult.ok, false);
    if (!transportResult.ok) assert.equal(transportResult.error.category, 'tracker_request');

    const limited = await makeAdapter(
      { repository: 'octo/repo' },
      {
        fetch: fakeFetch(() => ({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '30' }, text: 'rate limited' })).fetch,
        active: ['open'],
        terminal: ['closed'],
      },
    );
    const limitedResult = await limited.fetchIssuesByStates(['open']);
    assert.equal(limitedResult.ok, false);
    if (!limitedResult.ok) {
      assert.equal(limitedResult.error.category, 'tracker_rate_limited');
      assert.equal(limitedResult.error.retry_after_ms, 30_000);
    }

    const failing = await makeAdapter(
      { repository: 'octo/repo' },
      { fetch: fakeFetch(() => ({ status: 500, text: 'boom' })).fetch, active: ['open'], terminal: ['closed'] },
    );
    const failingResult = await failing.fetchIssuesByStates(['open']);
    assert.equal(failingResult.ok, false);
    if (!failingResult.ok) {
      assert.equal(failingResult.error.category, 'tracker_status');
      assert.equal(failingResult.error.retryable, true);
    }
  });

  it('marks issues undispatched when a required assignee is not set', async () => {
    const { fetch } = fakeFetch(() => ({ body: [issuePayload({ assignee: null, assignees: [] })] }));
    const adapter = await makeAdapter(
      { repository: 'octo/repo', require_assignee: true, assignee: 'octocat' },
      { fetch, active: ['open'], terminal: ['closed'] },
    );
    const result = await adapter.fetchIssuesByStates(['open']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value[0]?.dispatchable, false);
  });
});

describe('github multi-repository scope', () => {
  it('accepts `repositories` without a singular `repository` and reads every scope', async () => {
    const { fetch, urls } = fakeFetch((url) => {
      if (url.includes('/repos/octo/alpha/issues')) {
        return { body: [issuePayload({ number: 1, title: 'alpha issue' })] };
      }
      if (url.includes('/repos/octo/beta/issues')) {
        return { body: [issuePayload({ number: 1, title: 'beta issue' })] };
      }
      return { body: [] };
    });
    const adapter = await makeAdapter(
      { repositories: ['octo/alpha', 'octo/beta'] },
      { fetch, active: ['open'], terminal: ['closed'] },
    );
    const result = await adapter.fetchIssuesByStates(['open']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.value.map((issue) => issue.id),
      ['octo/alpha#1', 'octo/beta#1'],
    );
    assert.deepEqual(
      result.value.map((issue) => issue.native_ref?.['repository']),
      ['octo/alpha', 'octo/beta'],
    );
    assert.equal(urls.filter((url) => url.includes('/repos/octo/alpha/issues')).length, 1);
    assert.equal(urls.filter((url) => url.includes('/repos/octo/beta/issues')).length, 1);
  });

  it('combines `repository` and `repositories` and de-duplicates case-insensitively', async () => {
    const { fetch, urls } = fakeFetch((url) => {
      if (url.includes('/repos/Octo/Alpha/issues')) {
        return { body: [issuePayload({ number: 3, title: 'alpha' })] };
      }
      return { body: [issuePayload({ number: 4, title: 'beta' })] };
    });
    const adapter = await makeAdapter(
      {
        repository: 'Octo/Alpha',
        repositories: ['octo/alpha', 'OCTO/BETA', 'octo/beta'],
      },
      { fetch, active: ['open'], terminal: ['closed'] },
    );
    const result = await adapter.fetchIssuesByStates(['open']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.value.map((issue) => issue.id),
      ['Octo/Alpha#3', 'OCTO/BETA#4'],
    );
    assert.equal(urls.filter((url) => url.includes('/repos/Octo/Alpha/issues')).length, 1);
    assert.equal(urls.filter((url) => url.includes('/repos/OCTO/BETA/issues')).length, 1);
    assert.equal(urls.length, 2);
  });

  it('refreshes ids across repositories and treats repeated ids as a set', async () => {
    const { fetch, urls } = fakeFetch((url) => {
      const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1]);
      return { body: issuePayload({ number, title: url.includes('/alpha/') ? 'alpha' : 'beta' }) };
    });
    const adapter = await makeAdapter(
      { repositories: ['octo/alpha', 'octo/beta'] },
      { fetch, active: ['open'], terminal: ['closed'] },
    );
    const result = await adapter.fetchIssuesByIds(['octo/alpha#2', 'octo/beta#7', 'octo/alpha#2']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.value.map((issue) => issue.id),
      ['octo/alpha#2', 'octo/beta#7'],
    );
    assert.equal(urls.length, 2);
    assert.ok(urls.some((url) => url.endsWith('/repos/octo/alpha/issues/2')));
    assert.ok(urls.some((url) => url.endsWith('/repos/octo/beta/issues/7')));
  });

  it('matches a refresh id case-insensitively against the configured scope', async () => {
    const { fetch, urls } = fakeFetch(() => ({ body: issuePayload({ number: 12 }) }));
    const adapter = await makeAdapter(
      { repository: 'Octo/Repo' },
      { fetch, active: ['open'], terminal: ['closed'] },
    );
    const result = await adapter.fetchIssuesByIds(['octo/repo#12']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value[0]?.id, 'Octo/Repo#12');
    assert.ok(urls[0]?.endsWith('/repos/Octo/Repo/issues/12'));
  });

  it('rejects malformed multi-repository configuration', async () => {
    const invalidProviders: Array<Record<string, unknown>> = [
      { repositories: 'octo/repo' },
      { repositories: ['not-a-repo'] },
      { repositories: [] },
      { repositories: ['octo/repo', 42] },
      { repository: 42, repositories: ['octo/repo'] },
    ];
    for (const provider of invalidProviders) {
      const result = createGitHubAdapter({
        provider,
        active_states: ['open'],
        terminal_states: ['closed'],
        env: { GITHUB_TOKEN: 'x' },
      });
      assert.equal(result.ok, false, JSON.stringify(provider));
      if (!result.ok) assert.equal(result.error.category, 'invalid_tracker_config');
    }
  });
});

describe('github provider-native tools', () => {
  it('advertises tool specs with mutation flags', async () => {
    const adapter = await makeAdapter({ repository: 'octo/repo' });
    const specs = adapter.agentToolSpecs?.() ?? [];
    const comment = specs.find((spec) => spec.name === 'issue_comment');
    assert.ok(comment);
    assert.equal(comment.mutates, true);
    assert.deepEqual(comment.input_schema['required'], ['body']);
  });

  it('executes a tool with the issue context and returns structured output', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const { fetch } = fakeFetch((url) => {
      calls.push({ url, method: 'POST' });
      return { body: { html_url: 'https://github.com/octo/repo/issues/12#c1' } };
    });
    const adapter = await makeAdapter({ repository: 'octo/repo' }, { fetch, active: ['open'], terminal: ['closed'] });
    const issue = {
      id: 'octo/repo#12',
      native_ref: { repository: 'octo/repo', number: 12 },
      identifier: 'octo/repo#12',
      title: 't',
      description: null,
      priority: null,
      state: 'open',
      branch_name: null,
      url: null,
      assignee_id: null,
      labels: [],
      blocked_by: [],
      dispatchable: true,
      created_at: null,
      updated_at: null,
    };
    const result = await adapter.executeAgentTool?.('issue_comment', { body: 'hello' }, { issue });
    assert.deepEqual(result, { ok: true, output: { commented: true, comment_url: 'https://github.com/octo/repo/issues/12#c1' } });
    assert.ok(calls[0]?.url.endsWith('/repos/octo/repo/issues/12/comments'));
  });

  it('routes a tool call to the issue repository, not another configured repository', async () => {
    const calls: string[] = [];
    const { fetch } = fakeFetch((url) => {
      calls.push(url);
      return { body: { html_url: 'https://github.com/octo/beta/issues/7#c1' } };
    });
    const adapter = await makeAdapter(
      { repositories: ['octo/alpha', 'octo/beta'] },
      { fetch, active: ['open'], terminal: ['closed'] },
    );
    const issue = makeIssue({
      id: 'octo/beta#7',
      identifier: 'octo/beta#7',
      native_ref: { repository: 'octo/beta', number: 7 },
    });
    const result = await adapter.executeAgentTool?.('issue_comment', { body: 'hello' }, { issue });
    assert.equal(result?.ok, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.includes('/repos/octo/beta/issues/7/comments'));
    assert.ok(!calls[0]?.includes('/repos/octo/alpha/'));
  });

  it('returns a structured failure for invalid arguments and unknown tools', async () => {
    const adapter = await makeAdapter({ repository: 'octo/repo' });
    const issue = {
      id: 'octo/repo#12',
      native_ref: { repository: 'octo/repo', number: 12 },
      identifier: 'octo/repo#12',
      title: 't',
      description: null,
      priority: null,
      state: 'open',
      branch_name: null,
      url: null,
      assignee_id: null,
      labels: [],
      blocked_by: [],
      dispatchable: true,
      created_at: null,
      updated_at: null,
    };
    const invalid = await adapter.executeAgentTool?.('issue_comment', {}, { issue });
    assert.equal(invalid?.ok, false);
    const unknown = await adapter.executeAgentTool?.('nope', {}, { issue });
    assert.equal(unknown?.ok, false);
    if (unknown !== undefined && unknown.ok === false) assert.equal(unknown.error.category, 'unsupported_tool');
  });
});
