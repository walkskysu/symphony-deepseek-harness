import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { deriveWorkspaceKey, WorkspaceManager } from '../src/workspace/manager.js';
import { assertInsideRoot, isPathInside, isWindowsReservedName } from '../src/platform/paths.js';
import type { HooksConfig } from '../src/config/config.js';
import { hookEnvironmentForIssue } from '../src/runner/runner.js';
import { logger, makeIssue, tempDir } from './helpers.js';

function hooks(overrides: Partial<HooksConfig> = {}): HooksConfig {
  return {
    after_create: null,
    before_run: null,
    after_run: null,
    before_remove: null,
    timeout_ms: 5_000,
    shell: null,
    ...overrides,
  };
}

/** Run hook scripts with `node -e`, which is portable across test hosts. */
const nodeShell = { file: process.execPath, args: ['-e'] };

function manager(root: string, hookConfig: HooksConfig): WorkspaceManager {
  return new WorkspaceManager({
    workspace: { root },
    hooks: hookConfig,
    logger,
    env: {},
    shell: nodeShell,
  });
}

describe('workspace key derivation', () => {
  it('keeps identifiers that only use allowed characters', () => {
    assert.equal(deriveWorkspaceKey('ABC-123'), 'ABC-123');
    assert.equal(deriveWorkspaceKey('repo_name.v2'), 'repo_name.v2');
  });

  it('sanitizes disallowed characters and appends a stable hash', () => {
    const key = deriveWorkspaceKey('owner/repo#12');
    assert.match(key, /^owner_repo_12_[0-9a-f]{16}$/);
    assert.equal(key, deriveWorkspaceKey('owner/repo#12'));
  });

  it('keeps distinct identifiers that sanitize to the same text collision-resistant', () => {
    const left = deriveWorkspaceKey('a/b');
    const right = deriveWorkspaceKey('a b');
    assert.notEqual(left, right);
    assert.equal(left.replace(/_[0-9a-f]{16}$/, ''), right.replace(/_[0-9a-f]{16}$/, ''));
    assert.match(left, /_[0-9a-f]{16}$/);
    assert.match(right, /_[0-9a-f]{16}$/);
  });

  it('keeps equal issue numbers from different repositories in distinct workspaces', () => {
    const alpha = deriveWorkspaceKey('octo/alpha#1');
    const beta = deriveWorkspaceKey('octo/beta#1');
    assert.notEqual(alpha, beta);
    assert.match(alpha, /^octo_alpha_1_[0-9a-f]{16}$/);
    assert.match(beta, /^octo_beta_1_[0-9a-f]{16}$/);
  });

  it('hashes path-hostile and Windows-reserved names', () => {
    assert.match(deriveWorkspaceKey('.'), /^\._[0-9a-f]{16}$/);
    assert.match(deriveWorkspaceKey('..'), /^\.\._[0-9a-f]{16}$/);
    assert.match(deriveWorkspaceKey('CON'), /^CON_[0-9a-f]{16}$/);
    assert.match(deriveWorkspaceKey('trailing.'), /^trailing\._[0-9a-f]{16}$/);
    assert.equal(isWindowsReservedName('nul'), true);
    assert.equal(isWindowsReservedName('normal'), false);
  });
});

