/**
 * GitHub issue tracker adapter (SPEC section 11).
 *
 * Scope selection is one or more `owner/name` repositories. The normalized
 * `Issue.id` is `<owner>/<repo>#<number>`, which is the dispatch identity, while
 * `native_ref` keeps the repository, issue number and node id for
 * provider-native tools.
 *
 * Two state sources are supported because GitHub issues only have
 * `open`/`closed` natively:
 *
 *  - `issue_state` (default without a label prefix): state is `open`/`closed`.
 *  - `labels`: the state is taken from the first label starting with
 *    `label_prefix` (default `status:`), falling back to `open`/`closed`.
 *
 * The full profile is published in `docs/adapter-github.md`.
 */
import type { Issue } from '../domain/types.js';
import { ok, err, trackerError, describeError, type Result, type TrackerError } from '../domain/errors.js';
import type {
  AdapterProfile,
  ToolContext,
  ToolResult,
  ToolSpec,
  TrackerAdapter,
  TrackerFactoryArgs,
} from './adapter.js';
import { buildIssue, normalizeLabels, normalizeStateKey } from './normalize.js';
import { resolveEnvReference } from '../config/config.js';

const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TOKEN_ENV = 'GITHUB_TOKEN';
const DEFAULT_LABEL_PREFIX = 'status:';

interface RepoScope {
  owner: string;
  name: string;
  full: string;
}

export interface GitHubAdapterOptions extends TrackerFactoryArgs {
  onWarning?: (message: string, context?: Record<string, unknown>) => void;
}

interface GitHubIssuePayload {
  number?: unknown;
  node_id?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  html_url?: unknown;
  labels?: unknown;
  assignee?: unknown;
  assignees?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  pull_request?: unknown;
}

interface ParsedConfig {
  repositories: RepoScope[];
  token: string;
  tokenEnvName: string;
  apiBase: string;
  stateSource: 'issue_state' | 'labels';
  labelPrefix: string;
  /**
   * When several `status:*` labels are present, the first state listed here
   * wins. Without it the first matching label in payload order is used, which
   * depends on the order the labels were added.
   */
  statePriority: string[];
  requireAssignee: boolean;
  assignee: string | null;
  pageSize: number;
  requestTimeoutMs: number;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes' || normalized === '1') return true;
    if (normalized === 'false' || normalized === 'no' || normalized === '0') return false;
  }
  return fallback;
}

function asPositiveInt(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function parseRepo(value: string): RepoScope | null {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value.trim().replace(/\.git$/, ''));
  if (match === null) return null;
  return { owner: match[1] as string, name: match[2] as string, full: `${match[1]}/${match[2]}` };
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry);
    else if (typeof entry === 'object' && entry !== null) {
      const name = (entry as Record<string, unknown>)['name'];
      if (typeof name === 'string') out.push(name);
    }
  }
  return out;
}

/** Derive a 1-based priority from common priority label spellings. */
export function priorityFromLabels(labels: string[]): number | null {
  for (const label of labels) {
    const match = /^(?:p|prio|priority)[:/_-]?([1-9])$/.exec(label);
    if (match !== null) return Number(match[1]);
  }
  return null;
}

interface RequestSuccess {
  ok: true;
  status: number;
  headers: Headers;
  body: unknown;
}

interface RequestFailure {
  ok: false;
  /** Provider status, or 0 for a transport failure before any response. */
  status: number;
  error: TrackerError;
}

type RequestResult = RequestSuccess | RequestFailure;

function requestFailure(error: TrackerError, status = 0): RequestFailure {
  return { ok: false, status, error };
}

export class GitHubTrackerAdapter implements TrackerAdapter {
  readonly kind = 'github';
  readonly profile: AdapterProfile;
  private readonly config: ParsedConfig;
  private readonly activeStates: Set<string>;
  private readonly terminalStates: Set<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly onWarning: (message: string, context?: Record<string, unknown>) => void;

