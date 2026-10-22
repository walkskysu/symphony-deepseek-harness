/** Cross-platform path safety helpers (SPEC 9.5, 15.2). */
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** True when `candidate` is `root` itself or strictly inside it. */
export function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === '') return true;
  if (rel.startsWith(`..${sep}`) || rel === '..') return false;
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * Assert that `candidate` stays inside `root`.
 *
 * @throws Error with a stable message when the containment invariant breaks.
 */
export function assertInsideRoot(root: string, candidate: string): void {
  if (!isPathInside(root, candidate)) {
    throw new Error(`workspace path escapes workspace root: ${candidate} is not inside ${root}`);
  }
}

/** Windows device names that cannot be used as a directory name. */
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_value, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_value, index) => `lpt${index + 1}`),
]);

/** True when a name is unusable as a Windows directory name. */
export function isWindowsReservedName(name: string): boolean {
  const stem = name.split('.')[0]?.toLowerCase() ?? '';
  return WINDOWS_RESERVED.has(stem);
}

/** Normalize a filesystem path for comparison. */
export function normalizePath(path: string): string {
  return resolve(path);
}
