/** Command-line parsing for the daemon (SPEC 17.7). */
import { DEFAULT_WORKFLOW_FILE } from './config/workflow.js';

export interface CliOptions {
  /** Positional workflow path; when omitted the cwd default is used. */
  workflowPath: string | null;
  /** `--port` value; `null` means "not provided", `0` requests an ephemeral port. */
  port: number | null;
  host: string | null;
  logFormat: 'json' | 'pretty' | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | null;
  logFile: string | null;
  /** Explicit `.env` path (default: search next to WORKFLOW.md, then cwd). */
  envFile: string | null;
  /** `--no-env-file`: ignore `.env` files entirely. */
  envFileDisabled: boolean;
  watch: boolean;
  once: boolean;
  help: boolean;
  version: boolean;
}

export interface ParseResult {
  options: CliOptions;
  errors: string[];
}

export const USAGE = `symphony - long-running coding-agent orchestrator

Usage:
  symphony [path-to-WORKFLOW.md] [options]

Options:
  --port <n>            enable the HTTP status API on this port (0 = ephemeral)
  --host <addr>         bind address for the HTTP server (default 127.0.0.1)
  --log-format <fmt>    json | pretty (default: pretty on a TTY, json otherwise)
  --log-level <level>   debug | info | warn | error (default info)
  --log-file <path>     also append structured logs to this file
  --env-file <path>     read secrets from this file (default: .env next to WORKFLOW.md, then cwd)
  --no-env-file         ignore .env files entirely
  --no-watch            do not watch WORKFLOW.md for changes
  --once                run a single poll tick and exit
  -h, --help            print this help
  -V, --version         print the version

Without a positional argument, ./${DEFAULT_WORKFLOW_FILE} is used.`;

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function takeValue(argv: string[], index: number, flag: string, errors: string[]): { value: string | null; next: number } {
  const current = argv[index] as string;
  const equals = current.indexOf('=');
  if (equals > 0) return { value: current.slice(equals + 1), next: index + 1 };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('-')) {
    errors.push(`${flag} requires a value`);
    return { value: null, next: index + 1 };
  }
  return { value, next: index + 2 };
}

/** Parse CLI arguments; unknown flags are reported rather than ignored. */
export function parseArgs(argv: string[]): ParseResult {
  const options: CliOptions = {
    workflowPath: null,
    port: null,
    host: null,
    logFormat: null,
    logLevel: null,
    logFile: null,
    envFile: null,
    envFileDisabled: false,
    watch: true,
    once: false,
    help: false,
    version: false,
  };
  const errors: string[] = [];
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; ) {
    const arg = argv[index] as string;
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      index += 1;
      continue;
    }
    const flag = arg.split('=')[0] ?? arg;
    switch (flag) {
      case '-h':
      case '--help':
        options.help = true;
        index += 1;
        break;
      case '-V':
      case '--version':
        options.version = true;
        index += 1;
        break;
      case '--port': {
        const { value, next } = takeValue(argv, index, '--port', errors);
        index = next;
        if (value === null) break;
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          errors.push(`--port must be an integer between 0 and 65535 (got ${JSON.stringify(value)})`);
        } else {
          options.port = parsed;
        }
        break;
      }
      case '--host': {
        const { value, next } = takeValue(argv, index, '--host', errors);
        index = next;
        if (value !== null) options.host = value;
        break;
      }
      case '--log-format': {
        const { value, next } = takeValue(argv, index, '--log-format', errors);
        index = next;
        if (value === 'json' || value === 'pretty') options.logFormat = value;
        else if (value !== null) errors.push(`--log-format must be json or pretty (got ${JSON.stringify(value)})`);
        break;
      }
      case '--log-level': {
        const { value, next } = takeValue(argv, index, '--log-level', errors);
        index = next;
        if (value !== null && LOG_LEVELS.has(value)) options.logLevel = value as CliOptions['logLevel'];
        else if (value !== null) errors.push(`--log-level must be one of debug, info, warn, error (got ${JSON.stringify(value)})`);
        break;
      }
      case '--log-file': {
        const { value, next } = takeValue(argv, index, '--log-file', errors);
        index = next;
        if (value !== null) options.logFile = value;
        break;
      }
      case '--env-file': {
        const { value, next } = takeValue(argv, index, '--env-file', errors);
        index = next;
        if (value !== null) options.envFile = value;
        break;
      }
      case '--no-env-file':
        options.envFileDisabled = true;
        index += 1;
        break;
      case '--no-watch':
        options.watch = false;
        index += 1;
        break;
      case '--once':
        options.once = true;
        index += 1;
        break;
      default:
        errors.push(`unknown option: ${flag}`);
        index += 1;
        break;
    }
  }

  if (positionals.length > 1) {
    errors.push(`expected at most one workflow path, got ${positionals.length}: ${positionals.join(' ')}`);
  }
  options.workflowPath = positionals[0] ?? null;
  return { options, errors };
}
