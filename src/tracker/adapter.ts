/**
 * The tracker boundary (SPEC section 11): a small read kernel plus optional
 * provider-native agent tools. The orchestrator only sees `Issue` values and
 * success/failure, never provider payloads.
 */
import type { Issue } from '../domain/types.js';
import type { Result, TrackerError } from '../domain/errors.js';

/** One provider-native tool advertised to coding-agent sessions. */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Whether the tool can mutate tracker state. */
  mutates: boolean;
}

/** Structured tool outcome: never a raw provider payload, never a credential. */
export type ToolResult =
  | { ok: true; output: unknown }
  | { ok: false; error: { category: string; message: string } };

/** Execution context handed to a provider-native tool. */
export interface ToolContext {
  issue: Issue;
  /** Absolute path of the issue workspace, for tools that touch the checkout. */
  workspacePath?: string;
  /** Optional per-invocation cancellation signal. */
  signal?: AbortSignal;
}

/** Input for opening a pull request from the issue branch. */
export interface PullRequestInput {
  head: string;
  base: string;
  title: string;
  body: string;
}

/**
 * Compact, machine-readable adapter profile. The prose version of each adapter
 * profile lives in `docs/`.
 */
export interface AdapterProfile {
  kind: string;
  display_name: string;
  /** Required provider keys; each entry is a human-readable description. */
  required_provider_keys: string[];
  /** Optional provider keys with their defaults. */
  optional_provider_keys: Record<string, string>;
  /** Environment variable names that carry credentials and must not reach agents. */
  secret_environment_names: string[];
  /** Documented defaults for omitted state lists, if any. */
  default_states?: { active_states?: string[]; terminal_states?: string[] };
  /** Provider-native tool names, empty when the adapter ships none. */
  tool_names: string[];
}

/** The operations the orchestrator depends on, plus optional provider tools. */
export interface TrackerAdapter {
  readonly kind: string;
  readonly profile: AdapterProfile;
  /** Issues visible in the configured scope for the requested states. */
  fetchIssuesByStates(stateNames: string[]): Promise<Result<Issue[], TrackerError>>;
  /** Current snapshots for the supplied opaque dispatch IDs. */
  fetchIssuesByIds(issueIds: string[]): Promise<Result<Issue[], TrackerError>>;
  agentToolSpecs?(): ToolSpec[];
  secretEnvironmentNames?(): string[];
  executeAgentTool?(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  /**
   * OPTIONAL workflow capabilities for adapters whose provider has branches and
   * pull requests. The tool bridge advertises `workspace_push` /
   * `pull_request_open` only when these are implemented, and always executes
   * them host-side so the agent never receives the git credential.
   */
  pushBranch?(context: ToolContext, branch: string): Promise<ToolResult>;
  openPullRequest?(context: ToolContext, input: PullRequestInput): Promise<ToolResult>;
  /** Base branch for pull requests, when the adapter opens them (`main`). */
  defaultBaseBranch?(): string;
  dispose?(): Promise<void> | void;
}

export interface TrackerFactoryArgs {
  provider: Record<string, unknown>;
  active_states: string[];
  terminal_states: string[];
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}
