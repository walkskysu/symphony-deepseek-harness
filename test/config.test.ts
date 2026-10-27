import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { resolveConfig, expandPath, resolveEnvReference, normalizeState } from '../src/config/config.js';
import { parseWorkflow } from '../src/config/workflow.js';
import { ValidationError } from '../src/domain/errors.js';
import { makeConfig, workflowText } from './helpers.js';

const BASE = ['tracker:', '  kind: memory', '  active_states: [open]', '  terminal_states: [closed]'].join('\n');

describe('config defaults', () => {
  it('applies the documented defaults for omitted optional values', () => {
    const config = makeConfig({ frontMatter: BASE });
    assert.equal(config.polling.interval_ms, 30_000);
    assert.equal(config.hooks.timeout_ms, 60_000);
    assert.equal(config.hooks.after_create, null);
    assert.equal(config.agent.max_concurrent_agents, 10);
    assert.equal(config.agent.max_turns, 20);
    assert.equal(config.agent.max_retry_backoff_ms, 300_000);
    assert.deepEqual(config.agent.max_concurrent_agents_by_state, {});
    assert.equal(config.codex.command, 'codex app-server');
    assert.equal(config.codex.turn_timeout_ms, 3_600_000);
    assert.equal(config.codex.read_timeout_ms, 5_000);
    assert.equal(config.codex.stall_timeout_ms, 300_000);
    assert.equal(config.tracker.required_labels.length, 0);
    assert.equal(config.server.port, null);
    assert.equal(config.server.host, '127.0.0.1');
    assert.deepEqual(config.tracker.active_states, ['open']);
    assert.deepEqual(config.tracker.terminal_states, ['closed']);
    assert.equal(config.harness.kind, 'codex');
  });

  it('defaults the workspace root under the system temp directory', () => {
    const config = makeConfig({ frontMatter: BASE });
    assert.equal(config.workspace.root, resolve(tmpdir(), 'symphony_workspaces'));
  });
});

describe('path and environment resolution', () => {
  it('expands ~ and resolves relative paths against the workflow directory', () => {
    const config = makeConfig({
      frontMatter: `${BASE}\nworkspace:\n  root: ~/symphony-ws`,
      workflowPath: resolve('/project', 'WORKFLOW.md'),
    });
    assert.equal(config.workspace.root, resolve(homedir(), 'symphony-ws'));

    const relative = makeConfig({
      frontMatter: `${BASE}\nworkspace:\n  root: ./.workspaces`,
      workflowPath: resolve('/project', 'WORKFLOW.md'),
    });
    assert.equal(relative.workspace.root, resolve('/project', '.workspaces'));
  });

  it('resolves $VAR indirection for workspace.root', () => {
    const config = makeConfig({
      frontMatter: `${BASE}\nworkspace:\n  root: $SYMPHONY_TEST_ROOT`,
      env: { SYMPHONY_TEST_ROOT: resolve('/var', 'ws') },
      workflowPath: resolve('/project', 'WORKFLOW.md'),
    });
    assert.equal(config.workspace.root, resolve('/var', 'ws'));
  });

  it('fails validation when a referenced environment variable is unset', () => {
    assert.throws(
      () =>
        makeConfig({
          frontMatter: `${BASE}\nworkspace:\n  root: $MISSING_ROOT_VAR`,
          env: {},
        }),
      (error: unknown) => error instanceof ValidationError && error.problems.some((p) => p.code === 'missing_workspace_root'),
    );
  });

  it('expands embedded variables in path values but not arbitrary commands', () => {
    assert.equal(expandPath('$HOME/sub', '/base', { HOME: '/home/user' }), resolve('/home/user/sub'));
    const config = makeConfig({
      frontMatter: `${BASE}\ncodex:\n  command: echo $HOME app-server`,
      env: { HOME: '/home/user' },
    });
    assert.equal(config.codex.command, 'echo $HOME app-server');
  });

  it('resolves a whole-value $VAR in codex.command', () => {
    const config = makeConfig({
      frontMatter: `${BASE}\ncodex:\n  command: $MY_CODEX`,
      env: { MY_CODEX: 'node fake-codex.js' },
    });
    assert.equal(config.codex.command, 'node fake-codex.js');
  });

  it('treats an empty environment value as missing for indirection', () => {
    assert.equal(resolveEnvReference('$EMPTY', { EMPTY: '' }), null);
    assert.equal(resolveEnvReference('plain', {}), 'plain');
    assert.throws(
      () => makeConfig({ frontMatter: `${BASE}\nworkspace:\n  root: $EMPTY`, env: { EMPTY: '' } }),
      ValidationError,
    );
  });
});

