# Trust and safety posture

SPEC.md requires every implementation to document its trust boundary, its approval/sandbox posture and
how it handles user-input requests. This file is that contract.

## Intended environment

**Trusted, single-tenant operators.** The issue tracker contents, the repository checked out into a
workspace, and `WORKFLOW.md` itself are all treated as **trusted input** — a workflow author can run
arbitrary shell commands through hooks and can point the agent at any repository the host can reach.

That means:

- Run the service as a dedicated, non-privileged OS user.
- Point `workspace.root` at a dedicated directory (ideally a dedicated volume) with restrictive
  permissions.
- Do not run it on a host that also holds unrelated secrets.
- Treat anyone who can edit `WORKFLOW.md`, labels, or issue bodies as able to influence what the agent
  does. SPEC.md section 15.5 explicitly warns that tracker data is not automatically trustworthy; if you
  dispatch from a source you do not control, add an out-of-band review step before the agent runs.

The HTTP API is **not** a security boundary: it binds loopback by default and has no authentication.

## Process and filesystem

| Control | Behavior |
|---|---|
| Agent cwd | Always the per-issue workspace; the runner re-validates the path before launching |
| Workspace containment | `workspace_path` must stay inside `workspace.root`, checked by path resolution (not string prefix) |
| Workspace names | `[A-Za-z0-9._-]` only; anything sanitized also gets a 64-bit hash suffix, so `a/b` ≠ `a b` |
| Workspace reuse | Preserved after successful runs; removed for terminal issues at startup or on a terminal transition |
| Hooks | Arbitrary shell from `WORKFLOW.md`, run with the workspace as cwd and a hard timeout (`hooks.timeout_ms`). They are trusted configuration. Output is truncated in logs. |
| Hook environment | Hooks run inside the Symphony process and **do** inherit the service environment, including the tracker token. Only the agent subprocess is scrubbed. This is deliberate (a private `git clone` in `after_create` can use the host credential helper), but it means `WORKFLOW.md` must be reviewed like code. |
| Host shell | `sh -lc` (POSIX), `bash -lc` if available (Windows), otherwise `powershell -NoProfile -NonInteractive -Command` |
| Process tree | On Windows, cancellation uses `taskkill /T /F` so agent grandchildren do not leak |

Symphony does **not** add its own filesystem sandbox around the agent and does not claim to. Confinement
beyond the workspace is the agent backend's job (see the next section).

## Approval and sandbox posture

Approval, sandbox and confirmation policy is implementation-defined in SPEC.md; this build chooses:

- **Codex backend**: `codex.approval_policy`, `codex.thread_sandbox` and `codex.turn_sandbox_policy` are
  passed through verbatim to the app-server. Defaults are whatever the installed Codex version defaults
  to. Symphony auto-approves command and file-change approval requests for the session, unless
  `codex.approval_policy` is `never`, in which case it denies them and emits
  `approval_auto_approved`/`unsupported_tool_call` events for the audit trail.
- **DSH backend**: the agent inherits DSH's own tool/sandbox configuration for the selected profile;
  Symphony does not inject an approval channel. A `dsh` profile that requires interactive approval will
  fail or hang on its own policy, not on Symphony's.

If you need a stricter posture, set the agent's own sandbox/approval settings (Codex) or restrict the
DSH profile's tools. Symphony's contribution is the isolation boundary, not the policy engine.

## User-input requests

A run must never stall waiting for a human. Both backends fail the turn instead:

- Codex: a server→client input/question request is answered with a JSON-RPC error and the turn ends as
  `turn_input_required`.
- DSH: the one-shot profile cannot ask for input; if the stream ends `turn_end` with a non-completed
  reason the turn fails.

A failed turn becomes a normal worker failure and is retried with exponential backoff, so an agent that
keeps asking for input will keep failing visibly rather than blocking a slot forever.

## Unsupported tool calls

An unsupported dynamic tool call is answered with a structured failure and the session continues. The
tool bridge does the same for unknown tool names and invalid arguments. Nothing waits indefinitely.

## Secrets

- **Tracker credentials never reach the agent.** Adapters declare their credential environment names
  (`GITHUB_TOKEN`, `GH_TOKEN`, the configured `token_env`); the runner strips those names,
  case-insensitively, from the child environment before launch.
- **`.env` is supported and preferred.** Symphony reads `<directory of WORKFLOW.md>/.env`, then
  `<cwd>/.env` (or `--env-file <path>`). The launch environment always wins; the file only fills
  variables the environment does not define at all. `.env` is re-read on every workflow reload, and a
  changed credential rebuilds the adapter.
- **`.env` values are never logged.** Only the file path and the *names* of the variables it supplied
  appear in the `env file loaded` record.
- **Keep `.env` out of git.** `.gitignore` already excludes `.env` / `.env.*` and allows
  `.env.example`, which documents the required names without values.
- **Tool bridge tokens are scoped.** Each running attempt gets a random 192-bit token that only grants
  access to the tracker tools for that issue's own `native_ref` scope. It is revoked when the attempt
  ends and is not written to the workspace.
- **Tokens are never logged.** Startup validation reports "missing" rather than echoing values; HTTP
  error messages include a truncated provider body, which GitHub does not use for credentials.
- **Literal credentials in `WORKFLOW.md` are a bad idea.** The file is repository-owned and may be
  readable from inside the workspace. Use `$VAR` references backed by `.env`.
- **Hooks see these values.** Hooks run inside the Symphony process and inherit the effective
  environment, including `.env` values; only the agent subprocess is scrubbed.
- `.env` files: the DSH headless profile additionally reads `<workspace>/.env` and `$DSH_HOME/.env` for
  model keys. That is DSH's documented resolution order and is outside Symphony's control; keep those
  files free of tracker tokens.

## Logs and the HTTP surface

- Logs are structured JSON lines. Issue and session context is attached to issue/session events;
  payload fields are capped, and hook output is truncated.
- The dashboard and JSON API expose issue identifiers, states, token counts and error strings. They do
  not expose credentials, prompts, or full agent output.
- Neither surface is required for correctness: the service keeps scheduling if the HTTP server fails to
  start or a log sink breaks.

## Operator checklist

1. Dedicated OS user and a dedicated `workspace.root`.
2. `GITHUB_TOKEN` scoped to only the configured repositories, with `issues: write` only if the agent
   needs to update tickets.
3. `server.port` left unset if you do not need the dashboard, or bound to `127.0.0.1`.
4. `hooks.*` reviewed like code — they run with the service's privileges.
5. `tracker.required_labels` used to keep irrelevant or externally-authored issues out of dispatch.
