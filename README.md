# Symphony (DeepSeek Harness + GitHub)

A TypeScript/Node.js implementation of the **OpenAI Symphony** service specification: a long-running
daemon that polls an issue tracker, creates one isolated workspace per issue, renders a prompt from a
repository-owned `WORKFLOW.md`, and drives a coding agent to completion inside that workspace.

This build ships two agent backends and two tracker adapters:

| Area | Supported | Notes |
|---|---|---|
| Tracker | **GitHub Issues** (`kind: github`) | REST API, pagination, label-based or native states |
| Tracker | **In-memory list** (`kind: memory`) | deterministic tests, local demos, no credentials |
| Agent | **DeepSeek Harness CLI** (`harness.kind: dsh`) | `dsh --profile headless --json`, session-continuation turns |
| Agent | **Codex app-server** (`harness.kind: codex`) | JSON-RPC over stdio, the spec's default launch contract |

Runs on Windows, macOS and Linux. Node.js >= 22.

---

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [WORKFLOW.md reference](#workflowmd-reference)
- [Credentials via .env](#credentials-via-env)
- [GitHub setup](#github-setup)
- [DeepSeek Harness setup](#deepseek-harness-setup)
- [CLI](#cli)
- [HTTP status API](#http-status-api)
- [Agent tool bridge](#agent-tool-bridge)
- [Conformance notes](#conformance-notes)
- [Security and trust posture](#security-and-trust-posture)
- [Development](#development)

---

## Quick start

```bash
npm install
npm run build

# 1. See it work with no credentials: a local issue list and a fake agent.
npm run demo
#    dashboard: http://127.0.0.1:<ephemeral port>   (printed in the log line "http server listening")

# 2. Point it at a real repository.
cp examples/github/WORKFLOW.md ./WORKFLOW.md
cp .env.example .env                    # then put your token in .env (git-ignored)
node dist/src/bin.js ./WORKFLOW.md --port 4173
```

`.env` next to `WORKFLOW.md` is read automatically, so `GITHUB_TOKEN` never has to be exported into
your shell. See [Credentials via .env](#credentials-via-env).

Then open `http://127.0.0.1:4173/` for the dashboard, or:

```bash
curl -s http://127.0.0.1:4173/api/v1/state | jq
curl -s -X POST http://127.0.0.1:4173/api/v1/refresh
```

The service exits non-zero when startup validation fails (missing workflow, unsupported tracker kind,
unreadable config) and zero on a normal signal shutdown.

---

## How it works

```
                        ┌──────────────────────────────────────────┐
  WORKFLOW.md  ────────►│ Workflow loader + typed config + template│
  (watched, reloaded)   └───────────────┬──────────────────────────┘
                                        │ effective snapshot
  GitHub / memory  ────────────────────►│
  (read kernel)                         ▼
                        ┌──────────────────────────────────────────┐
                        │ Orchestrator (single authority)          │
                        │  poll → reconcile → validate → dispatch  │
                        │  claims · retries · backoff · stalls     │
                        └───────┬───────────────────────┬──────────┘
                                │ worker attempt        │ snapshot
                                ▼                       ▼
                 ┌──────────────────────────┐   ┌───────────────────┐
                 │ Workspace manager        │   │ HTTP dashboard    │
                 │  per-issue dir + hooks   │   │ /api/v1/*         │
                 └──────────┬───────────────┘   └───────────────────┘
                            ▼
                 ┌──────────────────────────┐        ┌────────────────────┐
                 │ Agent runner             │───────►│ Tool bridge        │
                 │  dsh / codex backend     │ tools  │ host-side tracker  │
                 └──────────────────────────┘        │ tools (no secrets) │
                                                     └────────────────────┘
```

Key behaviors (all covered by the test suite):

- **One workspace per issue**, deterministic and reused across runs: `<workspace.root>/<workspace_key>`.
  Identifiers that need sanitizing get a 64-bit hash suffix so `a/b` and `a b` never collide.
  `hooks.after_create` therefore runs only once per workspace: after an out-of-band push to the
  repository, delete that workspace so the next attempt clones the new code
  (`Remove-Item -Recurse -Force <workspace.root>\<workspace_key>`, the key appears as `workspace=` in the
  hook log line).
- **Claims**: an issue is dispatched only when it is not running, not claimed, active, not terminal,
  adapter-dispatchable, label-matched, and a global + per-state slot is free.
- **Reconciliation every tick**: stall detection from the last agent event, then a tracker refresh that
  stops runs on terminal states (and cleans the workspace) or on non-active states (and preserves it).
- **Retries**: clean worker exit → continuation retry after 1s; failure → `min(10s · 2^(n-1), cap)`.
  A retry re-reads the issue and only re-dispatches while it is still active and routable.
- **Multi-turn workers**: after each successful turn the worker re-checks the issue and starts another
  turn on the same agent thread, up to `agent.max_turns`, sending only continuation guidance.
- **Dynamic reload**: `WORKFLOW.md` is watched *and* stat-checked before every tick. An invalid reload
  keeps the last known good configuration and emits an operator-visible error.
- **Crash recovery without a database**: in-memory scheduler state is intentionally not persisted;
  restart recovery is tracker-driven (poll) plus filesystem-driven (startup terminal cleanup).

---

## WORKFLOW.md reference

`WORKFLOW.md` is a Markdown file with optional YAML front matter. The body is the strict Liquid-style
prompt template; the front matter is the runtime configuration. Path precedence: explicit CLI argument,
otherwise `./WORKFLOW.md` in the working directory.

```markdown
---
tracker:
  kind: github
  provider:
    repository: octocat/hello-world
    token: $GITHUB_TOKEN
  active_states: [todo, in-progress]
  terminal_states: [done, cancelled]

polling:
  interval_ms: 30000

workspace:
  root: ~/.symphony/workspaces

hooks:
  after_create: |
    git clone https://github.com/octocat/hello-world.git .
  before_run: |
    npm ci
  timeout_ms: 600000

agent:
  max_concurrent_agents: 4
  max_turns: 20
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    in-progress: 2

harness:
  kind: dsh
  profile: headless
  model: deepseek-chat

server:
  port: 4173
---

You are working on `{{ issue.identifier }}`: {{ issue.title }}.

{{ issue.description }}

Labels: {% for label in issue.labels %}`{{ label }}` {% endfor %}
Attempt: {{ attempt | default: "first" }}
```

### Core schema

| Key | Default | Meaning |
|---|---|---|
| `tracker.kind` | — (required) | `github` or `memory` |
| `tracker.provider` | `{}` | Adapter-owned endpoint/scope/auth settings |
| `tracker.required_labels` | `[]` | Every label must be present (case-insensitive) |
| `tracker.active_states` | adapter default | States eligible for dispatch |
| `tracker.terminal_states` | adapter default | States that end a run and clean the workspace |
| `polling.interval_ms` | `30000` | Poll cadence; re-applied live |
| `workspace.root` | `<temp>/symphony_workspaces` | Per-issue workspaces; `~` and `$VAR` expand, relative paths resolve next to `WORKFLOW.md` |
| `hooks.after_create` | `null` | Runs only when the workspace directory is created; failure aborts creation |
| `hooks.before_run` | `null` | Runs before each attempt; failure aborts the attempt |
| `hooks.after_run` | `null` | Runs after each attempt; failures are logged and ignored |
| `hooks.before_remove` | `null` | Runs before workspace deletion; failures are logged and ignored |
| `hooks.timeout_ms` | `60000` | Applies to every hook |
| `agent.max_concurrent_agents` | `10` | Global concurrency |
| `agent.max_turns` | `20` | Coding-agent turns per worker session |
| `agent.max_retry_backoff_ms` | `300000` | Retry backoff cap |
| `agent.max_concurrent_agents_by_state` | `{}` | Per-state limits; invalid entries are ignored |
| `codex.command` | `codex app-server` | Codex launch command (used by the `codex` backend) |
| `codex.approval_policy` | implementation-defined | Pass-through to the agent |
| `codex.thread_sandbox` / `codex.turn_sandbox_policy` | implementation-defined | Pass-through |
| `codex.turn_timeout_ms` | `3600000` | Maximum agent *silence* during a turn |
| `codex.read_timeout_ms` | `5000` | Startup/handshake timeout |
| `codex.stall_timeout_ms` | `300000` | Orchestrator stall detection (`<= 0` disables) |
| `server.port` | `null` | Enables the HTTP extension; `--port` overrides it |

### Extensions used by this implementation

| Key | Default | Meaning |
|---|---|---|
| `harness.kind` | `codex` | `dsh` or `codex` |
| `harness.command` | `dsh` / `codex.command` | Executable prefix (`dsh`, `node dist/dsh.js`, …) |
| `harness.args` | `[]` | Extra arguments inserted before the backend arguments |
| `harness.profile` | `headless` | DSH profile passed as `--profile` |
| `harness.model` | `null` | Codex backend only; DSH chooses its model in the profile |
| `harness.continuation_prompt` | built-in | Guidance sent to turns after the first |
| `hooks.shell` | platform default | Hook shell, e.g. `bash -lc` or `pwsh -NoProfile -Command` |
| `tools.enabled` | `true` | Host-side tracker tools + generated shim |
| `tools.prompt_hint` | `true` | Append the tool usage block to the prompt |
| `server.host` | `127.0.0.1` | HTTP bind address |

`$VAR` values are resolved only where configured, never as a global environment override. A reference to
an unset or empty variable makes that value missing (and fails validation where the value is required).

### Template syntax

Output `{{ issue.title }}`, filters `{{ issue.labels | join: ", " }}`, and tags:
`if / elsif / else / endif`, `unless`, `for x in y` (+`else`, `forloop.*`), `assign`, `break`,
`continue`, `raw`, `comment`, with `{{-` / `-}}` whitespace control.

Strict mode is enforced: an unknown variable or filter fails rendering, and a rendering failure fails
only that run attempt (the orchestrator then decides retry behavior). Available filters: `default`,
`upcase`, `downcase`, `capitalize`, `strip`, `lstrip`, `rstrip`, `append`, `prepend`, `replace`, `split`,
`join`, `first`, `last`, `size`, `map`, `where`, `escape`, `truncate`, `plus`, `minus`, `times`,
`divided_by`, `modulo`, `json`, `inspect`. There is no `date` filter.

### Workspace hooks

Hooks run with the workspace as cwd, through a local shell: `sh -lc` on POSIX, `bash -lc` when bash is on
PATH on Windows, otherwise `powershell -NoProfile -NonInteractive -Command` (a script block, so a
restricted script-file execution policy does not block it). Override with `hooks.shell`.

---

## Credentials via `.env`

Tracker credentials and model keys can live in a `.env` file instead of your shell environment.

```bash
# .env (next to WORKFLOW.md, git-ignored)
GITHUB_TOKEN=github_pat_...
```

```yaml
tracker:
  kind: github
  provider:
    repository: octocat/hello-world
    token: $GITHUB_TOKEN      # resolved after .env is loaded
```

**Search order** (the first file that exists wins):

1. `--env-file <path>` when given (a missing explicit file is a startup error);
2. `<directory of WORKFLOW.md>/.env`;
3. `<process cwd>/.env`.

**Precedence**: the launch environment always wins. `.env` only fills variables the environment does not
define *at all* — an exported empty value shadows the file, matching DSH's convention. To invert that,
unset the variable (`Remove-Item Env:GITHUB_TOKEN`) before starting.

**Reload**: `.env` is re-read on every workflow reload, and a changed credential forces the tracker
adapter (and its tool bridge) to be rebuilt, so rotating a token needs no restart:

```bash
# edit .env, then either wait for the WORKFLOW.md watcher or trigger a reload
curl -X POST http://127.0.0.1:4173/api/v1/refresh   # reloads .env too when it checks the workflow file
```

**Safety**:

- Only the file path and the *names* of the variables it supplied are logged (`"env file loaded"`), never
  values.
- `.env` is in `.gitignore`; keep it that way. `.env.example` documents the required names and is safe to commit.
- The agent subprocess still gets the tracker credential stripped by name, whether it came from `.env` or
  the environment.
- Hooks run in the Symphony process and *do* see these values (see [docs/TRUST.md](docs/TRUST.md)).

Disable the feature with `--no-env-file` (useful in CI where the environment is authoritative).

---

## GitHub setup

Two state sources are supported because GitHub issues only have `open`/`closed` natively.

**A. Native issue state** (default when no `label_prefix` is set):

```yaml
tracker:
  kind: github
  provider:
    repository: octocat/hello-world
    token: $GITHUB_TOKEN
  active_states: [open]
  terminal_states: [closed]
```

**B. Label-derived state** (the kanban-style workflow most teams use):

```yaml
tracker:
  kind: github
  provider:
    repository: octocat/hello-world
    token: $GITHUB_TOKEN
    state_source: labels
    label_prefix: "status:"
    # Which label wins when an issue carries several. GitHub returns labels in
    # the order they were added, so without this a newly added `status:review`
    # would lose to an older `status:todo` and the worker would keep running.
    state_priority: [done, cancelled, review, blocked, in-progress, todo]
  active_states: [todo, in-progress]
  terminal_states: [done, cancelled]
```

An issue with label `status:in-progress` has state `in-progress`. Configure `active_states` and
`terminal_states` explicitly here: this adapter intentionally ships no defaults for label mode.

See [docs/adapter-github.md](docs/adapter-github.md) for the full adapter profile (keys, pagination,
normalization, error mapping, tools).

---

## DeepSeek Harness setup

Symphony drives the DSH one-shot profile, which answers exactly one task per process and prints a
newline-delimited JSON event stream:

```bash
dsh --profile headless --json - <<'PROMPT'
Summarize the repository and fix the failing test.
PROMPT
```

Symphony maps a Symphony "thread" to a persisted DSH session id:

| Turn | Command |
|---|---|
| 1 | `dsh --profile headless --json -` (prompt on stdin) |
| n | `dsh --profile headless --json --session-id <thread> -` |

Because the session id is adopted on continuation turns, the agent keeps its thread history across the
per-turn processes. The specification requires a shared *thread*, not a shared OS process, and it
already allows the runner to stop the agent process when a worker ends.

Credentials come from the launch environment, `<workspace>/.env`, or `$DSH_HOME/.env` (DSH's own
resolution order). Make sure the model is available to the `dsh` CLI you launch, or set `harness.model`.

Map of DSH events to Symphony events:

| DSH `--json` event | Symphony event | Used for |
|---|---|---|
| `session` | `session_started` | `thread_id`, `session_id` |
| `status.turn_start` | `turn_started` | `turn_id`, turn counting |
| `status.step_end` (`usage`) | `notification` + usage | token totals |
| `status.turn_end` | `turn_completed` / `turn_failed` / `turn_cancelled` | turn outcome |
| `text`, `thinking` | `notification` | observability |
| `tool_call`, `tool_result` | `notification` | observability |
| `final` | – | final text |
| `error` | `turn_ended_with_error` | failure message |

---

## CLI

```
symphony [path-to-WORKFLOW.md] [options]

--port <n>            enable the HTTP status API (0 = ephemeral)
--host <addr>         bind address (default 127.0.0.1)
--log-format <fmt>    json | pretty (default: pretty on a TTY)
--log-level <level>   debug | info | warn | error
--log-file <path>     also append structured logs to a file
--env-file <path>     read secrets from this file (default: .env next to WORKFLOW.md, then cwd)
--no-env-file         ignore .env files entirely
--no-watch            do not watch WORKFLOW.md
--once                run a single poll tick and exit (prints the snapshot JSON)
-h, --help / -V, --version
```

Exit codes: `0` normal shutdown, `1` startup failure or abnormal host exit, `2` usage error.

---

## HTTP status API

Enabled by `--port` or `server.port`. It is observability/control only; the orchestrator never depends
on it.

| Route | Behavior |
|---|---|
| `GET /` | Server-rendered dashboard, auto-refreshing every 5s |
| `GET /api/v1/state` | Runtime snapshot: running rows, retry rows, token/runtime totals, rate limits |
| `GET /api/v1/<identifier>` | Per-issue debug detail, `404` + `{"error":{"code":"issue_not_found"}}` when unknown |
| `POST /api/v1/refresh` | Queues a poll + reconcile cycle, `202` with `{queued, coalesced}` |

Wrong methods return `405` with an `Allow` header; unknown routes return a JSON error envelope.

---

## Agent tool bridge

Symphony never hands a tracker credential to the coding agent. Instead it executes provider-native
tracker tools host-side and exposes them through a loopback endpoint guarded by a per-run token. Each
workspace gets a generated shim, advertised in the prompt:

```bash
node "<workspace.root>/.symphony/agent-tools.mjs" issue_comment '{"body":"Fixed in abc123"}'
node "<workspace.root>/.symphony/agent-tools.mjs" issue_add_labels '{"labels":["status:review"]}'
```

GitHub tools: `issue_comment`, `issue_add_labels`, `issue_remove_label`, `issue_set_state`,
`issue_update`, `issue_get`. Tokens are scoped to one running attempt and revoked when the attempt ends.
Disable with `tools.enabled: false`; disable only the prompt hint with `tools.prompt_hint: false`.

---

## Conformance notes

The implementation follows SPEC.md. Points where the spec leaves a choice, and what this build picked:

| Area | Choice |
|---|---|
| Empty front matter | Treated as an empty config map (a non-map value is still a typed error) |
| Workspace occupied by a file | The file is replaced by the workspace directory |
| Approval policy | Auto-approved for the session unless `codex.approval_policy: never` |
| User-input requests | The turn fails immediately (`turn_input_required`); a run never stalls on input |
| Unsupported tool calls | Structured failure response; the session continues |
| Continuation prompt | Fixed guidance plus an optional `harness.continuation_prompt` template |
| Prompt fallback | Empty body → minimal default prompt |
| Logs | JSON lines to stdout, optional additional JSON file sink; `issue_id`, `issue_identifier` and `session_id` are always present where they apply |
| Snapshot errors | `503 unavailable` before the first tick; a slow snapshot is not possible because it is synchronous |
| Retry attempt numbers | 1-based; `attempt` is `null` for the first run and an integer for retries/continuations |
| DSH process lifetime | One process per turn, same persisted session; the spec only requires the same thread |

The Codex backend targets the published app-server protocol (`initialize`, `thread/start`, `turn/start`
over newline-delimited JSON-RPC) and tolerates several payload shapes for thread ids, turn ids and token
usage. It is exercised against a fake app-server in the test suite, not against a real Codex install.

---

## Security and trust posture

This implementation targets **trusted, single-tenant environments**. Details, including what is and is
not enforced, are in [docs/TRUST.md](docs/TRUST.md). Short version:

- Workspace paths are always validated to stay inside `workspace.root`, and the agent's cwd is the
  per-issue workspace.
- Tracker credentials never enter the agent environment; they are stripped by name before launch.
- Hooks are trusted configuration and run as the service user.
- The HTTP API binds loopback by default and has no authentication; put it behind a local-only setup.

---

## Development

```bash
npm install
npm run build        # tsc -> dist
npm test             # build + node:test suite (184 tests)
npm run typecheck
```

Source layout:

```
src/
  config/        workflow loader, typed config, strict template engine
  domain/        normalized types + typed errors
  tracker/       adapter contract, GitHub adapter, memory adapter, registry
  workspace/     per-issue directories, key derivation, hooks
  agent/         backend contract, DSH headless backend, Codex app-server backend
  runner/        one worker attempt (workspace → prompt → session → turn loop)
  orchestrator/  poll tick, dispatch, claims, retries, reconciliation
  tools/         host-side tracker tool bridge + generated shim
  observability/ structured logging, runtime snapshot
  server/        dashboard + JSON API
  service.ts     assembly, reload, watching, HTTP wiring
  bin.ts         CLI
test/            conformance suite (workflow, config, template, workspace, GitHub,
                 orchestrator, DSH protocol, HTTP, CLI, service)
```

`test/` mirrors the validation matrix in SPEC.md section 17: parsing and reload, workspace safety and
hooks, adapter normalization and error mapping, dispatch/reconciliation/retry semantics, the DSH
protocol mapping, observability, and CLI lifecycle.