  constructor(config: ParsedConfig, activeStates: string[], terminalStates: string[], args: GitHubAdapterOptions) {
    this.config = config;
    this.activeStates = new Set(activeStates.map(normalizeStateKey));
    this.terminalStates = new Set(terminalStates.map(normalizeStateKey));
    this.fetchImpl = args.fetch ?? globalThis.fetch;
    this.onWarning = args.onWarning ?? (() => undefined);
    this.profile = {
      kind: 'github',
      display_name: 'GitHub Issues',
      required_provider_keys: ['repository (owner/name) or repositories'],
      optional_provider_keys: {
        token: 'delegates to $GITHUB_TOKEN unless `token_env` names another variable',
        token_env: DEFAULT_TOKEN_ENV,
        api_base: DEFAULT_API_BASE,
        state_source: 'issue_state',
        label_prefix: DEFAULT_LABEL_PREFIX,
        state_priority: '[] — when several status labels are present, the first state listed wins',
        assignee: 'null',
        require_assignee: 'false',
        page_size: String(DEFAULT_PAGE_SIZE),
        request_timeout_ms: String(DEFAULT_REQUEST_TIMEOUT_MS),
      },
      secret_environment_names: [config.tokenEnvName, DEFAULT_TOKEN_ENV, 'GH_TOKEN'],
      default_states:
        config.stateSource === 'issue_state'
          ? { active_states: ['open'], terminal_states: ['closed'] }
          : undefined,
      tool_names: GITHUB_TOOLS.map((tool) => tool.spec.name),
    };
  }

  /** Documented adapter defaults used during config resolution. */
  static stateDefaults(provider: Record<string, unknown>): { active_states?: string[]; terminal_states?: string[] } | undefined {
    const stateSource = asString(provider['state_source'])?.toLowerCase() ?? null;
    const hasPrefix = asString(provider['label_prefix']) !== null;
    const labelsMode = stateSource === 'labels' || (stateSource === null && hasPrefix);
    if (labelsMode) return undefined;
    if (stateSource !== null && stateSource !== 'issue_state' && stateSource !== 'labels') return undefined;
    return { active_states: ['open'], terminal_states: ['closed'] };
  }

