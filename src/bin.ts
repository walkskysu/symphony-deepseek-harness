#!/usr/bin/env node
/**
 * `symphony` command-line entry point (SPEC 17.7).
 *
 * Exit codes: 0 when the service starts and shuts down normally, 1 when startup
 * validation or the workflow file fails, 2 for a usage error.
 */
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseArgs, USAGE } from './cli.js';
import { resolveWorkflowPath } from './config/workflow.js';
import { SymphonyService } from './service.js';
import { describeError } from './domain/errors.js';
import { createLogger } from './observability/logger.js';

const VERSION = '0.1.0';

async function main(): Promise<number> {
  const { options, errors } = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (errors.length > 0) {
    process.stderr.write(`symphony: ${errors.join('; ')}\n\n${USAGE}\n`);
    return 2;
  }

  const workflowPath = resolveWorkflowPath(options.workflowPath ?? undefined);
  try {
    await access(workflowPath);
  } catch {
    const label = options.workflowPath === null ? 'default workflow file' : 'workflow file';
    process.stderr.write(`symphony: ${label} not found: ${workflowPath}\n`);
    return 1;
  }

  const format = options.logFormat ?? (process.stdout.isTTY === true ? 'pretty' : 'json');
  // In `--once` mode stdout carries only the snapshot JSON, so logs go to stderr.
  const sink = options.once === true ? { write: (line: string) => process.stderr.write(`${line}\n`) } : undefined;
  const logger = createLogger({
    level: options.logLevel ?? 'info',
    format,
    ...(sink === undefined ? {} : { sink }),
    ...(options.logFile === null ? {} : { filePath: resolve(options.logFile) }),
  });

  const service = new SymphonyService({
    workflowPath,
    ...(options.port === null ? {} : { port: options.port }),
    ...(options.host === null ? {} : { host: options.host }),
    ...(options.logFile === null ? {} : { logFile: resolve(options.logFile) }),
    logFormat: format,
    ...(options.logLevel === null ? {} : { logLevel: options.logLevel }),
    ...(options.envFile === null ? {} : { envFile: resolve(options.envFile) }),
    ...(options.envFileDisabled ? { envFileDisabled: true } : {}),
    logger,
    watch: options.watch,
  });

  try {
    await service.start();
  } catch (error) {
    const message = error instanceof Error ? (error.name === 'ValidationError' ? error.message : error.message) : String(error);
    logger.error('startup failed', { error: message });
    process.stderr.write(`symphony: startup failed: ${message}\n`);
    return 1;
  }

  if (options.once) {
    const snapshot = service.snapshot();
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    await service.stop();
    return 0;
  }

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown signal received', { signal });
    void service
      .stop()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        logger.error('shutdown failed', { error: describeError(error) });
        process.exitCode = 1;
      })
      .finally(() => {
        setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error: describeError(error) });
    void service.stop().finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { error: describeError(reason) });
  });

  logger.info('symphony ready', {
    workflow: workflowPath,
    http: service.httpUrl ?? 'disabled',
  });
  return -1; // Keep the process alive until a signal arrives.
}

main().then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`symphony: fatal: ${describeError(error)}\n`);
    process.exitCode = 1;
  },
);
