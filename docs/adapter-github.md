# GitHub adapter profile

`tracker.kind: github`

GitHub Issues over the REST API. This profile documents every key, default, normalization rule and
error mapping the adapter implements, as required by SPEC.md section 11.2.

## Configuration

```yaml
tracker:
  kind: github
  provider:
    repository: octocat/hello-world      # required (or `repositories`)
    repositories: []                     # optional additional scopes
    token: $GITHUB_TOKEN                 # optional; defaults to $GITHUB_TOKEN
    token_env: GITHUB_TOKEN              # optional: name of the env var holding the token
    api_base: https://api.github.com     # optional: GitHub Enterprise base URL
    state_source: labels                 # optional: labels | issue_state
    label_prefix: "status:"              # optional: label prefix for state_source=labels
    state_priority: [done, review, todo] # optional: which label wins when several are set
    assignee: octocat                    # optional: required assignee login
    require_assignee: false              # optional: only dispatch assigned issues
    page_size: 100                       # optional: 1..100
    request_timeout_ms: 30000            # optional
  required_labels: []
  active_states: [todo, in-progress]
  terminal_states: [done, cancelled]
```

| Key | Required | Default | Notes |
|---|---|---|---|
| `repository` | yes (unless `repositories`) | — | `owner/name`; a trailing `.git` is stripped |
| `repositories` | no | `[]` | Additional `owner/name` scopes; duplicate selectors are ignored case-insensitively |
| `token` | no | `$GITHUB_TOKEN` | Literal value or a single `$VAR` reference |
| `token_env` | no | `GITHUB_TOKEN` | Environment fallback when `token` is omitted |
| `api_base` | no | `https://api.github.com` | Must parse as an absolute URL |
| `state_source` | no | `issue_state` | `labels` when `label_prefix` is set |
| `label_prefix` | no | `status:` | Prefix stripped to derive the state (`status:todo` → `todo`) |
| `state_priority` | no | `[]` | Order used when several status labels are present |
| `assignee` | no | `null` | Login that must be assigned when `require_assignee` is true |
| `require_assignee` | no | `false` | Unassigned issues are normalized with `dispatchable: false` |
| `page_size` | no | `100` | 1..100 per request |
| `request_timeout_ms` | no | `30000` | Per-request timeout |

### Several repositories

`repository` and `repositories` are both selectors for the same scope. They may be combined; the result
is the union, in configuration order. Selecting more than one repository is supported without another
workflow or process:

```yaml
tracker:
  kind: github
  provider:
    repositories:
      - octocat/hello-world
      - octocat/spoon-knife
    token: $GITHUB_TOKEN
```

Rules:

- Every selector must be an `owner/name` string; a trailing `.git` is stripped.
- A non-list `repositories` value or a non-string entry is `invalid_tracker_config`, as is an invalid
  selector. At least one selector is required.
- Duplicate selectors are ignored case-insensitively, because GitHub repository names are
  case-insensitive. The first configured spelling is preserved in identifiers and `native_ref`.
- All repositories share the same `active_states`, `terminal_states`, `required_labels`, state-source
  and pagination settings. There is no per-repository override.
- `fetch_issues_by_states` performs the state queries for each repository; a failure in any repository
  fails the call. `fetch_issues_by_ids` refreshes only ids whose repository is in the configured scope.
- Issue ids and identifiers are `owner/repo#number`, so equal issue numbers in different repositories
  never collide. Workspaces use the sanitized, hash-suffixed identifier, so they stay distinct too.
- Provider-native tools derive their target repository from `native_ref`; an issue in one repository
  cannot retarget a tool call at another repository in the same scope.

A multi-repository workflow needs a per-issue checkout. Workspace hooks receive
`SYMPHONY_ISSUE_NATIVE_REF` (JSON containing `repository`, `number` and `node_id`) and the other
`SYMPHONY_ISSUE_*` variables documented in the README, so one `after_create` hook can clone the right
repository:

```yaml
hooks:
  after_create: |
    git clone --depth 1 "https://github.com/$(node -p 'JSON.parse(process.env.SYMPHONY_ISSUE_NATIVE_REF).repository').git" .
```

The `$(...)` substitution works in both POSIX shells and PowerShell.

### Secrets

Secret names for child-process scrubbing: the configured `token_env`, plus `GITHUB_TOKEN` and
`GH_TOKEN`. A `$VAR` that resolves to an empty string is treated as missing
(`missing_tracker_secret`).

The recommended setup is a `.env` file next to `WORKFLOW.md`:

```bash
# .env — git-ignored
GITHUB_TOKEN=github_pat_...
```

Symphony loads `<WORKFLOW.md dir>/.env`, then `<cwd>/.env` (override with `--env-file`, disable with
`--no-env-file`). The launch environment wins; `.env` only fills names it does not define. Use
`token: $GITHUB_TOKEN` rather than a literal token: the workflow file lives in the repository.
Rotating the token in `.env` and triggering a reload rebuilds the adapter — no restart needed.

### State defaults

- `state_source: issue_state` → `active_states: [open]`, `terminal_states: [closed]`.
- `state_source: labels` → **no defaults**; configure both state lists explicitly, because a label
  vocabulary is repository-specific.

## Resolving several status labels

The derived state is the label suffix after `label_prefix` (`status:in-progress` → `in-progress`).
GitHub returns an issue's labels **in the order they were added**, so an issue that gains
`status:review` while still carrying `status:todo` would keep resolving to `todo`, and the worker would
keep running turns on an issue that is already handed off.

