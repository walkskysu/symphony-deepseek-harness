import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { parseWorkflow } from '../src/config/workflow.js';
import { resolveConfig } from '../src/config/config.js';
import { renderTemplate } from '../src/config/template.js';
import { adapterStateDefaults } from '../src/tracker/registry.js';
import { makeIssue, tempDir } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
// Compiled tests live in dist/test, so the repository root is two levels up.
const repoRoot = resolve(here, '..', '..');

async function readExample(relative: string): Promise<string> {
  return readFile(join(repoRoot, relative), 'utf8');
}

describe('shipped example workflows', () => {
  it('parses and validates the GitHub example', async () => {
    const text = await readExample('examples/github/WORKFLOW.md');
    const definition = parseWorkflow(text, 'examples/github/WORKFLOW.md');
    const config = resolveConfig(definition, {
      workflowPath: join(repoRoot, 'examples/github/WORKFLOW.md'),
      env: { GITHUB_TOKEN: 'token' },
      adapterDefaults: adapterStateDefaults,
    });
    assert.equal(config.tracker.kind, 'github');
    assert.equal(config.tracker.provider['repository'], 'octocat/hello-world');
    assert.equal(config.harness.kind, 'dsh');
    assert.deepEqual(config.tracker.active_states, ['todo', 'in-progress']);
    assert.deepEqual(config.tracker.terminal_states, ['done', 'cancelled']);
    assert.equal(config.agent.max_concurrent_agents_by_state['in-progress'], 2);
    assert.equal(config.server.port, 4173);
    assert.match(config.hooks.after_create ?? '', /git clone/);
    assert.match(config.hooks.after_create ?? '', /SYMPHONY_ISSUE_NATIVE_REF/);
    assert.equal(config.hooks.timeout_ms, 600_000);

    const issue = makeIssue({
      identifier: 'octocat/hello-world#42',
      title: 'Fix the flaky login test',
      state: 'todo',
      labels: ['status:todo', 'bug'],
      url: 'https://github.com/octocat/hello-world/issues/42',
      description: 'The test is flaky.',
      priority: 1,
      native_ref: { repository: 'octocat/hello-world', number: 42 },
    });
    const rendered = renderTemplate(definition.prompt_template, { issue, attempt: null });
    assert.match(rendered, /octocat\/hello-world#42/);
    assert.match(rendered, /Fix the flaky login test/);
    assert.match(rendered, /`status:todo`, `bug`/);
    assert.match(rendered, /first run/);
    assert.match(rendered, /symphony\/octocat-hello-world#42/);
  });

  it('parses and validates the memory demo workflow', async () => {
    const text = await readExample('examples/memory/WORKFLOW.md');
    const definition = parseWorkflow(text, 'examples/memory/WORKFLOW.md');
    const dir = await tempDir('symphony-example-');
    try {
      const config = resolveConfig(definition, {
        workflowPath: join(repoRoot, 'examples/memory/WORKFLOW.md'),
        env: { SYMPHONY_DEMO_WORKSPACES: dir.path },
        adapterDefaults: adapterStateDefaults,
      });
      assert.equal(config.tracker.kind, 'memory');
      assert.equal(config.workspace.root, resolve(dir.path));
      assert.equal(config.harness.kind, 'dsh');
      const records = config.tracker.provider['issues'] as Array<Record<string, unknown>>;
      assert.equal(records.length, 2);
      assert.equal(records[1]?.['state'], 'done');

      const rendered = renderTemplate(definition.prompt_template, {
        issue: makeIssue({ identifier: 'DEMO-1', labels: ['bug', 'ci'] }),
        attempt: null,
      });
      assert.match(rendered, /DEMO-1/);
      assert.match(rendered, /`bug`, `ci`/);
    } finally {
      await dir.cleanup();
    }
  });
});
