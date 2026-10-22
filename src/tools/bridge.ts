/**
 * Host-side provider-native tool bridge (SPEC 10.5, 11.5).
 *
 * Coding-agent processes never receive a tracker credential. Instead, Symphony
 * executes tracker tools itself and exposes them through a loopback HTTP
 * endpoint guarded by a per-run bearer token. A tiny Node shim written to the
 * workspace root lets any CLI agent call those tools:
 *
 *   node "<shim>" issue_comment '{"body":"..."}'
 *
 * The shim reads its endpoint and token from the child environment, so a token
 * is scoped to one running attempt and revoked when the attempt ends.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { Issue } from '../domain/types.js';
import type { TrackerAdapter, ToolSpec } from '../tracker/adapter.js';
import type { Logger } from '../observability/logger.js';

const MAX_BODY_BYTES = 1_000_000;

export interface ToolBridgeOptions {
  adapter: TrackerAdapter;
  logger: Logger;
  /** Directory that receives the generated shim script. */
  shimDir: string;
  host?: string;
}

export interface RunCredential {
  token: string;
  issue: Issue;
  env: Record<string, string>;
}

export class ToolBridge {
  private readonly options: ToolBridgeOptions;
  private server: Server | null = null;
  private endpoint: string | null = null;
  private readonly runs = new Map<string, RunCredential>();
  private shimPath: string | null = null;

  constructor(options: ToolBridgeOptions) {
    this.options = options;
  }

  get url(): string | null {
    return this.endpoint;
  }

  get shim(): string | null {
    return this.shimPath;
  }

  get tools(): ToolSpec[] {
    return this.options.adapter.agentToolSpecs?.() ?? [];
  }

  /** True when the bridge is actually usable (has tools and is listening). */
  get enabled(): boolean {
    return this.endpoint !== null && this.shimPath !== null && this.tools.length > 0;
  }

  /** Start the loopback endpoint and write the agent shim. */
  async start(): Promise<void> {
    if (this.tools.length === 0) return;
    if (this.server !== null) return;
    const host = this.options.host ?? '127.0.0.1';
    let server: Server | null = null;
    try {
      server = createServer((request, response) => {
        void this.handle(request, response);
      });
      await new Promise<void>((resolve, reject) => {
        const listening = server as Server;
        listening.once('error', reject);
        listening.listen(0, host, () => {
          listening.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('tool bridge failed to bind a loopback port');
      }

      // The shim directory lives under the workspace root; if it cannot be
      // created the bridge is unavailable, but that must not take the daemon
      // down (tools are an optional extension).
      await mkdir(this.options.shimDir, { recursive: true });
      const shimPath = join(this.options.shimDir, 'agent-tools.mjs');
      await writeFile(shimPath, AGENT_TOOL_SHIM, 'utf8');

      this.server = server;
      this.endpoint = `http://${host}:${address.port}/invoke`;
      this.shimPath = shimPath;
      this.options.logger.info('tool bridge listening', {
        endpoint: this.endpoint,
        shim: shimPath,
        tools: this.tools.length,
      });
    } catch (error) {
      const open = this.server ?? server;
      this.server = null;
      this.endpoint = null;
      this.shimPath = null;
      if (open !== null) {
        await new Promise<void>((resolve) => open.close(() => resolve())).catch(() => undefined);
      }
      throw error;
    }
  }

  /** Mint a per-attempt credential and the environment that carries it. */
  createRun(issue: Issue): RunCredential {
    const token = randomBytes(24).toString('hex');
    const credential: RunCredential = { token, issue, env: {} };
    const endpoint = this.endpoint;
    const shim = this.shimPath;
    credential.env = {
      ...(endpoint === null ? {} : { SYMPHONY_TOOL_URL: endpoint }),
      ...(shim === null ? {} : { SYMPHONY_TOOL_SHIM: shim }),
      SYMPHONY_TOOL_TOKEN: token,
      SYMPHONY_TOOL_ISSUE_ID: issue.id,
      SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
    };
    this.runs.set(token, credential);
    return credential;
  }

  /** Revoke a credential once its attempt ends. */
  releaseRun(token: string): void {
    this.runs.delete(token);
  }

  async stop(): Promise<void> {
    this.runs.clear();
    const server = this.server;
    this.server = null;
    this.endpoint = null;
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'POST' || (request.url ?? '') !== '/invoke') {
        this.respond(response, 404, { error: { code: 'not_found', message: 'unknown tool endpoint' } });
        return;
      }
      const token = headerValue(request, 'x-symphony-tool-token');
      const credential = token === null ? undefined : this.runs.get(token);
      if (credential === undefined) {
        this.respond(response, 401, { error: { code: 'unauthorized', message: 'invalid or expired tool token' } });
        return;
      }
      const body = await readJsonBody(request);
      if (body === null) {
        this.respond(response, 400, { error: { code: 'invalid_body', message: 'expected a JSON object body' } });
        return;
      }
      const name = typeof body['name'] === 'string' ? body['name'] : '';
      const rawArgs = body['arguments'];
      const args = typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
      if (name === '') {
        this.respond(response, 400, { error: { code: 'invalid_body', message: 'tool name is required' } });
        return;
      }
      const execute = this.options.adapter.executeAgentTool?.bind(this.options.adapter);
      if (execute === undefined) {
        this.respond(response, 501, { error: { code: 'unsupported_tool', message: `tracker adapter ${this.options.adapter.kind} ships no tools` } });
        return;
      }
      const result = await execute(name, args, { issue: credential.issue });
      this.options.logger.info('agent tool executed', {
        issue_id: credential.issue.id,
        issue_identifier: credential.issue.identifier,
        tool: name,
        outcome: result.ok ? 'completed' : 'failed',
      });
      this.respond(response, result.ok ? 200 : 400, result);
    } catch (error) {
      this.options.logger.warn('agent tool bridge error', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) {
        this.respond(response, 500, { ok: false, error: { category: 'internal', message: 'tool execution failed' } });
      }
    }
  }

  private respond(response: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  }
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The shim script written into the workspace root. */
export const AGENT_TOOL_SHIM = `#!/usr/bin/env node
// Generated by Symphony. Calls a host-side tracker tool; holds no credentials.
const url = process.env.SYMPHONY_TOOL_URL;
const token = process.env.SYMPHONY_TOOL_TOKEN;
const [name, rawArgs] = process.argv.slice(2);

if (!url || !token) {
  console.error('symphony tools: SYMPHONY_TOOL_URL / SYMPHONY_TOOL_TOKEN are not set for this run');
  process.exit(2);
}
if (!name) {
  console.error('usage: node agent-tools.mjs <tool> [json-arguments]');
  process.exit(2);
}

let args = {};
if (rawArgs !== undefined && rawArgs.trim() !== '') {
  try {
    args = JSON.parse(rawArgs);
  } catch (error) {
    console.error('symphony tools: arguments must be JSON:', error.message);
    process.exit(2);
  }
}

const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-symphony-tool-token': token },
  body: JSON.stringify({ name, arguments: args })
});
const text = await response.text();
console.log(text);
process.exit(response.ok ? 0 : 1);
`;
