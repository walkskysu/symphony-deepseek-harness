/** Tracker adapter registry (SPEC 5.3.1, 11.2). */
import { err, ok, trackerError, type Result, type TrackerError } from '../domain/errors.js';
import type { AdapterStateDefaults } from '../config/config.js';
import type { TrackerAdapter, TrackerFactoryArgs } from './adapter.js';
import { createGitHubAdapter, GitHubTrackerAdapter } from './github.js';
import { createMemoryAdapter, MemoryTrackerAdapter } from './memory.js';

export interface AdapterCreateArgs extends TrackerFactoryArgs {
  onWarning?: (message: string, context?: Record<string, unknown>) => void;
}

export const SUPPORTED_TRACKER_KINDS = ['github', 'memory'] as const;

/** Documented state defaults for an omitted state list. */
export function adapterStateDefaults(
  kind: string,
  provider: Record<string, unknown>,
): AdapterStateDefaults | undefined {
  switch (kind.trim().toLowerCase()) {
    case 'github':
      return GitHubTrackerAdapter.stateDefaults(provider);
    case 'memory':
      return MemoryTrackerAdapter.stateDefaults();
    default:
      return undefined;
  }
}

/** Build the configured adapter, or a portable error if the kind is unknown. */
export function createTrackerAdapter(kind: string, args: AdapterCreateArgs): Result<TrackerAdapter, TrackerError> {
  switch (kind.trim().toLowerCase()) {
    case 'github':
      return createGitHubAdapter(args);
    case 'memory':
      return createMemoryAdapter(args);
    default:
      return err(
        trackerError(
          'unsupported_tracker_kind',
          `unsupported tracker.kind ${JSON.stringify(kind)}; supported kinds: ${SUPPORTED_TRACKER_KINDS.join(', ')}`,
        ),
      );
  }
}

/** True when the registry can build the given tracker kind. */
export function isSupportedTrackerKind(kind: string): boolean {
  return (SUPPORTED_TRACKER_KINDS as readonly string[]).includes(kind.trim().toLowerCase());
}

export { createGitHubAdapter, createMemoryAdapter };
export type { TrackerAdapter, ToolSpec, ToolResult, ToolContext, AdapterProfile } from './adapter.js';
export { ok, err };