describe('workspace manager', () => {
  it('creates a deterministic workspace directory and reuses it', async () => {
    const dir = await tempDir('symphony-ws-');
    try {
      const ws = manager(dir.path, hooks());
      const first = await ws.ensure('ABC-123');
      assert.equal(first.created_now, true);
      assert.equal(first.path, resolve(join(dir.path, 'ABC-123')));
      assert.equal(existsSync(first.path), true);

      const second = await ws.ensure('ABC-123');
      assert.equal(second.created_now, false);
      assert.equal(second.path, first.path);
    } finally {
      await dir.cleanup();
    }
  });

  it('runs after_create only when the workspace is new', async () => {
    const dir = await tempDir('symphony-hook-');
    try {
      const marker = join(dir.path, 'after-create-count.txt');
      const script = `const fs=require('node:fs');const p=${JSON.stringify(marker)};const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));`;
      const ws = manager(dir.path, hooks({ after_create: script }));
      await ws.ensure('ABC-1');
      await ws.ensure('ABC-1');
      assert.equal(await readFile(marker, 'utf8'), '1');
    } finally {
      await dir.cleanup();
    }
  });

  it('aborts creation and removes the partial directory when after_create fails', async () => {
    const dir = await tempDir('symphony-hookfail-');
    try {
      const ws = manager(dir.path, hooks({ after_create: 'process.exit(3)' }));
      await assert.rejects(() => ws.ensure('ABC-2'), /after_create hook failed/);
      assert.equal(existsSync(join(dir.path, deriveWorkspaceKey('ABC-2'))), false);
    } finally {
      await dir.cleanup();
    }
  });

  it('fails the attempt when before_run fails', async () => {
    const dir = await tempDir('symphony-before-');
    try {
      const ws = manager(dir.path, hooks({ before_run: 'process.exit(7)' }));
      const workspace = await ws.ensure('ABC-3');
      await assert.rejects(() => ws.beforeRun(workspace.path), /before_run hook failed/);
    } finally {
      await dir.cleanup();
    }
  });

  it('ignores after_run failures and times out long hooks', async () => {
    const dir = await tempDir('symphony-after-');
    try {
      const ws = manager(dir.path, hooks({ after_run: 'process.exit(9)' }));
      const workspace = await ws.ensure('ABC-4');
      await ws.afterRun(workspace.path); // must not throw

      const slow = manager(dir.path, hooks({ before_run: 'setTimeout(()=>{}, 5000)', timeout_ms: 120 }));
      const slowWorkspace = await slow.ensure('ABC-5');
      const started = Date.now();
      await assert.rejects(() => slow.beforeRun(slowWorkspace.path), /timeout/);
      assert.ok(Date.now() - started < 4_000, 'hook timeout should cut the wait short');
    } finally {
      await dir.cleanup();
    }
  });

  it('runs before_remove then deletes the directory', async () => {
    const dir = await tempDir('symphony-remove-');
    try {
      const marker = join(dir.path, 'before-remove.txt');
      const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`;
      const ws = manager(dir.path, hooks({ before_remove: script }));
      const workspace = await ws.ensure('ABC-6');
      await ws.remove('ABC-6');
      assert.equal(await readFile(marker, 'utf8'), 'ran');
      assert.equal(existsSync(workspace.path), false);
      await ws.remove('ABC-6'); // removing twice is a no-op
    } finally {
      await dir.cleanup();
    }
  });

  it('replaces a non-directory occupant instead of failing', async () => {
    const dir = await tempDir('symphony-replace-');
    try {
      const target = join(dir.path, deriveWorkspaceKey('ABC-7'));
      await writeFile(target, 'i am a file', 'utf8');
      const ws = manager(dir.path, hooks());
      const workspace = await ws.ensure('ABC-7');
      assert.equal(workspace.created_now, true);
      assert.equal(existsSync(target), true);
    } finally {
      await dir.cleanup();
    }
  });

  it('reports a workspace path outside the root as unusable', async () => {
    const dir = await tempDir('symphony-outside-');
    try {
      const ws = manager(join(dir.path, 'root'), hooks());
      const inside = await ws.ensure('ABC-8');
      assert.equal(await ws.isUsableWorkspace(inside.path), true);
      assert.equal(await ws.isUsableWorkspace(resolve(dir.path, 'elsewhere')), false);
    } finally {
      await dir.cleanup();
    }
  });
});

describe('hook issue context', () => {
  it('exposes the normalized issue and native_ref to hooks', () => {
    const issue = makeIssue({
      id: 'octo/beta#7',
      identifier: 'octo/beta#7',
      title: 'Fix it',
      url: 'https://github.com/octo/beta/issues/7',
      native_ref: { repository: 'octo/beta', number: 7, node_id: 'I_7' },
    });
    assert.deepEqual(hookEnvironmentForIssue(issue), {
      SYMPHONY_ISSUE_ID: 'octo/beta#7',
      SYMPHONY_ISSUE_IDENTIFIER: 'octo/beta#7',
      SYMPHONY_ISSUE_TITLE: 'Fix it',
      SYMPHONY_ISSUE_URL: 'https://github.com/octo/beta/issues/7',
      SYMPHONY_ISSUE_NATIVE_REF: '{"repository":"octo/beta","number":7,"node_id":"I_7"}',
    });
  });

  it('omits optional issue context that is absent', () => {
    const environment = hookEnvironmentForIssue(makeIssue({ native_ref: null, url: null }));
    assert.equal(environment['SYMPHONY_ISSUE_NATIVE_REF'], undefined);
    assert.equal(environment['SYMPHONY_ISSUE_URL'], undefined);
  });
});

describe('path containment', () => {
  it('accepts the root and descendants only', () => {
    assert.equal(isPathInside('/ws', '/ws'), true);
    assert.equal(isPathInside('/ws', '/ws/a/b'), true);
    assert.equal(isPathInside('/ws', '/ws-other/a'), false);
    assert.equal(isPathInside('/ws', '/etc/passwd'), false);
    assert.equal(isPathInside('/ws', '/ws/../escape'), false);
  });

  it('throws for paths outside the root', () => {
    assert.throws(() => assertInsideRoot('/ws', '/ws/../outside'), /escapes workspace root/);
    assert.doesNotThrow(() => assertInsideRoot('/ws', '/ws/child'));
  });
});