  /** Validate and build the adapter. Never performs network I/O. */
  static create(args: GitHubAdapterOptions): Result<GitHubTrackerAdapter, TrackerError> {
    const provider = args.provider;
    const repositoryValues: string[] = [];
    const single = asString(provider['repository']);
    if (single !== null) repositoryValues.push(single);
    const many = provider['repositories'];
    if (Array.isArray(many)) {
      for (const entry of many) {
        const value = asString(entry);
        if (value !== null) repositoryValues.push(value);
      }
    }
    if (repositoryValues.length === 0) {
      return err(
        trackerError(
          'invalid_tracker_config',
          'tracker.provider.repository is required, for example `octocat/hello-world` (or provide `repositories`)',
        ),
      );
    }
    const repositories: RepoScope[] = [];
    for (const value of repositoryValues) {
      const parsed = parseRepo(value);
      if (parsed === null) {
        return err(trackerError('invalid_tracker_config', `invalid repository selector: ${JSON.stringify(value)}`));
      }
      if (!repositories.some((repo) => repo.full === parsed.full)) repositories.push(parsed);
    }

    const tokenEnvName = asString(provider['token_env']) ?? DEFAULT_TOKEN_ENV;
    const rawToken = asString(provider['token']);
    let token: string | null;
    if (rawToken === null) {
      token = args.env[tokenEnvName] ?? null;
    } else {
      token = resolveEnvReference(rawToken, args.env);
    }
    if (token === null || token === '') {
      return err(
        trackerError(
          'missing_tracker_secret',
          `GitHub token is not configured; set $${tokenEnvName} or tracker.provider.token`,
        ),
      );
    }

    const stateSourceRaw = asString(provider['state_source'])?.toLowerCase() ?? null;
    if (stateSourceRaw !== null && stateSourceRaw !== 'issue_state' && stateSourceRaw !== 'labels') {
      return err(
        trackerError('invalid_tracker_config', `state_source must be "issue_state" or "labels", got ${JSON.stringify(stateSourceRaw)}`),
      );
    }
    const labelPrefix = asString(provider['label_prefix']) ?? DEFAULT_LABEL_PREFIX;
    const stateSource: 'issue_state' | 'labels' =
      stateSourceRaw === 'labels' || (stateSourceRaw === null && asString(provider['label_prefix']) !== null)
        ? 'labels'
        : 'issue_state';

    const pageSize = asPositiveInt(provider['page_size'], DEFAULT_PAGE_SIZE, 1, 100);
    if (pageSize === null) {
      return err(trackerError('invalid_tracker_config', 'page_size must be an integer between 1 and 100'));
    }
    const statePriorityRaw = provider['state_priority'];
    let statePriority: string[] = [];
    if (statePriorityRaw !== undefined && statePriorityRaw !== null) {
      if (!Array.isArray(statePriorityRaw)) {
        return err(trackerError('invalid_tracker_config', 'state_priority must be a list of state names'));
      }
      statePriority = statePriorityRaw
        .map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
        .filter((entry) => entry !== '');
    }
    const requestTimeoutMs = asPositiveInt(provider['request_timeout_ms'], DEFAULT_REQUEST_TIMEOUT_MS, 1, 600_000);
    if (requestTimeoutMs === null) {
      return err(trackerError('invalid_tracker_config', 'request_timeout_ms must be a positive integer'));
    }
    const apiBaseRaw = asString(provider['api_base']) ?? DEFAULT_API_BASE;
    let apiBase: string;
    try {
      apiBase = new URL(apiBaseRaw).toString().replace(/\/$/, '');
    } catch {
      return err(trackerError('invalid_tracker_config', `api_base is not a valid URL: ${JSON.stringify(apiBaseRaw)}`));
    }

    return ok(
      new GitHubTrackerAdapter(
        {
          repositories,
          token,
          tokenEnvName,
          apiBase,
          stateSource,
          labelPrefix: labelPrefix.toLowerCase(),
          statePriority,
          requireAssignee: asBoolean(provider['require_assignee'], false),
          assignee: asString(provider['assignee']),
          pageSize,
          requestTimeoutMs,
        },
        args.active_states,
        args.terminal_states,
        args,
      ),
    );
  }