describe('value coercion and validation', () => {
  it('normalizes per-state concurrency keys and ignores invalid entries', () => {
    const config = makeConfig({
      frontMatter: [
        BASE,
        'agent:',
        '  max_concurrent_agents_by_state:',
        '    "  In Progress ": 2',
        '    Blocked: 0',
        '    Weird: nope',
        '    Also: -1',
      ].join('\n'),
    });
    assert.deepEqual(config.agent.max_concurrent_agents_by_state, { 'in progress': 2 });
  });

  it('lowercases and trims required labels', () => {
    const config = makeConfig({
      frontMatter: [
        'tracker:',
        '  kind: memory',
        '  active_states: [open]',
        '  terminal_states: [closed]',
        '  required_labels: [" Symphony ", "BUG"]',
      ].join('\n'),
    });
    assert.deepEqual(config.tracker.required_labels, ['symphony', 'bug']);
  });

  it('rejects invalid agent tuning values', () => {
    for (const frontMatter of [
      `${BASE}\nagent:\n  max_turns: 0`,
      `${BASE}\nagent:\n  max_concurrent_agents: -3`,
      `${BASE}\nagent:\n  max_retry_backoff_ms: huge`,
    ]) {
      assert.throws(() => makeConfig({ frontMatter }), ValidationError, frontMatter);
    }
  });

  it('rejects an invalid hook timeout', () => {
    assert.throws(
      () => makeConfig({ frontMatter: `${BASE}\nhooks:\n  timeout_ms: -1` }),
      (error: unknown) => error instanceof ValidationError && error.problems.some((p) => p.code === 'invalid_integer'),
    );
  });

  it('requires state lists when the selected adapter documents no defaults', () => {
    assert.throws(
      () =>
        makeConfig({
          frontMatter: [
            'tracker:',
            '  kind: github',
            '  provider:',
            '    repository: octo/repo',
            '    state_source: labels',
            '    label_prefix: "status:"',
          ].join('\n'),
          env: { GITHUB_TOKEN: 'x' },
        }),
      (error: unknown) =>
        error instanceof ValidationError &&
        error.problems.some((p) => p.code === 'missing_active_states') &&
        error.problems.some((p) => p.code === 'missing_terminal_states'),
    );
  });

  it('applies adapter-documented state defaults (memory)', () => {
    const config = makeConfig({ frontMatter: 'tracker:\n  kind: memory' });
    assert.deepEqual(config.tracker.active_states, ['open']);
    assert.deepEqual(config.tracker.terminal_states, ['closed']);
  });

  it('keeps codex policy fields as pass-through strings', () => {
    const config = makeConfig({
      frontMatter: `${BASE}\ncodex:\n  approval_policy: on-request\n  thread_sandbox: workspace-write\n  turn_sandbox_policy: read-only`,
    });
    assert.equal(config.codex.approval_policy, 'on-request');
    assert.equal(config.codex.thread_sandbox, 'workspace-write');
    assert.equal(config.codex.turn_sandbox_policy, 'read-only');
  });

  it('exposes the server port and rejects out-of-range values', () => {
    assert.equal(makeConfig({ frontMatter: `${BASE}\nserver:\n  port: 0` }).server.port, 0);
    assert.throws(() => makeConfig({ frontMatter: `${BASE}\nserver:\n  port: 99999` }), ValidationError);
  });

  it('accepts only codex and dsh as harness kinds', () => {
    assert.equal(makeConfig({ frontMatter: `${BASE}\nharness:\n  kind: dsh` }).harness.kind, 'dsh');
    assert.throws(
      () => makeConfig({ frontMatter: `${BASE}\nharness:\n  kind: claude` }),
      (error: unknown) => error instanceof ValidationError && error.problems.some((p) => p.code === 'unsupported_harness_kind'),
    );
  });

  it('resolves a harness.command from a whole-value environment reference', () => {
    const config = makeConfig({
      frontMatter: `${BASE}\nharness:\n  kind: dsh\n  command: $MY_DSH`,
      env: { MY_DSH: 'C:/tools/dsh.cmd' },
    });
    assert.equal(config.harness.command, 'C:/tools/dsh.cmd');
  });

  it('parses harness.env for the agent process', () => {
    const config = makeConfig({
      frontMatter: `${BASE}\nharness:\n  kind: dsh\n  env:\n    DSH_PERMISSION_MODE: danger-full-access\n    MODE_FROM_ENV: $SOME_MODE`,
      env: { SOME_MODE: 'from-env' },
    });
    assert.deepEqual(config.harness.env, {
      DSH_PERMISSION_MODE: 'danger-full-access',
      MODE_FROM_ENV: 'from-env',
    });
  });

  it('rejects a non-mapping harness.env', () => {
    assert.throws(
      () => makeConfig({ frontMatter: `${BASE}\nharness:\n  kind: dsh\n  env: nope` }),
      (error: unknown) => error instanceof ValidationError && error.problems.some((p) => p.code === 'invalid_harness_env'),
    );
  });

  it('rejects a harness.command that references an unset variable', () => {
    assert.throws(
      () => makeConfig({ frontMatter: `${BASE}\nharness:\n  kind: dsh\n  command: $MISSING_CMD`, env: {} }),
      (error: unknown) =>
        error instanceof ValidationError &&
        error.problems.some((p) => p.code === 'missing_harness_command' && /MISSING_CMD/.test(p.message)),
    );
  });

  it('defaults the dsh command to `dsh` and keeps harness args', () => {
    const config = makeConfig({
      frontMatter: `${BASE}\nharness:\n  kind: dsh\n  args: ["--profile", "headless"]\n  model: deepseek-chat`,
    });
    assert.equal(config.harness.command, 'dsh');
    assert.deepEqual(config.harness.args, ['--profile', 'headless']);
    assert.equal(config.harness.model, 'deepseek-chat');
  });

  it('normalizes states for scheduler comparison only', () => {
    const config = makeConfig({
      frontMatter: [
        'tracker:',
        '  kind: memory',
        '  active_states: [" In Progress "]',
        '  terminal_states: [Done]',
      ].join('\n'),
    });
    assert.deepEqual(config.tracker.active_states, ['In Progress']);
    assert.equal(normalizeState(' In PROGRESS '), 'in progress');
  });

  it('ignores unknown top-level keys for forward compatibility', () => {
    const config = makeConfig({ frontMatter: `${BASE}\nfuture_extension:\n  anything: true` });
    assert.equal(config.tracker.kind, 'memory');
  });
});

