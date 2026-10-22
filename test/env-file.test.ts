import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import {
  loadEnvFile,
  mergeEnv,
  parseEnvFile,
  resolveEnvironment,
} from '../src/config/env-file.js';
import { ValidationError } from '../src/domain/errors.js';
import { tempDir } from './helpers.js';

describe('.env parsing', () => {
  it('parses plain, quoted, exported and commented values', () => {
    const parsed = parseEnvFile(
      [
        '# a comment',
        '',
        'PLAIN=value',
        'export EXPORTED=yes',
        'SPACED = padded ',
        'SINGLE=\'literal $NOT_EXPANDED # not a comment\'',
        'DOUBLE="line1\\nline2 \\"quoted\\" \\\\ done"',
        'INLINE=value # trailing comment',
        'HASHED=abc#def',
        'EMPTY=',
        'DOTTED.KEY=ok',
      ].join('\r\n'),
    );
    assert.deepEqual(parsed.warnings, []);
    assert.equal(parsed.values['PLAIN'], 'value');
    assert.equal(parsed.values['EXPORTED'], 'yes');
    assert.equal(parsed.values['SPACED'], 'padded');
    assert.equal(parsed.values['SINGLE'], 'literal $NOT_EXPANDED # not a comment');
    assert.equal(parsed.values['DOUBLE'], 'line1\nline2 "quoted" \\ done');
    assert.equal(parsed.values['INLINE'], 'value');
    assert.equal(parsed.values['HASHED'], 'abc#def');
    assert.equal(parsed.values['EMPTY'], '');
    assert.equal(parsed.values['DOTTED.KEY'], 'ok');
  });

  it('strips a UTF-8 BOM', () => {
    const parsed = parseEnvFile('\uFEFFTOKEN=abc');
    assert.equal(parsed.values['TOKEN'], 'abc');
  });

  it('reports malformed lines but keeps the usable ones', () => {
    const parsed = parseEnvFile(['NOT_AN_ASSIGNMENT', '1BAD=no', 'GOOD=yes'].join('\n'));
    assert.equal(parsed.values['GOOD'], 'yes');
    assert.equal(parsed.warnings.length, 2);
    assert.equal(parsed.values['1BAD'], undefined);
  });

  it('keeps a quoted value containing an equals sign', () => {
    assert.equal(parseEnvFile('TOKEN="abc=def"').values['TOKEN'], 'abc=def');
  });
});

describe('.env merging', () => {
  it('fills only variables the environment does not define', () => {
    const merged = mergeEnv({ EXISTING: 'env-value' }, { EXISTING: 'file-value', NEW: 'file-new' });
    assert.equal(merged.env['EXISTING'], 'env-value');
    assert.equal(merged.env['NEW'], 'file-new');
    assert.deepEqual(merged.applied, ['NEW']);
  });

  it('treats an explicitly empty environment value as defined (shadows the file)', () => {
    const merged = mergeEnv({ GITHUB_TOKEN: '' }, { GITHUB_TOKEN: 'from-file' });
    assert.equal(merged.env['GITHUB_TOKEN'], '');
    assert.deepEqual(merged.applied, []);
  });

  it('matches environment names case-insensitively on Windows', () => {
    const merged = mergeEnv({ github_token: 'lower' }, { GITHUB_TOKEN: 'upper' }, 'win32');
    assert.equal(merged.env['GITHUB_TOKEN'], undefined);
    assert.deepEqual(merged.applied, []);

    const posix = mergeEnv({ github_token: 'lower' }, { GITHUB_TOKEN: 'upper' }, 'linux');
    assert.equal(posix.env['GITHUB_TOKEN'], 'upper');
    assert.deepEqual(posix.applied, ['GITHUB_TOKEN']);
  });
});

describe('.env discovery', () => {
  it('prefers the .env next to WORKFLOW.md, then falls back to the cwd', async () => {
    const workflowDir = await tempDir('symphony-env-wf-');
    const cwdDir = await tempDir('symphony-env-cwd-');
    try {
      await cwdDir.write('.env', 'TOKEN=cwd\n');
      const cwdOnly = await resolveEnvironment({
        workflowDir: workflowDir.path,
        cwd: cwdDir.path,
        base: {},
        platform: 'linux',
      });
      assert.equal(cwdOnly.file, resolve(join(cwdDir.path, '.env')));
      assert.equal(cwdOnly.env['TOKEN'], 'cwd');

      await workflowDir.write('.env', 'TOKEN=workflow\n');
      const both = await resolveEnvironment({
        workflowDir: workflowDir.path,
        cwd: cwdDir.path,
        base: {},
        platform: 'linux',
      });
      assert.equal(both.file, resolve(join(workflowDir.path, '.env')));
      assert.equal(both.env['TOKEN'], 'workflow');
    } finally {
      await workflowDir.cleanup();
      await cwdDir.cleanup();
    }
  });

  it('reports no file when nothing exists', async () => {
    const dir = await tempDir('symphony-env-none-');
    try {
      const resolution = await resolveEnvironment({ workflowDir: dir.path, cwd: dir.path, base: { A: '1' } });
      assert.equal(resolution.file, null);
      assert.deepEqual(resolution.applied, []);
      assert.equal(resolution.env['A'], '1');
    } finally {
      await dir.cleanup();
    }
  });

  it('uses an explicit path and fails when it is missing', async () => {
    const dir = await tempDir('symphony-env-explicit-');
    try {
      const path = await dir.write('secrets.env', 'GITHUB_TOKEN=explicit\n');
      const resolution = await resolveEnvironment({
        workflowDir: dir.path,
        explicitPath: path,
        base: {},
        platform: 'linux',
      });
      assert.equal(resolution.file, resolve(path));
      assert.equal(resolution.env['GITHUB_TOKEN'], 'explicit');

      await assert.rejects(
        () =>
          resolveEnvironment({
            workflowDir: dir.path,
            explicitPath: join(dir.path, 'missing.env'),
            base: {},
          }),
        (error: unknown) => error instanceof ValidationError && error.problems[0]?.code === 'missing_env_file',
      );
    } finally {
      await dir.cleanup();
    }
  });

  it('can be disabled entirely', async () => {
    const dir = await tempDir('symphony-env-disabled-');
    try {
      await dir.write('.env', 'GITHUB_TOKEN=present\n');
      const resolution = await resolveEnvironment({ workflowDir: dir.path, base: {}, disabled: true });
      assert.equal(resolution.file, null);
      assert.equal(resolution.env['GITHUB_TOKEN'], undefined);
    } finally {
      await dir.cleanup();
    }
  });

  it('returns null from loadEnvFile for a missing file', async () => {
    const dir = await tempDir('symphony-env-missing-');
    try {
      assert.equal(await loadEnvFile(join(dir.path, '.env')), null);
    } finally {
      await dir.cleanup();
    }
  });
});
