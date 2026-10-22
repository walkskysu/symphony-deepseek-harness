/**
 * Host shell and subprocess layer.
 *
 * The specification asks for a local shell context appropriate to the host OS
 * (SPEC 9.4, 10.1). On POSIX hosts that is `sh -lc` (or a stricter equivalent);
 * on Windows this implementation prefers `bash -lc` when a bash is on PATH and
 * otherwise uses `powershell -NoProfile -NonInteractive -Command`, which avoids
 * the script-file execution policy that blocks `.ps1` shims.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface ShellSpec {
  file: string;
  args: string[];
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  spawnError: Error | null;
  pid: number | null;
}

export interface SpawnProcessOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Written to the child's stdin before it is closed. */
  stdin?: string;
  /** Keep stdin open for a bidirectional protocol transport. */
  keepStdinOpen?: boolean;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  maxCapturedBytes?: number;
}

export interface RunningProcess {
  child: ChildProcessWithoutNullStreams;
  pid: number | null;
  result: Promise<SpawnResult>;
  kill: (reason?: string) => void;
}

const DEFAULT_MAX_CAPTURE = 256 * 1024;

let cachedBash: string | null | undefined;

/**
 * Locate a host-native bash on Windows.
 *
 * `where bash` typically finds two things: Git Bash from Git for Windows, and
 * the `bash.exe` app-execution alias under `WindowsApps`, which launches WSL.
 * WSL bash cannot use a Windows directory as its cwd, so it is rejected here;
 * when no native bash exists the caller falls back to PowerShell.
 */
function findBash(): string | null {
  if (process.platform !== 'win32') return null;
  const probe = spawnSync('where.exe', ['bash'], { encoding: 'utf8', windowsHide: true });
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return null;
  for (const candidate of probe.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')) {
    if (/[\\/]WindowsApps[\\/]/i.test(candidate)) continue;
    const version = spawnSync(candidate, ['-c', 'uname -r'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    });
    if (version.status !== 0 || typeof version.stdout !== 'string') continue;
    if (/microsoft|wsl/i.test(version.stdout)) continue;
    return candidate;
  }
  return null;
}

/** True when a host-native bash is available for shell scripts. */
export function hasBash(): boolean {
  if (cachedBash === undefined) cachedBash = findBash();
  return cachedBash !== null;
}

/** Absolute path of the host-native bash, or null. */
export function bashPath(): string | null {
  if (cachedBash === undefined) cachedBash = findBash();
  return cachedBash;
}

/** Reset the cached executable probe (tests). */
export function resetExecutableCache(): void {
  cachedBash = undefined;
}

/** Split a shell command specification such as `bash -lc` into program and args. */
export function parseShellSpec(spec: string): ShellSpec {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of spec.trim()) {
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
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current !== '') args.push(current);
  const [file, ...rest] = args;
  if (file === undefined || file === '') return defaultShell();
  return { file, args: rest };
}

/** The platform default shell used for hooks and agent launches. */
export function defaultShell(platform: NodeJS.Platform = process.platform): ShellSpec {
  if (platform === 'win32') {
    const bash = bashPath();
    if (bash !== null) return { file: bash, args: ['-lc'] };
    // A script block, not a script file, so a restricted script-file execution
    // policy cannot block it; `Bypass` keeps npm/gh shims usable in the hook.
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'],
    };
  }
  return { file: 'sh', args: ['-lc'] };
}

/** Resolve the shell: an explicit config value wins, otherwise the platform default. */
export function resolveShell(shell: string | null | undefined): ShellSpec {
  if (shell === null || shell === undefined || shell.trim() === '') return defaultShell();
  return parseShellSpec(shell);
}

/**
 * Append a script to a shell specification.
 *
 * The spec must already carry its command flag (`bash -lc`,
 * `powershell -Command`, `node -e`), so the script is always the final
 * argument. `bash -l` without `-c` would treat the script as a file name, which
 * is why the documented default shells all include the flag.
 */
export function buildShellInvocation(spec: ShellSpec, script: string): { file: string; args: string[] } {
  return { file: spec.file, args: [...spec.args, script] };
}

function splitLines(onLine: (line: string) => void): (chunk: string, final: boolean) => void {
  let buffer = '';
  return (chunk: string, final: boolean) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      onLine(line);
    }
    if (final && buffer !== '') {
      onLine(buffer.replace(/\r$/, ''));
      buffer = '';
    }
  };
}

/** Kill a process and its children, using `taskkill` on Windows for the tree. */
export function terminateProcess(child: ChildProcessWithoutNullStreams, reason = 'terminated'): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }, 2_000).unref();
  } catch {
    // Nothing else to do; the process is already gone.
  }
  void reason;
}

/**
 * Spawn a child process with line-oriented output callbacks, an optional
 * timeout and abort signal, and bounded capture buffers.
 */
export function spawnProcess(options: SpawnProcessOptions): RunningProcess {
  const maxCapture = options.maxCapturedBytes ?? DEFAULT_MAX_CAPTURE;
  const child = spawn(options.file, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'pipe',
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let spawnError: Error | null = null;
  let settled = false;
  let timer: NodeJS.Timeout | null = null;

  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  const stdoutLines = splitLines((line) => options.onStdoutLine?.(line));
  const stderrLines = splitLines((line) => options.onStderrLine?.(line));

  child.stdout.on('data', (chunk: Buffer) => {
    const text = stdoutDecoder.write(chunk);
    if (stdout.length < maxCapture) stdout += text.slice(0, maxCapture - stdout.length);
    stdoutLines(text, false);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const text = stderrDecoder.write(chunk);
    if (stderr.length < maxCapture) stderr += text.slice(0, maxCapture - stderr.length);
    stderrLines(text, false);
  });

  if (typeof options.stdin === 'string') {
    child.stdin.write(options.stdin);
  }
  if (options.keepStdinOpen !== true) child.stdin.end();

  const kill = (reason?: string): void => {
    terminateProcess(child, reason ?? 'cancelled');
  };

  const onAbort = (): void => kill('aborted');
  if (options.signal !== undefined) {
    if (options.signal.aborted) kill('aborted');
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  const result = new Promise<SpawnResult>((resolve) => {
    const finalize = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort);
      stdoutLines(stdoutDecoder.end(), true);
      stderrLines(stderrDecoder.end(), true);
      resolve({ code, signal, timedOut, stdout, stderr, spawnError, pid: child.pid ?? null });
    };

    child.on('error', (error: Error) => {
      spawnError = error;
      finalize(null, null);
    });
    child.on('close', (code, signal) => finalize(code, signal));

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill('timeout');
        // Give the tree a moment, then settle even if close never arrives.
        setTimeout(() => finalize(null, 'SIGKILL' as NodeJS.Signals), 1_500).unref();
      }, options.timeoutMs);
      timer.unref();
    }
  });

  return { child, pid: child.pid ?? null, result, kill };
}

/** Run a one-shot command to completion with a hard timeout. */
export function runProcess(options: SpawnProcessOptions): Promise<SpawnResult> {
  return spawnProcess(options).result;
}

/** Run a hook/script through a shell specification. */
export function runShellScript(
  spec: ShellSpec,
  script: string,
  options: Omit<SpawnProcessOptions, 'file' | 'args' | 'stdin'>,
): Promise<SpawnResult> {
  const invocation = buildShellInvocation(spec, script);
  return runProcess({ ...options, file: invocation.file, args: invocation.args });
}

/** Shorten captured output for log records (SPEC 15.4). */
export function truncateOutput(text: string, max = 2_000): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}… [truncated ${trimmed.length - max} chars]`;
}
