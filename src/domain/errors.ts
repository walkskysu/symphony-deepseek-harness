/**
 * Typed error surface for the workflow/config layers (SPEC 5.5) and for
 * tracker adapters (SPEC 11.4).
 */

export type WorkflowErrorCode =
  | 'missing_workflow_file'
  | 'workflow_parse_error'
  | 'workflow_front_matter_not_a_map'
  | 'template_parse_error'
  | 'template_render_error'
  | 'config_validation_error';

/** An operational error the service can report without a stack trace. */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: WorkflowErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    this.details = details;
  }
}

/** Portable adapter error categories (SPEC 11.4). */
export type TrackerErrorCategory =
  | 'unsupported_tracker_kind'
  | 'invalid_tracker_config'
  | 'missing_tracker_secret'
  | 'tracker_request'
  | 'tracker_status'
  | 'tracker_response'
  | 'tracker_pagination'
  | 'tracker_rate_limited';

export interface TrackerError {
  category: TrackerErrorCategory;
  message: string;
  retryable?: boolean;
  retry_after_ms?: number;
  status?: number;
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function trackerError(
  category: TrackerErrorCategory,
  message: string,
  extra: Omit<TrackerError, 'category' | 'message'> = {},
): TrackerError {
  return { category, message, ...extra };
}

/** A configuration problem that blocks dispatch rather than crashing the service. */
export interface ValidationProblem {
  code: string;
  message: string;
}

export class ValidationError extends Error {
  readonly problems: ValidationProblem[];

  constructor(problems: ValidationProblem[]) {
    super(problems.map((problem) => `${problem.code}: ${problem.message}`).join('; '));
    this.name = 'ValidationError';
    this.problems = problems;
  }
}

/** Normalize any thrown value into a readable one-line message. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
