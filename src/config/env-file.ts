/**
 * `.env` support for host-side secrets (tracker credentials, model keys).
 *
 * Precedence matches the DSH convention: the launch environment always wins, and
 * a `.env` file only fills variables the environment does not define at all. An
 * exported empty value therefore shadows the file, exactly like DSH does.
 *
 * Search order when no explicit path is configured:
 *   1. `<directory of WORKFLOW.md>/.env`
 *   2. `<process cwd>/.env`
 *
 * The first file that exists is used. Values are never logged: only the file path
 * and the *names* of the variables it supplied.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ValidationError } from '../domain/errors.js';
import type { Logger } from '../observability/logger.js';

export interface ParsedEnvFile {
  values: Record<string, string>;
  /** Line-level problems; the file is still usable. */
  warnings: string[];
}

function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\([ntr"\\])/g, (_match, character: string) => {
    switch (character) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
      default:
        return '\\';
    }
  });
}

/**
 * Parse dotenv syntax: `KEY=VALUE`, optional `export` prefix, `#` comments,
 * single-quoted literals, double-quoted strings with `\n`/`\t`/`\"`/`\\` escapes,
 * and unquoted inline comments introduced by whitespace + `#`.
 */
export function parseEnvFile(text: string): ParsedEnvFile {
  const values: Record<string, string> = {};
  const warnings: string[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  lines.forEach((raw, index) => {
    let line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const equals = line.indexOf('=');
    if (equals <= 0) {
      warnings.push(`line ${index + 1}: expected KEY=VALUE`);
      return;
    }
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) {
      warnings.push(`line ${index + 1}: invalid variable name ${JSON.stringify(key)}`);
      return;
    }
    let value = line.slice(equals + 1).trim();

    if (value.startsWith("'")) {
      const end = value.lastIndexOf("'");
      if (end < 1) {
        warnings.push(`line ${index + 1}: unterminated single-quoted value`);
        return;
      }
      value = value.slice(1, end);
    } else if (value.startsWith('"')) {
      const end = value.lastIndexOf('"');
      if (end < 1) {
        warnings.push(`line ${index + 1}: unterminated double-quoted value`);
        return;
      }
      value = unescapeDoubleQuoted(value.slice(1, end));
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }

    values[key] = value;
  });

  return { values, warnings };
}

/** Read and parse a `.env` file; `null` when it does not exist. */
export async function loadEnvFile(path: string): Promise<ParsedEnvFile | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return parseEnvFile(text);
}

/**
 * Merge file values into an environment without overriding anything the
 * environment already defines (Windows env names are case-insensitive).
 */
export function mergeEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): { env: NodeJS.ProcessEnv; applied: string[] } {
  const caseInsensitive = platform === 'win32';
  const defined = new Set(Object.keys(base).map((key) => (caseInsensitive ? key.toLowerCase() : key)));
  const env: NodeJS.ProcessEnv = { ...base };
  const applied: string[] = [];
  for (const [key, value] of Object.entries(extra)) {
    const probe = caseInsensitive ? key.toLowerCase() : key;
    if (defined.has(probe)) continue;
    env[key] = value;
    defined.add(probe);
    applied.push(key);
  }
  return { env, applied };
}

export interface EnvResolutionOptions {
  /** Directory containing the selected WORKFLOW.md. */
  workflowDir: string;
  /** Process working directory, used as the second search location. */
  cwd?: string;
  /** Explicit `--env-file` path; `null`/absent means "search". */
  explicitPath?: string | null;
  /** Skip `.env` loading entirely (`--no-env-file`). */
  disabled?: boolean;
  /** Base environment (defaults to `process.env`). */
  base?: NodeJS.ProcessEnv;
  /** Test seam for the platform-specific case sensitivity. */
  platform?: NodeJS.Platform;
}

export interface EnvResolution {
  env: NodeJS.ProcessEnv;
  /** The `.env` file that was applied, or `null`. */
  file: string | null;
  /** Names of variables taken from the file (never their values). */
  applied: string[];
  warnings: string[];
}

/**
 * Resolve the effective environment for one workflow load.
 *
 * @throws ValidationError when an explicit `--env-file` does not exist.
 */
export async function resolveEnvironment(options: EnvResolutionOptions): Promise<EnvResolution> {
  const base = options.base ?? process.env;
  if (options.disabled === true) {
    return { env: { ...base }, file: null, applied: [], warnings: [] };
  }

  if (options.explicitPath !== undefined && options.explicitPath !== null) {
    const path = resolve(options.explicitPath);
    const parsed = await loadEnvFile(path);
    if (parsed === null) {
      throw new ValidationError([
        { code: 'missing_env_file', message: `--env-file does not exist: ${path}` },
      ]);
    }
    const merged = mergeEnv(base, parsed.values, options.platform);
    return { env: merged.env, file: path, applied: merged.applied, warnings: parsed.warnings };
  }

  const candidates: string[] = [join(options.workflowDir, '.env')];
  const cwd = options.cwd ?? process.cwd();
  const cwdCandidate = join(cwd, '.env');
  if (resolve(cwdCandidate) !== resolve(candidates[0] as string)) candidates.push(cwdCandidate);

  for (const candidate of candidates) {
    const parsed = await loadEnvFile(candidate);
    if (parsed === null) continue;
    const merged = mergeEnv(base, parsed.values, options.platform);
    return { env: merged.env, file: resolve(candidate), applied: merged.applied, warnings: parsed.warnings };
  }

  return { env: { ...base }, file: null, applied: [], warnings: [] };
}

/** Log an environment resolution without ever printing values. */
export function logEnvironmentResolution(logger: Logger, resolution: EnvResolution): void {
  for (const warning of resolution.warnings) {
    logger.warn('env file problem', { warning });
  }
  if (resolution.file === null) {
    logger.debug('no .env file found; using the launch environment only');
    return;
  }
  logger.info('env file loaded', {
    env_file: resolution.file,
    variables_from_file: resolution.applied.length,
    names: resolution.applied.join(','),
  });
}
