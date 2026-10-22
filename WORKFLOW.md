---
# Symphony working on its own repository.
#
#   node dist/src/bin.js .\WORKFLOW.md --port 4173
#
# Prerequisites (once):
#   1. `.env` beside this file with GITHUB_TOKEN for walkskysu/symphony-deepseek-harness.
#      A fine-grained PAT needs: Repository access = this repository,
#      Permissions -> Issues: Read and write (Read alone cannot comment, label
#      or close), Metadata: Read.
#   2. These labels must exist on the repository:
#        status:todo  status:in-progress  status:review  status:blocked
#        status:done  status:cancelled
#      Keep exactly one `status:*` label per issue: an issue that gains
#      `status:review` while it still carries `status:todo` is resolved by
#      `state_priority` below (terminal, then handoff, then work states).
#      Creating them also needs Issues: Write. Until they exist, dispatch finds
#      nothing: an issue without a `status:*` label falls back to its native
#      `open` state, which is not in `active_states` below.
#
# Operating model: a human puts `status:todo` on an issue; Symphony clones this
# repository into a per-issue workspace, runs the DeepSeek Harness agent, and the
# agent moves the issue to `status:review` (or `status:blocked`) when it is done.
# Reaching `status:done` stops the run and removes the workspace.
#
# Workspaces are reused, and `after_create` runs only when one is created. If you
# push to this repository after a workspace already exists, that workspace keeps
# the old checkout (and `npm ci` then fails on the missing lockfile). Reset it:
#   Remove-Item -Recurse -Force "$env:USERPROFILE\.symphony\workspaces\symphony-deepseek-harness\<workspace-key>"
# The key is the directory name under that root (it is logged as `workspace`).
tracker:
  kind: github
  provider:
    repository: walkskysu/symphony-deepseek-harness
    token: $GITHUB_TOKEN
    # State read from the `status:<name>` label; falls back to open/closed.
    state_source: labels
    label_prefix: "status:"
  active_states: [todo, in-progress]
  terminal_states: [done, cancelled]
  # Nothing here is required beyond the state label; add labels (for example
  # `symphony`) if you want a second explicit opt-in per issue.
  required_labels: []
  # GitHub returns an issue's labels in the order they were added, so an issue
  # that gains `status:review` while it still carries `status:todo` would
  # otherwise keep resolving to `todo`. This list makes resolution
  # deterministic: the first state present wins. Terminal states rank highest so
  # a stale label cannot keep a finished issue dispatchable.
  state_priority: [done, cancelled, review, blocked, in-progress, todo]

polling:
  interval_ms: 60000

workspace:
  root: ~/.symphony/workspaces/symphony-deepseek-harness

hooks:
  # Fresh, shallow clone for every new issue workspace.
  after_create: |
    git clone --depth 1 https://github.com/walkskysu/symphony-deepseek-harness.git .
  # Reinstall dependencies before each attempt so the agent starts from a
  # coherent node_modules even if a previous attempt left it dirty.
  before_run: |
    npm ci --no-audit --no-fund
  after_run: |
    git status --short
  timeout_ms: 600000

agent:
  max_concurrent_agents: 2
  max_turns: 12
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    in-progress: 1

# DeepSeek Harness CLI backend. The model is selected by the DSH profile.
harness:
  kind: dsh
  profile: headless
  # Path to the dsh CLI. `$DSH_COMMAND` lives in .env because an npx install is
  # not on PATH for a plain shell. After `npm i -g @deepseek-ai/dsh` you can
  # delete this line and the .env entry, and the backend falls back to `dsh`.
  command: $DSH_COMMAND

codex:
  turn_timeout_ms: 3600000   # max silence during one turn
  read_timeout_ms: 5000      # startup handshake
  stall_timeout_ms: 600000   # 10 minutes without any agent event

tools:
  enabled: true
  prompt_hint: true

server:
  port: 4173
---

You are the coding agent for `{{ issue.identifier }}`: **{{ issue.title }}**.

## Repository

`{{ issue.native_ref.repository }}` — Symphony itself: a TypeScript/Node.js daemon that implements the
OpenAI Symphony service specification. `SPEC.md` is the contract this code must keep; read the relevant
section before changing behavior. `README.md` documents the configuration surface, and `docs/` holds the
adapter profiles and the trust posture.

## The task

{{ issue.description | default: "No description was given. Infer the smallest correct change from the title and the current code." }}

## Working agreement

1. Your working directory is a fresh clone of this repository, dedicated to this issue. Work only inside it.
2. `npm ci` has already run. Establish the baseline first (`npm run build`, `npm run typecheck`, `npm test`)
   and run the same three commands before you finish.
3. Make the smallest change that fully solves the task. Keep the existing layering:
   `config` (workflow/config/template), `tracker`, `workspace`, `agent`, `runner`, `orchestrator`,
   `observability`, `server`, assembled by `service.ts`.
4. Any behavior constrained by the specification needs a test under `test/`. The suite must stay green.
5. If you change a documented surface, update `README.md` or the matching page under `docs/`.
6. Never read, print or commit `.env` files or credentials. Tracker credentials are not available to you;
   use the tracker tools below instead.
7. Commit on a branch named `symphony/{{ issue.identifier | replace: "/", "-" | replace: "#", "-" }}` with a
   message that starts with `{{ issue.identifier }}`. Do **not** push: leave the commit in the workspace
   for a human to review and push.
8. Record progress on the ticket with the tracker tools:
   - add `status:in-progress` when you start working;
   - post **one** comment with what changed, how you verified it, and the branch and commit;
   - when the work is ready for review, add `status:review` and then remove `status:in-progress` and
     `status:todo`, so exactly one `status:*` label remains;
   - if you cannot proceed, add `status:blocked` (and remove the other status labels) and state exactly
     what you need from a human.
9. Do not close the issue: a human decides the final state.

## Definition of done

- `npm run build`, `npm run typecheck` and `npm test` pass (or the reason they cannot run is documented).
- The change is committed on the issue branch.
- The ticket carries the status label that reflects the real outcome plus a comment a reviewer can act on.

Write the ticket comment in the language the issue is written in.
