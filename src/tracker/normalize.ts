/** Shared normalization rules for adapter payloads (SPEC 4.1.1, 11.3). */
import type { BlockerRef, Issue } from '../domain/types.js';

export function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Trim, lowercase, drop blanks and duplicates while preserving first-seen order. */
export function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const label = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (label === '' || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/** Parse an RFC 3339 instant into a normalized ISO string, or null. */
export function parseInstant(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

/** Normalize a blocker list best-effort; unusable entries are dropped. */
export function normalizeBlockers(value: unknown): BlockerRef[] {
  if (!Array.isArray(value)) return [];
  const out: BlockerRef[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const blocker: BlockerRef = {
      id: nonEmptyString(record['id']),
      identifier: nonEmptyString(record['identifier']),
      state: typeof record['state'] === 'string' ? record['state'] : null,
    };
    if (blocker.id === null && blocker.identifier === null) continue;
    out.push(blocker);
  }
  return out;
}

/** Normalize an optional integer priority. */
export function normalizePriority(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** Lowercase + trim a state for scheduler comparison. */
export function normalizeStateKey(state: string): string {
  return state.trim().toLowerCase();
}

/** The required normalized field set, used to reject malformed records. */
export interface RawIssueFields {
  id: unknown;
  identifier: unknown;
  title: unknown;
  state: unknown;
  dispatchable: unknown;
}

export type MalformedReason = string;

/**
 * Build a normalized issue from a provider mapping.
 *
 * Required fields (`id`, `identifier`, `title`, `state`, explicit
 * `dispatchable`) are never defaulted; a record missing any of them is
 * malformed and reported to the caller instead of being silently normalized.
 */
export function buildIssue(
  raw: RawIssueFields,
  optional: {
    native_ref?: Record<string, unknown> | null;
    description?: unknown;
    priority?: unknown;
    branch_name?: unknown;
    url?: unknown;
    assignee_id?: unknown;
    labels?: unknown;
    blocked_by?: unknown;
    created_at?: unknown;
    updated_at?: unknown;
  } = {},
): { ok: true; issue: Issue } | { ok: false; reason: MalformedReason } {
  const id = nonEmptyString(raw.id);
  const identifier = nonEmptyString(raw.identifier);
  const title = nonEmptyString(raw.title);
  const state = nonEmptyString(raw.state);
  if (id === null) return { ok: false, reason: 'missing required field: id' };
  if (identifier === null) return { ok: false, reason: 'missing required field: identifier' };
  if (title === null) return { ok: false, reason: 'missing required field: title' };
  if (state === null) return { ok: false, reason: 'missing required field: state' };
  if (typeof raw.dispatchable !== 'boolean') return { ok: false, reason: 'missing required boolean field: dispatchable' };

  return {
    ok: true,
    issue: {
      id,
      native_ref: optional.native_ref === undefined ? null : optional.native_ref,
      identifier,
      title,
      description: nonEmptyString(optional.description) ?? (typeof optional.description === 'string' ? optional.description : null),
      priority: normalizePriority(optional.priority),
      state,
      branch_name: nonEmptyString(optional.branch_name),
      url: nonEmptyString(optional.url),
      assignee_id: nonEmptyString(optional.assignee_id),
      labels: normalizeLabels(optional.labels),
      blocked_by: normalizeBlockers(optional.blocked_by),
      dispatchable: raw.dispatchable,
      created_at: parseInstant(optional.created_at),
      updated_at: parseInstant(optional.updated_at),
    },
  };
}
