/**
 * Turn a configured command into a concrete, directly spawnable program.
 *
 * Prompts never travel on the command line, so quoting only has to handle
 * configuration-owned tokens. On Windows, npm-style `.cmd` shims are executed
 * through `cmd.exe` because Node cannot spawn a batch file directly, and
 * `.ps1` shims are avoided on purpose: a restricted execution policy would
 * reject them.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname } from 'node:path';

export interface ProgramPlan {
  file: string;
  args: string[];
  /** True when `file` is a shell that receives the whole command as one argument. */
  via_shell: boolean;
  /** Human-readable form for logs (never contains secrets). */
  description: string;
}

export interface PlanOptions {
  platform?: NodeJS.Platform;
  /** Test seam: resolve a bare program name to candidate absolute paths. */
  locate?: (program: string) => string[];
}

const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function locateOnPath(program: string): string[] {
  if (process.platform === 'win32') {
    const probe = spawnSync('where.exe', [program], { encoding: 'utf8', windowsHide: true });
    if (probe.status !== 0 || typeof probe.stdout !== 'string') return [];
    return probe.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && existsSync(line));
  }
  const probe = spawnSync('sh', ['-c', `command -v ${JSON.stringify(program)}`], { encoding: 'utf8' });
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return [];
  const found = probe.stdout.trim();
  return found === '' ? [] : [found];
}

function scoreCandidate(path: string): number {
  const extension = extname(path).toLowerCase();
  if (extension === '.ps1') return 100; // Last resort: may be blocked by policy.
  if (extension === '.exe') return 0;
  if (extension === '.cmd') return 1;
  if (extension === '.bat') return 2;
  if (extension === '') return 3;
  return 10;
}

function needsQuoting(arg: string): boolean {
  return /[\s"&|<>^()]/.test(arg);
}

/** Quote one argument for `cmd.exe /c`. */
export function quoteCmdArg(arg: string): string {
  if (!needsQuoting(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function splitCommand(command: string): string[] {
  // The configured command is a shell command string, but the supported form is
  // `program [args...]` with simple quoting.
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of command.trim()) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current !== '') {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current !== '') tokens.push(current);
  return tokens;
}

/** Plan how to launch `command` with `extraArgs` appended. */
export function planProgram(command: string, extraArgs: string[], options: PlanOptions = {}): ProgramPlan {
  const platform = options.platform ?? process.platform;
  const tokens = splitCommand(command);
  const program = tokens[0];
  if (program === undefined || program === '') throw new Error('agent command is empty');
  const baseArgs = [...tokens.slice(1), ...extraArgs];

  const scriptExtension = extname(program).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(scriptExtension)) {
    // A JavaScript entry point: run it with this Node.js binary.
    return {
      file: process.execPath,
      args: [program, ...baseArgs],
      via_shell: false,
      description: `node ${program} ${baseArgs.join(' ')}`.trim(),
    };
  }

  const hasPathSeparator = /[\\/]/.test(program);
  let resolved = program;
  let candidates: string[] = [];
  if (!hasPathSeparator) {
    candidates = (options.locate ?? locateOnPath)(program).sort((left, right) => scoreCandidate(left) - scoreCandidate(right));
    const best = candidates[0];
    if (best !== undefined) resolved = best;
  }

  if (platform === 'win32') {
    const extension = extname(resolved).toLowerCase();
    if (extension === '.cmd' || extension === '.bat') {
      const line = [quoteCmdArg(resolved), ...baseArgs.map(quoteCmdArg)].join(' ');
      return {
        file: 'cmd.exe',
        args: ['/d', '/s', '/c', line],
        via_shell: true,
        description: line,
      };
    }
  }

  return {
    file: resolved,
    args: baseArgs,
    via_shell: false,
    description: [resolved, ...baseArgs].join(' '),
  };
}