`state_priority` fixes that: the first state in the list that is actually present wins. Rank terminal
states first, then handoff states, then work states:

```yaml
state_priority: [done, cancelled, review, blocked, in-progress, todo]
```

Without `state_priority`, the first matching label wins — the right choice only when the workflow
guarantees exactly one `status:*` label at any moment.

## Scope selection and pagination

- Scope is the configured repository set; every list request is scoped to one repository.
- `fetch_issues_by_states` issues at most one query per repository per native state (`open`, `closed`)
  needed by the requested state names, with `per_page` and `sort=created&direction=asc`.
- Pagination follows the `Link: <...>; rel="next"` header, preserving provider order; a repeated page URL
  is a `tracker_pagination` failure.
- Pull requests returned by the issues endpoint are skipped.
- An empty state or id list returns an empty result without a provider request.
- `fetch_issues_by_ids` parses `<owner>/<repo>#<number>` and performs one GET per id; ids outside the
  configured scope are omitted, `404` means "no longer visible" and is omitted.

## Normalization

| Field | Mapping |
|---|---|
| `id` | `<owner>/<repo>#<number>` (stable dispatch identity) |
| `identifier` | Same string; unique within scope and used for the workspace name |
| `native_ref` | `{repository, number, node_id}` (non-secret) |
| `title` | Issue title (required, must be non-empty) |
| `description` | Issue body or `null` |
| `state` | Derived per `state_source` (label suffix or `open`/`closed`) |
| `priority` | `p1`..`p4`, `priority:1`, `prio-2`, … → 1..4; otherwise `null` |
| `branch_name` | Always `null` (GitHub issues carry no branch metadata) |
| `url` | `html_url` |
| `assignee_id` | Assignee login, else first of `assignees`, else `null` |
| `labels` | Trimmed, lowercased, de-duplicated, blanks dropped |
| `blocked_by` | Always `[]` — this adapter does not invent blocker semantics |
| `dispatchable` | `true` only for an `open` issue that satisfies `require_assignee` |
| `created_at` / `updated_at` | RFC 3339 → ISO 8601, or `null` |

Malformed records:

- **State list**: a record missing `number`, `title`, `state` (or otherwise unusable) is logged and
  skipped — it was never safe to dispatch.
- **ID refresh**: a malformed requested record fails the whole call (`tracker_response`), because
  omission is meaningful there.

## Error mapping

| Public error | Category | Retryable |
|---|---|---|
| Unsupported `tracker.kind` | `unsupported_tracker_kind` | no |
| Bad or missing provider keys | `invalid_tracker_config` | no |
| Token unset/empty | `missing_tracker_secret` | no |
| Fetch threw (DNS, TLS, timeout) | `tracker_request` | yes |
| Non-2xx response | `tracker_status` | `5xx` yes, otherwise no |
| Invalid JSON or unexpected shape | `tracker_response` | no |
| Pagination loop | `tracker_pagination` | no |
| `403` with `x-ratelimit-remaining: 0`, or `429` | `tracker_rate_limited` | yes, with `retry_after_ms` from `Retry-After` or `x-ratelimit-reset` |

`GitHubTrackerAdapter.create` never performs network I/O, so configuration validation happens at
startup and before dispatch without spending rate limit.

## Provider-native agent tools

Executed host-side by Symphony with the configured token (never by the agent process):

| Tool | Mutates | Arguments | Result |
|---|---|---|---|
| `issue_comment` | yes | `body` | `{commented, comment_url}` |
| `issue_add_labels` | yes | `labels: string[]` | `{added, labels}` |
| `issue_remove_label` | yes | `label` | `{removed, labels}` |
| `issue_set_state` | yes | `state: "open" \| "closed"` | `{state}` |
| `issue_update` | yes | `title?`, `body?` | `{updated}` |
| `issue_get` | no | — | `{number, repository, title, body, state, labels, url}` |

The current normalized issue is the execution context; the repository and number come from
`native_ref`, so a workflow cannot target another repository through a tool call. Invalid arguments and
transport failures return `{"ok":false,"error":{"category","message"}}` and never stall the session.

Note the ordering constraint of label-based states: to hand off an issue, add the target
`status:<state>` label *before* removing the previous one (the first matching label wins), or set
`state_source: issue_state` and close the issue.

## Publishing: branch push and pull requests

Two workflow tools are advertised *in addition to* the issue tools whenever the adapter can perform
them. Both run host-side; the agent only ever sees the result.

| Tool | Arguments | Result |
|---|---|---|
| `workspace_push` | `branch?` (defaults to the checked-out branch) | `{branch, remote, pushed: true}` |
| `pull_request_open` | `title`, `body`, `base?` (defaults to `provider.base_branch`) | `{number, url, state, existing}` |

- `provider.base_branch` (default `main`) is the PR target.
- The push uses the configured token in a one-off remote URL, so nothing is written to `.git/config`,
  and every message the tool returns is redacted before leaving the process.
- Pushes are `--force-with-lease`: the issue workspace is authoritative for its own branch, which makes
  a re-run after a workspace reset work, while a human's commits on that branch still block the push.
- `pull_request_open` is idempotent: GitHub answers `422` when a PR already exists for that head/base,
  and the adapter then returns the existing open PR (`existing: true`).

The token therefore needs `Contents: Read and write` (push) and `Pull requests: Read and write` (PR), in
addition to `Issues: Read and write` for the issue tools.
