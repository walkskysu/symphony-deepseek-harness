import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import {
  DEFAULT_WORKFLOW_FILE,
  loadWorkflowFile,
  parseWorkflow,
  resolveWorkflowPath,
  splitWorkflowDocument,
} from '../src/config/workflow.js';
import { WorkflowError } from '../src/domain/errors.js';
import { tempDir } from './helpers.js';

describe('workflow path selection', () => {
  it('uses an explicit runtime path when provided', () => {
    const path = resolveWorkflowPath('docs/OTHER.md', '/work');
    assert.equal(path, resolve('/work', 'docs/OTHER.md'));
  });

  it('resolves the cwd default when no explicit path is given', () => {
    assert.equal(resolveWorkflowPath(undefined, '/work'), resolve('/work', DEFAULT_WORKFLOW_FILE));
    assert.equal(resolveWorkflowPath('  ', '/work'), resolve('/work', DEFAULT_WORKFLOW_FILE));
  });

  it('accepts absolute paths unchanged', () => {
    const absolute = resolve('/tmp', 'WORKFLOW.md');
    assert.equal(resolveWorkflowPath(absolute, '/elsewhere'), absolute);
  });

  it('reports a missing workflow file with a typed error', async () => {
    const missing = join(await tempDirPath(), 'nope.md');
    await assert.rejects(
      () => loadWorkflowFile(missing),
      (error: unknown) => error instanceof WorkflowError && error.code === 'missing_workflow_file',
    );
  });
});

async function tempDirPath(): Promise<string> {
  const dir = await tempDir('symphony-workflow-');
  return dir.path;
}

describe('workflow document splitting', () => {
  it('treats a document without front matter as the prompt body', () => {
    const split = splitWorkflowDocument('  hello {{ world }}  ');
    assert.equal(split.frontMatter, null);
    assert.equal(split.body, 'hello {{ world }}');
  });

  it('splits front matter from the body and trims both sides of the body', () => {
    const split = splitWorkflowDocument('---\na: 1\n---\n\n # Title\n');
    assert.equal(split.frontMatter, 'a: 1');
    assert.equal(split.body, '# Title');
  });

  it('rejects an unterminated front matter block', () => {
    assert.throws(
      () => splitWorkflowDocument('---\na: 1\nbody\n'),
      (error: unknown) => error instanceof WorkflowError && error.code === 'workflow_parse_error',
    );
  });
});

describe('workflow parsing', () => {
  it('parses front matter into a config map', () => {
    const parsed = parseWorkflow('---\ntracker:\n  kind: memory\n---\nDo the thing.\n');
    assert.deepEqual(parsed.config, { tracker: { kind: 'memory' } });
    assert.equal(parsed.prompt_template, 'Do the thing.');
  });

  it('maps an empty front matter block to an empty config', () => {
    const parsed = parseWorkflow('---\n---\nBody\n');
    assert.deepEqual(parsed.config, {});
    assert.equal(parsed.prompt_template, 'Body');
  });

  it('rejects invalid YAML with workflow_parse_error', () => {
    assert.throws(
      () => parseWorkflow('---\ntracker: [unclosed\n---\nBody\n'),
      (error: unknown) => error instanceof WorkflowError && error.code === 'workflow_parse_error',
    );
  });

  it('rejects non-map front matter with workflow_front_matter_not_a_map', () => {
    assert.throws(
      () => parseWorkflow('---\n- one\n- two\n---\nBody\n'),
      (error: unknown) => error instanceof WorkflowError && error.code === 'workflow_front_matter_not_a_map',
    );
    assert.throws(
      () => parseWorkflow('---\njust a string\n---\nBody\n'),
      (error: unknown) => error instanceof WorkflowError && error.code === 'workflow_front_matter_not_a_map',
    );
  });

  it('preserves multiline hook scripts from YAML block scalars', () => {
    const parsed = parseWorkflow(
      ['---', 'hooks:', '  before_run: |', '    echo one', '    echo two', '---', 'Body'].join('\n'),
    );
    assert.equal((parsed.config['hooks'] as Record<string, unknown>)['before_run'], 'echo one\necho two\n');
  });

  it('strips a UTF-8 BOM before looking for the front-matter fence', () => {
    const parsed = parseWorkflow('\uFEFF---\nk: v\n---\nBody');
    assert.deepEqual(parsed.config, { k: 'v' });
  });

  it('loads a workflow file from disk', async () => {
    const dir = await tempDir('symphony-load-');
    try {
      const path = await dir.write('WORKFLOW.md', '---\ntracker:\n  kind: memory\n---\nPrompt\n');
      const loaded = await loadWorkflowFile(path);
      assert.equal(loaded.prompt_template, 'Prompt');
      assert.deepEqual(loaded.config, { tracker: { kind: 'memory' } });
    } finally {
      await dir.cleanup();
    }
  });
});
