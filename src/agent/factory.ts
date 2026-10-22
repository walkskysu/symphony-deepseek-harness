/** Agent backend selection (SPEC 10.1: which executable is launched). */
import type { ServiceConfig } from '../config/config.js';
import type { Logger } from '../observability/logger.js';
import type { AgentBackend } from './backend.js';
import { CodexBackend } from './codex.js';
import { DshBackend } from './dsh.js';
import type { ProgramPlan } from '../platform/launch.js';

export interface BackendFactoryOptions {
  config: ServiceConfig;
  logger: Logger;
  /** Test seam used by the end-to-end tests. */
  plan?: (args: string[], env: NodeJS.ProcessEnv) => ProgramPlan;
  /** Test seam: a fully custom backend. */
  backend?: AgentBackend;
}

/** Build the backend selected by `harness.kind`. */
export function createAgentBackend(options: BackendFactoryOptions): AgentBackend {
  if (options.backend !== undefined) return options.backend;
  switch (options.config.harness.kind) {
    case 'dsh':
      return new DshBackend({ config: options.config, logger: options.logger, ...(options.plan === undefined ? {} : { plan: options.plan }) });
    case 'codex':
    default:
      return new CodexBackend({ config: options.config, logger: options.logger, ...(options.plan === undefined ? {} : { plan: options.plan }) });
  }
}

export type { AgentBackend, AgentSession, AgentSessionStart, AgentTurnOptions, AgentTurnResult } from './backend.js';