  secretEnvironmentNames(): string[] {
    return this.profile.secret_environment_names;
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Result<Issue[], TrackerError>> {
    if (stateNames.length === 0) return ok([]);
    const requested = new Set(stateNames.map(normalizeStateKey));
    const wantsOpen = [...requested].some((state) => state === 'open' || this.activeStates.has(state));
    const wantsClosed = [...requested].some((state) => state === 'closed' || this.terminalStates.has(state));
    const nativeStates: Array<'open' | 'closed'> = [];
    if (wantsOpen) nativeStates.push('open');
    if (wantsClosed && !nativeStates.includes('closed')) nativeStates.push('closed');
    if (nativeStates.length === 0) return ok([]);

    const issues: Issue[] = [];
    for (const repo of this.config.repositories) {
      for (const nativeState of nativeStates) {
        const listed = await this.listRepositoryIssues(repo, nativeState);
        if (!listed.ok) return listed;
        for (const issue of listed.value) {
          if (requested.has(normalizeStateKey(issue.state))) issues.push(issue);
        }
      }
    }
    return ok(issues);
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Result<Issue[], TrackerError>> {
    if (issueIds.length === 0) return ok([]);
    const issues: Issue[] = [];
    for (const id of issueIds) {
      const parsed = parseDispatchId(id);
      if (parsed === null) {
        // Omission is meaningful for ID refresh, so an unparseable requested ID
        // is a failure rather than an invisible record (SPEC 11.1).
        return err(trackerError('tracker_response', `malformed dispatch id: ${JSON.stringify(id)}`));
      }
      const repo = this.config.repositories.find((candidate) => candidate.full.toLowerCase() === parsed.repo.toLowerCase());
      if (repo === undefined) continue; // No longer visible in the configured scope.
      const response = await this.request(`/repos/${repo.owner}/${repo.name}/issues/${parsed.number}`, { method: 'GET' });
      if (!response.ok) {
        if (response.status === 404) continue;
        return response;
      }
      const payload = response.body as GitHubIssuePayload | null;
      if (payload === null || typeof payload !== 'object') {
        return err(trackerError('tracker_response', `unexpected payload for ${id}`));
      }
      const normalized = this.normalizeIssue(repo, payload);
      if (!normalized.ok) {
        return err(trackerError('tracker_response', `malformed issue ${id}: ${normalized.reason}`));
      }
      issues.push(normalized.issue);
    }
    return ok(issues);
  }

  /* ------------------------------------------------------------ internals */

  private async listRepositoryIssues(repo: RepoScope, state: 'open' | 'closed'): Promise<Result<Issue[], TrackerError>> {
    const issues: Issue[] = [];
    const seenPages = new Set<string>();
    let path: string | null =
      `/repos/${repo.owner}/${repo.name}/issues?state=${state}&per_page=${this.config.pageSize}&sort=created&direction=asc`;
    while (path !== null) {
      if (seenPages.has(path)) {
        return err(trackerError('tracker_pagination', `pagination loop detected for ${repo.full}`));
      }
      seenPages.add(path);
      const response = await this.request(path, { method: 'GET' });
      if (!response.ok) return response;
      if (!Array.isArray(response.body)) {
        return err(trackerError('tracker_response', `expected a list of issues for ${repo.full}`));
      }
      for (const entry of response.body as GitHubIssuePayload[]) {
        if (entry === null || typeof entry !== 'object') continue;
        if (entry.pull_request !== undefined) continue;
        const normalized = this.normalizeIssue(repo, entry);
        if (!normalized.ok) {
          // A malformed record was never safe to dispatch; log and skip it.
          this.onWarning('skipping malformed tracker record', {
            repository: repo.full,
            reason: normalized.reason,
          });
          continue;
        }
        issues.push(normalized.issue);
      }
      path = nextPagePath(response.headers, this.config.apiBase);
    }
    return ok(issues);
  }

  private normalizeIssue(
    repo: RepoScope,
    payload: GitHubIssuePayload,
  ): { ok: true; issue: Issue } | { ok: false; reason: string } {
    const number = typeof payload.number === 'number' ? payload.number : Number(payload.number);
    if (!Number.isInteger(number) || number <= 0) return { ok: false, reason: 'missing required field: number' };
    const labels = normalizeLabels(labelNames(payload.labels));
    const nativeState = typeof payload.state === 'string' ? payload.state : null;
    let state: string;
    if (this.config.stateSource === 'labels') {
      state = deriveLabelState(labels, this.config.labelPrefix, this.config.statePriority) ?? nativeState ?? '';
    } else {
      state = nativeState ?? '';
    }
    const assigneeLogin = pickAssignee(payload);
    const dispatchable =
      nativeState === 'open' &&
      (this.config.requireAssignee ? this.config.assignee !== null && assigneeLogin === this.config.assignee : true);

    return buildIssue(
      {
        id: `${repo.full}#${number}`,
        identifier: `${repo.full}#${number}`,
        title: payload.title,
        state,
        dispatchable,
      },
      {
        native_ref: { repository: repo.full, number, node_id: typeof payload.node_id === 'string' ? payload.node_id : null },
        description: typeof payload.body === 'string' ? payload.body : null,
        priority: priorityFromLabels(labels),
        branch_name: null,
        url: typeof payload.html_url === 'string' ? payload.html_url : null,
        assignee_id: assigneeLogin,
        labels,
        blocked_by: [],
        created_at: payload.created_at,
        updated_at: payload.updated_at,
      },
    );
  }

  private async request(
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<RequestResult> {
    const url = path.startsWith('http') ? path : `${this.config.apiBase}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: init.method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.config.token}`,
          'user-agent': 'symphony-deepseek',
          'x-github-api-version': '2022-11-28',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      return requestFailure(
        trackerError('tracker_request', `GitHub request failed: ${describeError(error)}`, {
          retryable: true,
        }),
      );
    }

    const headers = response.headers;
    if (!response.ok) {
      const rateLimited =
        headers.get('x-ratelimit-remaining') === '0' || response.status === 429;
      if (rateLimited) {
        const retryAfter = Number(headers.get('retry-after') ?? Number.NaN);
        const reset = Number(headers.get('x-ratelimit-reset') ?? Number.NaN);
        const retryAfterMs = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : Number.isFinite(reset)
            ? Math.max(0, reset * 1000 - Date.now())
            : undefined;
        return requestFailure(
          trackerError('tracker_rate_limited', 'GitHub rate limit exceeded', {
            retryable: true,
            ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
            status: response.status,
          }),
          response.status,
        );
      }
      let detail = '';
      try {
        const text = await response.text();
        detail = text.length > 500 ? `${text.slice(0, 500)}…` : text;
      } catch {
        detail = '';
      }
      return requestFailure(
        trackerError('tracker_status', `GitHub returned ${response.status} ${response.statusText}${detail === '' ? '' : `: ${detail}`}`, {
          status: response.status,
          retryable: response.status >= 500,
        }),
        response.status,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return requestFailure(trackerError('tracker_response', `GitHub returned invalid JSON: ${describeError(error)}`), response.status);
    }
    return { ok: true, status: response.status, headers, body };
  }

  /* ---------------------------------------------------- provider tools */

  agentToolSpecs(): ToolSpec[] {
    return GITHUB_TOOLS.map((tool) => tool.spec);
  }

  async executeAgentTool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const tool = GITHUB_TOOLS.find((candidate) => candidate.spec.name === name);
    if (tool === undefined) {
      return { ok: false, error: { category: 'unsupported_tool', message: `unknown GitHub tool: ${name}` } };
    }
    const target = resolveToolTarget(context.issue, this.config.repositories);
    if (target === null) {
      return {
        ok: false,
        error: { category: 'invalid_context', message: 'the current issue has no usable GitHub native_ref' },
      };
    }
    try {
      return await tool.execute(this, target, args);
    } catch (error) {
      return { ok: false, error: { category: 'tracker_request', message: describeError(error) } };
    }
  }

  /** Tool-facing request helper: throws on failure so the tool can report it. */
  async toolRequest(
    target: { repo: RepoScope; number: number },
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<unknown> {
    const response = await this.request(path, init);
    if (!response.ok) {
      throw new Error(`${response.error.category}: ${response.error.message}`);
    }
    return response.body;
  }

  /** Exposed for tool implementations that need the repository scope. */
  repositoryFullName(target: { repo: RepoScope; number: number }): string {
    return target.repo.full;
  }
}

interface ToolTarget {
  repo: RepoScope;
  number: number;
}

interface GitHubTool {
  spec: ToolSpec;
  execute: (adapter: GitHubTrackerAdapter, target: ToolTarget, args: Record<string, unknown>) => Promise<ToolResult>;
}

function parseDispatchId(id: string): { repo: string; number: number } | null {
  const match = /^([^#]+)#(\d+)$/.exec(id.trim());
  if (match === null) return null;
  const number = Number(match[2]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { repo: match[1] as string, number };
}

function resolveToolTarget(issue: Issue, repositories: RepoScope[]): ToolTarget | null {
  const ref = issue.native_ref;
  if (ref === null) return null;
  const repository = typeof ref['repository'] === 'string' ? ref['repository'] : null;
  const number = typeof ref['number'] === 'number' ? ref['number'] : Number(ref['number']);
  if (repository === null || !Number.isInteger(number)) return null;
  const repo = repositories.find((candidate) => candidate.full.toLowerCase() === repository.toLowerCase());
  if (repo === undefined) return null;
  return { repo, number };
}

function pickAssignee(payload: GitHubIssuePayload): string | null {
  const assignee = payload.assignee;
  if (typeof assignee === 'object' && assignee !== null) {
    const login = (assignee as Record<string, unknown>)['login'];
    if (typeof login === 'string' && login !== '') return login;
  }
  const assignees = payload.assignees;
  if (Array.isArray(assignees)) {
    for (const entry of assignees) {
      if (typeof entry === 'object' && entry !== null) {
        const login = (entry as Record<string, unknown>)['login'];
        if (typeof login === 'string' && login !== '') return login;
      }
    }
  }
  return null;
}

/**
 * State derived from `status:*` labels.
 *
 * GitHub returns an issue's labels in the order they were added, so an issue
 * that gains `status:review` while it still carries `status:todo` would keep
 * resolving to `todo` with a naive first-match rule. `statePriority` makes the
 * resolution explicit and deterministic: the first state listed there that is
 * present wins. Without a priority list the first matching label is used.
 */
export function deriveLabelState(labels: string[], prefix: string, statePriority: string[] = []): string | null {
  const candidates: string[] = [];
  for (const label of labels) {
    if (label.length > prefix.length && label.startsWith(prefix)) {
      candidates.push(label.slice(prefix.length));
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] as string;
  for (const preferred of statePriority) {
    if (candidates.includes(preferred)) return preferred;
  }
  return candidates[0] as string;
}

function nextPagePath(headers: Headers, apiBase: string): string | null {
  const link = headers.get('link');
  if (link === null) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (match !== null && match[2] === 'next') {
      const url = match[1] as string;
      return url.startsWith(apiBase) ? url.slice(apiBase.length) || '/' : url;
    }
  }
  return null;
}

const stringSchema = (description: string): Record<string, unknown> => ({ type: 'string', description });

const GITHUB_TOOLS: GitHubTool[] = [
  {
    spec: {
      name: 'issue_comment',
      description: 'Post a comment on the current GitHub issue.',
      mutates: true,
      input_schema: {
        type: 'object',
        properties: { body: stringSchema('Markdown comment body') },
        required: ['body'],
        additionalProperties: false,
      },
    },
    execute: async (adapter, target, args) => {
      const body = args['body'];
      if (typeof body !== 'string' || body.trim() === '') {
        return { ok: false, error: { category: 'invalid_arguments', message: 'body must be a non-empty string' } };
      }
      const result = await adapter.toolRequest(
        target,
        `/repos/${target.repo.owner}/${target.repo.name}/issues/${target.number}/comments`,
        { method: 'POST', body: { body } },
      );
      const url = (result as Record<string, unknown> | null)?.['html_url'];
      return { ok: true, output: { commented: true, comment_url: typeof url === 'string' ? url : null } };
    },
  },
  {
    spec: {
      name: 'issue_add_labels',
      description: 'Add one or more labels to the current GitHub issue.',
      mutates: true,
      input_schema: {
        type: 'object',
        properties: {
          labels: { type: 'array', items: { type: 'string' }, description: 'Label names to add' },
        },
        required: ['labels'],
        additionalProperties: false,
      },
    },
    execute: async (adapter, target, args) => {
      const labels = args['labels'];
      if (!Array.isArray(labels) || labels.length === 0 || !labels.every((label) => typeof label === 'string')) {
        return { ok: false, error: { category: 'invalid_arguments', message: 'labels must be a non-empty array of strings' } };
      }
      const result = await adapter.toolRequest(
        target,
        `/repos/${target.repo.owner}/${target.repo.name}/issues/${target.number}/labels`,
        { method: 'POST', body: { labels } },
      );
      return { ok: true, output: { added: labels, labels: labelNames(result) } };
    },
  },
  {
    spec: {
      name: 'issue_remove_label',
      description: 'Remove a label from the current GitHub issue.',
      mutates: true,
      input_schema: {
        type: 'object',
        properties: { label: stringSchema('Label name to remove') },
        required: ['label'],
        additionalProperties: false,
      },
    },
    execute: async (adapter, target, args) => {
      const label = args['label'];
      if (typeof label !== 'string' || label.trim() === '') {
        return { ok: false, error: { category: 'invalid_arguments', message: 'label must be a non-empty string' } };
      }
      const result = await adapter.toolRequest(
        target,
        `/repos/${target.repo.owner}/${target.repo.name}/issues/${target.number}/labels/${encodeURIComponent(label)}`,
        { method: 'DELETE' },
      );
      return { ok: true, output: { removed: label, labels: labelNames(result) } };
    },
  },
  {
    spec: {
      name: 'issue_set_state',
      description: 'Set the GitHub issue state to open or closed.',
      mutates: true,
      input_schema: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['open', 'closed'], description: 'Target issue state' },
        },
        required: ['state'],
        additionalProperties: false,
      },
    },
    execute: async (adapter, target, args) => {
      const state = args['state'];
      if (state !== 'open' && state !== 'closed') {
        return { ok: false, error: { category: 'invalid_arguments', message: 'state must be "open" or "closed"' } };
      }
      const result = await adapter.toolRequest(
        target,
        `/repos/${target.repo.owner}/${target.repo.name}/issues/${target.number}`,
        { method: 'PATCH', body: { state } },
      );
      const current = (result as Record<string, unknown> | null)?.['state'];
      return { ok: true, output: { state: typeof current === 'string' ? current : state } };
    },
  },
  {
    spec: {
      name: 'issue_update',
      description: 'Update the current GitHub issue title and/or body.',
      mutates: true,
      input_schema: {
        type: 'object',
        properties: { title: stringSchema('New title'), body: stringSchema('New markdown body') },
        required: [],
        additionalProperties: false,
      },
    },
    execute: async (adapter, target, args) => {
      const patch: Record<string, unknown> = {};
      if (typeof args['title'] === 'string') patch['title'] = args['title'];
      if (typeof args['body'] === 'string') patch['body'] = args['body'];
      if (Object.keys(patch).length === 0) {
        return { ok: false, error: { category: 'invalid_arguments', message: 'provide title and/or body' } };
      }
      await adapter.toolRequest(target, `/repos/${target.repo.owner}/${target.repo.name}/issues/${target.number}`, {
        method: 'PATCH',
        body: patch,
      });
      return { ok: true, output: { updated: Object.keys(patch) } };
    },
  },
  {
    spec: {
      name: 'issue_get',
      description: 'Read the current GitHub issue (title, body, state, labels).',
      mutates: false,
      input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    execute: async (adapter, target) => {
      const result = await adapter.toolRequest(
        target,
        `/repos/${target.repo.owner}/${target.repo.name}/issues/${target.number}`,
        { method: 'GET' },
      );
      const record = (result ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        output: {
          number: target.number,
          repository: adapter.repositoryFullName(target),
          title: typeof record['title'] === 'string' ? record['title'] : null,
          body: typeof record['body'] === 'string' ? record['body'] : null,
          state: typeof record['state'] === 'string' ? record['state'] : null,
          labels: labelNames(record['labels']),
          url: typeof record['html_url'] === 'string' ? record['html_url'] : null,
        },
      };
    },
  },
];

/** Create a GitHub adapter from tracker config. */
export function createGitHubAdapter(args: GitHubAdapterOptions): Result<TrackerAdapter, TrackerError> {
  const created = GitHubTrackerAdapter.create(args);
  return created.ok ? ok(created.value) : created;
}
