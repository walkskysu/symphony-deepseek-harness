#!/usr/bin/env node
/**
 * Offline end-to-end demo.
 *
 *   npm run demo          (requires `npm run build` first)
 *
 * Runs the real service against the in-memory tracker with a fake DSH agent, so
 * no credentials, model or DSH install are needed. Prints the lifecycle events
 * and the final runtime snapshot.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SymphonyService, createLogger } from '../../dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(here, 'WORKFLOW.md');
const agentScript = join(here, 'fake-agent.mjs');

const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-demo-ws-'));
process.env.SYMPHONY_DEMO_WORKSPACES = workspaceRoot;

/** Lifecycle messages worth showing to the operator. */
const INTERESTING = new Set([
  'symphony starting',
  'http server listening',
  'startup terminal cleanup completed',
  'dispatching issue',
  'hook completed',
  'agent turn started',
  'agent tool executed',
  'worker exited normally; scheduling continuation retry',
  'retry scheduled',
  'retry released: issue is not active or not routable',
  'symphony stopped',
]);

let finished;
const done = new Promise((resolve) => {
  finished = resolve;
});

const sink = {
  write(line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (!INTERESTING.has(record.msg)) return;
    const extras = Object.entries(record)
      .filter(([key]) => !['ts', 'level', 'msg'].includes(key))
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    process.stdout.write(`  ${record.msg}${extras === '' ? '' : `  ${extras}`}\n`);
    if (record.msg.startsWith('retry released')) finished();
  },
};

const logger = createLogger({ level: 'info', format: 'json', sink });
const service = new SymphonyService({
  workflowPath,
  port: 0,
  host: '127.0.0.1',
  watch: false,
  logFormat: 'json',
  logLevel: 'info',
  logger,
  // Use the fake agent as the "dsh" executable for this demo.
  plan: () => ({ file: process.execPath, args: [agentScript], via_shell: false, description: 'node fake-agent.mjs' }),
});

console.log('Symphony demo');
console.log(`  workflow    ${workflowPath}`);
console.log(`  workspaces  ${workspaceRoot}`);
console.log('');
console.log('Lifecycle:');

try {
  await service.start();
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 30_000));
  const outcome = await Promise.race([done, timeout]);
  if (outcome === 'timeout') console.log('  (timed out waiting for the handoff; printing state anyway)');

  const snapshot = service.snapshot();
  console.log('');
  console.log('Runtime snapshot:');
  console.log(JSON.stringify(snapshot, null, 2));
  console.log('');
  console.log('Tracker detail for DEMO-1:');
  console.log(JSON.stringify(service.issueDetail('DEMO-1'), null, 2));
  console.log('');
  console.log(`Dashboard was served at ${service.httpUrl ?? '(disabled)'} during the run.`);
  console.log(`Workspace root kept for inspection: ${workspaceRoot}`);
} finally {
  await service.stop();
  if (process.env.SYMPHONY_DEMO_KEEP !== '1') await rm(workspaceRoot, { recursive: true, force: true });
}