describe('adapter-documented state defaults', () => {
  it('falls back to adapter defaults when the adapter documents them', async () => {
    const { adapterStateDefaults } = await import('../src/tracker/registry.js');
    const definition = parseWorkflow(
      workflowText('tracker:\n  kind: github\n  provider:\n    repository: octo/repo\n    token: $TOKEN'),
    );
    const config = resolveConfig(definition, {
      workflowPath: resolve('/x', 'WORKFLOW.md'),
      env: { TOKEN: 'x' },
      adapterDefaults: adapterStateDefaults,
    });
    assert.deepEqual(config.tracker.active_states, ['open']);
    assert.deepEqual(config.tracker.terminal_states, ['closed']);
  });

  it('does not invent defaults for label-based GitHub states', async () => {
    const { adapterStateDefaults } = await import('../src/tracker/registry.js');
    const definition = parseWorkflow(
      workflowText('tracker:\n  kind: github\n  provider:\n    repository: octo/repo\n    state_source: labels\n    label_prefix: "status:"'),
    );
    assert.throws(
      () =>
        resolveConfig(definition, {
          workflowPath: resolve('/x', 'WORKFLOW.md'),
          env: { GITHUB_TOKEN: 'x' },
          adapterDefaults: adapterStateDefaults,
        }),
      (error: unknown) => error instanceof ValidationError,
    );
  });
});
