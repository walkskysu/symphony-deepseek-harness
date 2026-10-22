import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseArgs, USAGE } from '../src/cli.js';
import { tempDir } from './helpers.js';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const bin = resolve(here, '../src/bin.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runBin(args: string[], cwd: string): Promise<RunResult> {
  try {
    const result = await execFileAsync(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 30_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('cli argument parsing', () => {
  it('defaults to no explicit workflow path', () => {
    const { options, errors } = parseArgs([]);
    assert.equal(options.workflowPath, null);
    assert.equal(options.port, null);
    assert.equal(options.watch, true);
    assert.deepEqual(errors, []);
  });

  it('accepts a positional workflow path', () => {
    const { options } = parseArgs(['docs/WORKFLOW.md']);
    assert.equal(options.workflowPath, 'docs/WORKFLOW.md');
  });

  it('parses --port, including 0 for an ephemeral port', () => {
    assert.equal(parseArgs(['--port', '8080']).options.port, 8080);
    assert.equal(parseArgs(['--port=0']).options.port, 0);
    assert.equal(parseArgs(['--port', '70000']).errors.length, 1);
    assert.equal(parseArgs(['--port']).errors.length, 1);
  });

  it('parses logging, watch and once flags', () => {
    const { options } = parseArgs(['--log-format', 'json', '--log-level', 'debug', '--no-watch', '--once', '--log-file', 'out.log']);
    assert.equal(options.logFormat, 'json');
    assert.equal(options.logLevel, 'debug');
    assert.equal(options.watch, false);
    assert.equal(options.once, true);
    assert.equal(options.logFile, 'out.log');
  });

  it('reports unknown flags and extra positionals', () => {
    assert.equal(parseArgs(['--bogus']).errors.length, 1);
    assert.equal(parseArgs(['a.md', 'b.md']).errors.length, 1);
  });
});

describe('cli process lifecycle', () => {
  it('prints usage with --help and exits 0', async () => {
    const dir = await tempDir('symphony-cli-');
    try {
      const result = await runBin(['--help'], dir.path);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /symphony - long-running coding-agent orchestrator/);
      assert.match(result.stdout, new RegExp(USAGE.split('\n')[0] ?? 'Usage'));
    } finally {
      await dir.cleanup();
    }
  });

  it('prints the version and exits 0', async () => {
    const dir = await tempDir('symphony-cli-');
    try {
      const result = await runBin(['--version'], dir.path);
      assert.equal(result.code, 0);
      assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
    } finally {
      await dir.cleanup();
    }
  });

  it('exits 1 when the default ./WORKFLOW.md is missing', async () => {
    const dir = await tempDir('symphony-cli-');
    try {
      const result = await runBin([], dir.path);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /not found/);
    } finally {
      await dir.cleanup();
    }
  });

  it('exits 1 when an explicit workflow path does not exist', async () => {
    const dir = await tempDir('symphony-cli-');
    try {
      const result = await runBin(['does-not-exist.md'], dir.path);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /workflow file not found/);
    } finally {
      await dir.cleanup();
    }
  });

  it('exits 2 on a usage error', async () => {
    const dir = await tempDir('symphony-cli-');
    try {
      const result = await runBin(['--nope'], dir.path);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /unknown option/);
    } finally {
      await dir.cleanup();
    }
  });

  it('exits 1 with a clear message when startup validation fails', async () => {
    const dir = await tempDir('symphony-cli-');
    try {
      await dir.write(
        'WORKFLOW.md',
        ['---', 'tracker:', '  kind: jira', '  active_states: [open]', '  terminal_states: [done]', '---', 'Body'].join('\n'),
      );
      const result = await runBin(['--once'], dir.path);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /unsupported tracker.kind/);
    } finally {
      await dir.cleanup();
    }
  });

  it('starts, polls once and exits 0 with --once', async () => {
    const dir = await tempDir('symphony-cli-');
    try {
      await dir.write(
        'WORKFLOW.md',
        [
          '---',
          'tracker:',
          '  kind: memory',
          '  active_states: [open]',
          '  terminal_states: [closed]',
          'workspace:',
          '  root: ./ws',
          '---',
          'Work on {{ issue.identifier }}.',
        ].join('\n'),
      );
      const result = await runBin(['--once', '--log-format', 'json'], dir.path);
      assert.equal(result.code, 0, result.stderr);
      const snapshot = JSON.parse(result.stdout) as { counts: { running: number } };
      assert.equal(snapshot.counts.running, 0);
    } finally {
      await dir.cleanup();
    }
  });
});
