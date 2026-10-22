/**
 * In-memory tracker adapter.
 *
 * It exists for deterministic tests, local demos without credentials, and
 * end-to-end smoke runs of the daemon. Issues are supplied through
 * `tracker.provider.issues`; when `tracker.provider.file` is set, the JSON file
 * is re-read on every fetch so an operator (or a test) can move issues between
 * states while the daemon runs.
 *
 * Provider keys:
 *   - `issues`: list of raw issue records (default `[]`)
 *   - `file`: path to a JSON file containing such a list (relative to cwd)
 *
 * State defaults: active `["open"]`, terminal `["closed"]`.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Issue } from '../domain/types.js';
import { ok, err, trackerError, describeError, type Result, type TrackerError } from '../domain/errors.js';
import type { AdapterProfile, ToolContext, ToolResult, ToolSpec, TrackerAdapter, TrackerFactoryArgs } from './adapter.js';
import { buildIssue, normalizeStateKey } from './normalize.js';

export interface MemoryIssueRecord extends Record<string, unknown> {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  state?: unknown;
  dispatchable?: unknown;
}

export interface MemoryAdapterOptions extends TrackerFactoryArgs {
  onWarning?: (message: string, context?: Record<string, unknown>) => void;
}

const PROFILE: AdapterProfile = {
  kind: 'memory',
  display_name: 'In-memory issue list',
  required_provider_keys: [],
  optional_provider_keys: {
    issues: '[]',
    file: 'null',
  },
  secret_environment_names: [],
  default_states: { active_states: ['open'], terminal_states: ['closed'] },
  tool_names: ['issue_set_state', 'issue_comment'],
};

export class MemoryTrackerAdapter implements TrackerAdapter {
  readonly kind = 'memory';
  readonly profile = PROFILE;
  private records: MemoryIssueRecord[];
  private readonly filePath: string | null;
  private readonly activeStates: Set<string>;
  private readonly terminalStates: Set<string>;
  readonly comments: Array<{ identifier: string; body: string; at: string }> = [];

  constructor(options: MemoryAdapterOptions) {
    const provider = options.provider;
    this.records = Array.isArray(provider['issues']) ? (provider['issues'] as MemoryIssueRecord[]) : [];
    const file = provider['file'];
    this.filePath = typeof file === 'string' && file.trim() !== '' ? resolve(file.trim()) : null;
    this.activeStates = new Set(options.active_states.map(normalizeStateKey));
    this.terminalStates = new Set(options.terminal_states.map(normalizeStateKey));
  }

  static stateDefaults(): { active_states?: string[]; terminal_states?: string[] } {
    return { active_states: ['open'], terminal_states: ['closed'] };
  }

  /** Replace the in-memory issue records (tests and local demos). */
  setRecords(records: MemoryIssueRecord[]): void {
    this.records = records;
  }

  private async loadRecords(): Promise<MemoryIssueRecord[]> {
    if (this.filePath === null) return this.records;
    const text = await readFile(this.filePath, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`memory adapter file must contain a JSON array: ${this.filePath}`);
    this.records = parsed as MemoryIssueRecord[];
    return this.records;
  }

  private normalize(record: MemoryIssueRecord): { ok: true; issue: Issue } | { ok: false; reason: string } {
    return buildIssue(
      {
        id: record['id'],
        identifier: record['identifier'],
        title: record['title'],
        state: record['state'],
        dispatchable: typeof record['dispatchable'] === 'boolean' ? record['dispatchable'] : true,
      },
      {
        native_ref: (record['native_ref'] as Record<string, unknown> | undefined) ?? null,
        description: record['description'],
        priority: record['priority'],
        branch_name: record['branch_name'],
        url: record['url'],
        assignee_id: record['assignee_id'],
        labels: record['labels'],
        blocked_by: record['blocked_by'],
        created_at: record['created_at'],
        updated_at: record['updated_at'],
      },
    );
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Result<Issue[], TrackerError>> {
    if (stateNames.length === 0) return ok([]);
    const requested = new Set(stateNames.map(normalizeStateKey));
    let records: MemoryIssueRecord[];
    try {
      records = await this.loadRecords();
    } catch (error) {
      return err(trackerError('tracker_response', `cannot load memory issues: ${describeError(error)}`));
    }
    const issues: Issue[] = [];
    for (const record of records) {
      const normalized = this.normalize(record);
      if (!normalized.ok) continue;
      if (requested.has(normalizeStateKey(normalized.issue.state))) issues.push(normalized.issue);
    }
    return ok(issues);
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Result<Issue[], TrackerError>> {
    if (issueIds.length === 0) return ok([]);
    const wanted = new Set(issueIds);
    let records: MemoryIssueRecord[];
    try {
      records = await this.loadRecords();
    } catch (error) {
      return err(trackerError('tracker_response', `cannot load memory issues: ${describeError(error)}`));
    }
    const issues: Issue[] = [];
    for (const record of records) {
      if (typeof record['id'] !== 'string' || !wanted.has(record['id'])) continue;
      const normalized = this.normalize(record);
      if (!normalized.ok) {
        return err(trackerError('tracker_response', `malformed issue ${String(record['id'])}: ${normalized.reason}`));
      }
      issues.push(normalized.issue);
    }
    return ok(issues);
  }

  secretEnvironmentNames(): string[] {
    return [];
  }

  agentToolSpecs(): ToolSpec[] {
    return [
      {
        name: 'issue_set_state',
        description: 'Set the state of the current issue (for example `review`).',
        mutates: true,
        input_schema: {
          type: 'object',
          properties: { state: { type: 'string', description: 'New state name' } },
          required: ['state'],
          additionalProperties: false,
        },
      },
      {
        name: 'issue_comment',
        description: 'Append a comment to the current issue.',
        mutates: true,
        input_schema: {
          type: 'object',
          properties: { body: { type: 'string', description: 'Comment body' } },
          required: ['body'],
          additionalProperties: false,
        },
      },
    ];
  }

  async executeAgentTool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const record = this.records.find((candidate) => candidate['id'] === context.issue.id);
    if (record === undefined) {
      return { ok: false, error: { category: 'not_found', message: `issue ${context.issue.id} is not in the memory tracker` } };
    }
    if (name === 'issue_set_state') {
      const state = args['state'];
      if (typeof state !== 'string' || state.trim() === '') {
        return { ok: false, error: { category: 'invalid_arguments', message: 'state must be a non-empty string' } };
      }
      record['state'] = state.trim();
      record['updated_at'] = new Date().toISOString();
      return { ok: true, output: { state: record['state'] } };
    }
    if (name === 'issue_comment') {
      const body = args['body'];
      if (typeof body !== 'string' || body.trim() === '') {
        return { ok: false, error: { category: 'invalid_arguments', message: 'body must be a non-empty string' } };
      }
      this.comments.push({ identifier: context.issue.identifier, body, at: new Date().toISOString() });
      return { ok: true, output: { commented: true } };
    }
    return { ok: false, error: { category: 'unsupported_tool', message: `unknown memory tool: ${name}` } };
  }

  /** States this adapter considers active, used by tools and tests. */
  get active_state_names(): string[] {
    return [...this.activeStates];
  }

  /** States this adapter considers terminal. */
  get terminal_state_names(): string[] {
    return [...this.terminalStates];
  }
}

/** Create a memory adapter from tracker config. */
export function createMemoryAdapter(options: MemoryAdapterOptions): Result<TrackerAdapter, TrackerError> {
  const provider = options.provider;
  if (provider['issues'] !== undefined && !Array.isArray(provider['issues'])) {
    return err(trackerError('invalid_tracker_config', 'tracker.provider.issues must be a list'));
  }
  return ok(new MemoryTrackerAdapter(options));
}
