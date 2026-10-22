/**
 * Structured logging with the context fields the specification requires
 * (SPEC 13.1, 13.2).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

export interface LogSink {
  write(line: string, level: LogLevel): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Add a human-readable rendering next to the JSON line (default: JSON only). */
  format?: 'json' | 'pretty';
  sink?: LogSink;
  context?: LogContext;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function toPlainContext(context: LogContext | undefined): LogContext {
  if (context === undefined) return {};
  const out: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    if (value instanceof Error) {
      out[key] = value.message;
      continue;
    }
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
      out[key] = value;
      continue;
    }
    try {
      out[key] = JSON.stringify(value);
    } catch {
      out[key] = String(value);
    }
  }
  return out;
}

function prettyLine(timestamp: string, level: LogLevel, message: string, context: LogContext): string {
  const pairs = Object.entries(context)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : String(value)}`)
    .join(' ');
  const prefix = `${timestamp} ${level.toUpperCase().padEnd(5)}`;
  return pairs === '' ? `${prefix} ${message}` : `${prefix} ${message} ${pairs}`;
}

export class StructuredLogger implements Logger {
  private readonly level: LogLevel;
  private readonly format: 'json' | 'pretty';
  private readonly sink: LogSink;
  private readonly baseContext: LogContext;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.format = options.format ?? 'json';
    this.sink = options.sink ?? new StreamSink();
    this.baseContext = toPlainContext(options.context);
  }

  private emit(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const merged: LogContext = { ...this.baseContext, ...toPlainContext(context) };
    const timestamp = new Date().toISOString();
    if (this.format === 'pretty') {
      this.writeSafely(prettyLine(timestamp, level, message, merged), level);
      return;
    }
    const record = { ts: timestamp, level, msg: message, ...merged };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: timestamp, level, msg: message, serialization_error: true });
    }
    this.writeSafely(line, level);
  }

  private writeSafely(line: string, level: LogLevel): void {
    try {
      this.sink.write(line, level);
    } catch (error) {
      // A broken sink must never take the orchestrator down (SPEC 13.2).
      try {
        process.stderr.write(
          `${JSON.stringify({
            ts: new Date().toISOString(),
            level: 'warn',
            msg: 'log sink write failed',
            error: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
      } catch {
        // Nothing left to report to.
      }
    }
  }

  debug(message: string, context?: LogContext): void {
    this.emit('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.emit('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.emit('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.emit('error', message, context);
  }

  child(context: LogContext): Logger {
    return new StructuredLogger({
      level: this.level,
      format: this.format,
      sink: this.sink,
      context: { ...this.baseContext, ...toPlainContext(context) },
    });
  }
}

/** Writes JSON/pretty log lines to stdout. */
export class StreamSink implements LogSink {
  write(line: string, _level: LogLevel): void {
    process.stdout.write(`${line}\n`);
  }
}

/** Appends log lines to a file, creating parent directories as needed. */
export class FileSink implements LogSink {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(line: string, _level: LogLevel): void {
    appendFileSync(this.path, `${line}\n`, 'utf8');
  }
}

/** Fan out to several sinks; the first failure is reported, never thrown. */
export class MultiSink implements LogSink {
  private readonly failures: string[] = [];

  constructor(private readonly sinks: LogSink[]) {}

  write(line: string, level: LogLevel): void {
    for (const sink of this.sinks) {
      try {
        sink.write(line, level);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!this.failures.includes(message)) {
          this.failures.push(message);
          process.stderr.write(
            `${JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg: 'log sink failed', error: message })}\n`,
          );
        }
      }
    }
  }
}

/** A logger that discards everything, for tests. */
export class NullLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): Logger {
    return this;
  }
}

/** Create a structured logger writing JSON to stdout, optionally mirroring to a file. */
export function createLogger(options: LoggerOptions & { filePath?: string } = {}): Logger {
  const sinks: LogSink[] = [options.sink ?? new StreamSink()];
  if (options.filePath !== undefined) {
    try {
      sinks.push(new FileSink(options.filePath));
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: 'warn',
          msg: 'file log sink unavailable',
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }
  }
  return new StructuredLogger({
    ...options,
    sink: sinks.length === 1 ? (sinks[0] as LogSink) : new MultiSink(sinks),
  });
}
