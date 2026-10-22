/**
 * OPTIONAL HTTP extension: dashboard plus JSON API (SPEC 13.7).
 *
 * The surface is observability/control only. Orchestrator correctness never
 * depends on it, and a failed request never mutates scheduler state beyond the
 * best-effort refresh trigger.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { IssueDetail, RuntimeSnapshot } from '../observability/snapshot.js';
import type { Logger } from '../observability/logger.js';
import { renderDashboard } from './dashboard.js';

export interface SymphonyServerDeps {
  logger: Logger;
  workflowPath: () => string;
  snapshot: () => RuntimeSnapshot | null;
  issueDetail: (identifier: string) => IssueDetail | null;
  requestRefresh: () => { queued: boolean; coalesced: boolean };
}

export interface HttpServerOptions {
  port: number;
  host: string;
}

export interface RunningHttpServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  });
  response.end(html);
}

async function drain(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) {
    // Discard request bodies on endpoints that do not use them.
  }
}

/** Start the HTTP server on the given port/host. */
export async function startHttpServer(
  deps: SymphonyServerDeps,
  options: HttpServerOptions,
): Promise<RunningHttpServer> {
  const server: Server = createServer((request, response) => {
    void handle(deps, request, response).catch((error: unknown) => {
      deps.logger.warn('http handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) sendError(response, 500, 'internal_error', 'request failed');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = address === null || typeof address === 'string' ? options.port : address.port;
  const hostForUrl = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;
  const url = `http://${hostForUrl}:${port}`;
  deps.logger.info('http server listening', { url, workflow: deps.workflowPath() });

  return {
    url,
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handle(deps: SymphonyServerDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? 'GET';
  const rawUrl = request.url ?? '/';
  const path = rawUrl.split('?')[0] ?? '/';

  if (path === '/') {
    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      sendError(response, 405, 'method_not_allowed', `${method} is not allowed on /`);
      return;
    }
    sendHtml(response, 200, renderDashboard(deps.snapshot(), deps.workflowPath()));
    return;
  }

  if (path === '/api/v1/state') {
    if (method !== 'GET') {
      response.setHeader('allow', 'GET');
      sendError(response, 405, 'method_not_allowed', `${method} is not allowed on /api/v1/state`);
      return;
    }
    const snapshot = deps.snapshot();
    if (snapshot === null) {
      sendError(response, 503, 'unavailable', 'runtime state is not available yet');
      return;
    }
    sendJson(response, 200, snapshot);
    return;
  }

  if (path === '/api/v1/refresh') {
    if (method !== 'POST') {
      response.setHeader('allow', 'POST');
      sendError(response, 405, 'method_not_allowed', `${method} is not allowed on /api/v1/refresh`);
      return;
    }
    await drain(request);
    const result = deps.requestRefresh();
    sendJson(response, 202, {
      queued: result.queued,
      coalesced: result.coalesced,
      requested_at: new Date().toISOString(),
      operations: ['poll', 'reconcile'],
    });
    return;
  }

  if (path.startsWith('/api/v1/')) {
    if (method !== 'GET') {
      response.setHeader('allow', 'GET');
      sendError(response, 405, 'method_not_allowed', `${method} is not allowed on ${path}`);
      return;
    }
    const rawIdentifier = path.slice('/api/v1/'.length);
    let identifier: string;
    try {
      identifier = decodeURIComponent(rawIdentifier);
    } catch {
      sendError(response, 400, 'invalid_identifier', 'issue identifier is not valid URI encoding');
      return;
    }
    const detail = deps.issueDetail(identifier);
    if (detail === null) {
      sendError(response, 404, 'issue_not_found', `issue ${identifier} is not tracked in memory`);
      return;
    }
    sendJson(response, 200, detail);
    return;
  }

  sendError(response, 404, 'not_found', `unknown route: ${path}`);
}
