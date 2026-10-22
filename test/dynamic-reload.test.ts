import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

import { SymphonyService } from '../src/service.js';
import { NullLogger } from '../src/observability/logger.js';
import { StubBackend, waitFor, tempDir } from './helpers.js';

const logger = new NullLogger();

function workflow(intervalMs: number): string {
  return [
    '---',
    'tracker:',
    '  kind: memory',
    '  provider:',
    '    issues: []',
    '  active_states: [open]',
    '  terminal_states: [closed]',
    'polling:',
    `  interval_ms: ${intervalMs}`,
    'agent:',
    '  max_turns: 1',
    'workspace:',
    '  root: ./ws',
    '---',
    'Work on {{ issue.identifier }}.',
  ].join('\n');
}

function workflowWithIssue(intervalMs: number): string {
  return [
    '---',
    'tracker:',
    '  kind: memory',
    '  provider:',
    '    issues:',
    '      - id: "1"',
    '        identifier: NEW-1',
    '        title: Added by a reload',
    '        state: open',
    '  active_states: [open]',
    '  terminal_states: [closed]',
    'polling:',
    `  interval_ms: ${intervalMs}`,
    'agent:',
    '  max_turns: 1',
    'workspace:',
    '  root: ./ws',
    '---',
    'Work on {{ issue.identifier }}.',
  ].join('\n');
}

describe('dynamic reload drives future dispatches', () => {
  it('starts working on an issue added by a workflow edit, without a restart', async () => {
    const dir = await tempDir('symphony-dynamic-');
    const workflowPath = await dir.write('WORKFLOW.md', workflow(120));
    const backend = new StubBackend(() => ({
      ok: true,
      error: null,
      session_id: null,
      turn_id: null,
      final_text: 'done',
    }));
    const service = new SymphonyService({ workflowPath, watch: false, logger, backend });
    try {
      await service.start();
      assert.equal(service.snapshot()?.counts.running, 0);

      // Add an issue by editing the workflow file only.
      await writeFile(workflowPath, workflowWithIssue(120), 'utf8');
      await waitFor(() => backend.startCalls.length === 1, 5_000, 'dispatch after reload');
      assert.equal(backend.startCalls[0]?.issue.identifier, 'NEW-1');
    } finally {
      await service.stop();
      await dir.cleanup();
    }
  });
});
