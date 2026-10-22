/**
 * Candidate eligibility, sorting and concurrency helpers (SPEC 8.2, 8.3).
 */
import type { Issue } from '../domain/types.js';
import { normalizeState, normalizeLabel, type ServiceConfig } from '../config/config.js';

/** Normalized comparator key for one issue state. */
export function stateKey(issue: Issue): string {
  return normalizeState(issue.state);
}

export function isActiveState(issue: Issue, config: ServiceConfig): boolean {
  const key = stateKey(issue);
  return config.tracker.active_states.some((state) => normalizeState(state) === key);
}

export function isTerminalState(issue: Issue, config: ServiceConfig): boolean {
  const key = stateKey(issue);
  return config.tracker.terminal_states.some((state) => normalizeState(state) === key);
}

/** `issue_routable`: only adapter dispatchability plus required labels (SPEC 8.2). */
export function isRoutable(issue: Issue, config: ServiceConfig): boolean {
  if (!issue.dispatchable) return false;
  if (config.tracker.required_labels.length === 0) return true;
  const labels = new Set(issue.labels.map(normalizeLabel));
  return config.tracker.required_labels.every((label) => labels.has(label));
}

/** True when the issue has the identity fields required for dispatch. */
export function hasRequiredIdentity(issue: Issue): boolean {
  return (
    issue.id.trim() !== '' &&
    issue.identifier.trim() !== '' &&
    issue.title.trim() !== '' &&
    issue.state.trim() !== ''
  );
}

function priorityBucket(priority: number | null): number {
  return priority !== null && priority >= 1 && priority <= 4 ? 0 : 1;
}

function createdAtMs(issue: Issue): number | null {
  if (issue.created_at === null) return null;
  const parsed = Date.parse(issue.created_at);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Dispatch order: priority `1..4` ascending, then everything else (null and
 * other integers); oldest `created_at` first with null last; identifier as the
 * final lexicographic tie-breaker.
 */
export function compareForDispatch(left: Issue, right: Issue): number {
  const leftBucket = priorityBucket(left.priority);
  const rightBucket = priorityBucket(right.priority);
  if (leftBucket !== rightBucket) return leftBucket - rightBucket;
  if (left.priority !== right.priority) {
    const leftPriority = left.priority ?? Number.POSITIVE_INFINITY;
    const rightPriority = right.priority ?? Number.POSITIVE_INFINITY;
    if (leftPriority !== rightPriority) return leftPriority < rightPriority ? -1 : 1;
  }
  const leftCreated = createdAtMs(left);
  const rightCreated = createdAtMs(right);
  if (leftCreated !== rightCreated) {
    if (leftCreated === null) return 1;
    if (rightCreated === null) return -1;
    return leftCreated < rightCreated ? -1 : 1;
  }
  return left.identifier.localeCompare(right.identifier);
}

/** Stable sort by dispatch priority. */
export function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort(compareForDispatch);
}

/** Per-state concurrency limit, falling back to the global limit. */
export function stateConcurrencyLimit(config: ServiceConfig, state: string): number {
  const limit = config.agent.max_concurrent_agents_by_state[normalizeState(state)];
  return limit === undefined ? config.agent.max_concurrent_agents : limit;
}

/** Remaining global slots: `max(max_concurrent_agents - running, 0)`. */
export function globalConcurrency(config: ServiceConfig, runningCount: number): number {
  return Math.max(config.agent.max_concurrent_agents - runningCount, 0);
}

/** True when the per-state limit still has room for one more run. */
export function hasStateSlot(
  config: ServiceConfig,
  running: Map<string, { issue: Issue }>,
  state: string,
): boolean {
  const limit = stateConcurrencyLimit(config, state);
  const key = normalizeState(state);
  let count = 0;
  for (const entry of running.values()) {
    if (normalizeState(entry.issue.state) === key) count += 1;
  }
  return count < limit;
}
