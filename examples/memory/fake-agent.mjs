#!/usr/bin/env node
/**
 * A fake coding agent that speaks the DSH `--json` event protocol.
 *
 * The demo injects this file as the agent executable, so no model, network
 * access or DSH installation is needed. It performs the two tracker calls a
 * real workflow would make and then hands the issue to `review`.
 */
import { execFileSync } from 'node:child_process';

const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;

const sessionId = process.env.SYMPHONY_DEMO_SESSION ?? `session-demo-${process.pid}`;
const shim = process.env.SYMPHONY_TOOL_SHIM;
const hasTools = typeof shim === 'string' && shim !== '' && process.env.SYMPHONY_TOOL_TOKEN !== undefined;

send({ type: 'session', sessionId, cwd: process.cwd() });
send({ type: 'status', phase: 'turn_start', turn: 1 });
send({ type: 'thinking', text: 'The demo agent received the rendered issue prompt.' });

const promptLines = prompt.trim().split(/\r?\n/).length;
send({ type: 'text', text: `Read ${promptLines} prompt lines in ${process.cwd()}.` });

let callId = 0;
const callTool = (name, args) => {
  callId += 1;
  send({ type: 'tool_call', callId: `demo-${callId}`, tool: name, input: args });
  try {
    const output = execFileSync(process.execPath, [shim, name, JSON.stringify(args)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    send({ type: 'tool_result', callId: `demo-${callId}`, status: 'completed', result: output });
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({ type: 'tool_result', callId: `demo-${callId}`, status: 'error', result: message });
    throw error;
  }
};

if (hasTools) {
  callTool('issue_comment', {
    body: 'Demo agent: investigating `auth.spec.ts`. Will post the root cause and the fix.',
  });
  callTool('issue_set_state', { state: 'review' });
  send({ type: 'text', text: 'Handed the issue off to `review`.' });
} else {
  send({ type: 'text', text: 'No tracker tools were advertised for this run.' });
}

send({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 } });
send({ type: 'status', phase: 'turn_end', turn: 1, reason: 'completed' });
send({ type: 'final', text: 'Demo turn complete: issue moved to review.' });
process.exit(0);
