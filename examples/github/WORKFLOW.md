---
# A realistic GitHub + DeepSeek Harness workflow.
#
# Copy this file to the root of the repository you want Symphony to work on (as
# ./WORKFLOW.md) and adjust the repository, states and hooks. Symphony re-reads
# and re-applies this file whenever it changes — no restart needed.
tracker:
  kind: github
  provider:
    # owner/name of the repository whose issues are the work queue. To poll
    # several repositories in one workflow, replace this with:
    #   repositories: [octocat/hello-world, octocat/spoon-knife]
    repository: octocat/hello-world
    # Resolved from a `.env` file beside this workflow (or the launch
    # environment). Never commit a literal token here.
    token: $GITHUB_TOKEN
    # Kanban-style states derived from labels: `status:todo` -> `todo`.
    state_source: labels
    label_prefix: "status:"
    # Deterministic resolution when an issue carries several status labels: the
    # first state present wins. Terminal, then handoff, then work states.
    state_priority: [done, cancelled, review, blocked, in-progress, todo]
  # Issues in these states are candidates for dispatch.
  active_states: [todo, in-progress]
  # Reaching one of these stops the run and removes the workspace.
  terminal_states: [done, cancelled]
  # Optional: only work on issues that carry all of these labels.
  required_labels: []

polling:
  interval_ms: 30000

workspace:
  # One directory per issue is created under this root. `~` and `$VAR` expand.
  root: ~/.symphony/workspaces

hooks:
  # Runs once, when a workspace is first created. Clone the issue's repository
  # here. The hook environment carries the current issue, so the same workflow
  # works when `repositories` names more than one repository.
  after_create: |
    git clone --depth 1 "https://github.com/$(node -p 'JSON.parse(process.env.SYMPHONY_ISSUE_NATIVE_REF).repository').git" .
  # Runs before every agent attempt. Keep it fast; a failure aborts the attempt.
  before_run: |
    npm ci --no-audit --no-fund
  # Runs after every attempt, including failures and cancellations. Failures are
  # logged and ignored.
  after_run: |
    echo "run finished in $(pwd)"
  timeout_ms: 600000

agent:
  max_concurrent_agents: 4
  max_turns: 20
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    in-progress: 2

# The DeepSeek Harness CLI backend (extension; `codex` is the spec default).
# The model is chosen by the DSH profile/settings; `harness.args` can pass extra
# flags, and `harness.model` applies to the codex backend only.
harness:
  kind: dsh
  profile: headless

codex:
  # Timeouts are shared by both backends.
  turn_timeout_ms: 3600000   # max silence during a turn
  read_timeout_ms: 5000      # startup handshake
  stall_timeout_ms: 300000   # orchestrator stall detection

tools:
  # Host-side tracker tools (issue_comment, issue_add_labels, ...) plus the
  # generated shim. The agent never sees the GitHub token.
  enabled: true
  prompt_hint: true

server:
  port: 4173
---

You are the coding agent for `{{ issue.identifier }}`: **{{ issue.title }}**.

## Context

- Repository: `{{ issue.native_ref.repository }}`
- Tracker URL: {{ issue.url }}
- Current state: `{{ issue.state }}`
- Labels: {% if issue.labels.size > 0 %}{% for label in issue.labels %}`{{ label }}`{% unless forloop.last %}, {% endunless %}{% endfor %}{% else %}none{% endif %}
- Attempt: {{ attempt | default: "first run" }}

## Task

{{ issue.description | default: "No description was provided. Infer the smallest correct change from the title and the repository state." }}

## Working agreement

1. Work only inside the current working directory. This workspace is dedicated to this issue.
2. Read the repository before changing it: check `README`, `package.json`, existing tests and CI config.
3. Make the smallest change that fully solves the task. Do not reformat unrelated files.
4. Run the project's own checks (lint, typecheck, tests) before you conclude. If a check cannot run,
   say so explicitly instead of pretending it passed.
5. Commit your work on a branch named `symphony/{{ issue.identifier | replace: "/", "-" }}` with a
   message that references the issue. Do not push unless the workflow explicitly asks you to.
6. Update the ticket through the tracker tools, not by editing files:
   - add `status:in-progress` when you start;
   - post a short comment with what changed and how you verified it;
   - when the work is ready for a human, add `status:review` (the handoff state) and remove
     `status:in-progress`.
7. If the task is ambiguous or blocked, stop and leave a comment explaining exactly what you need.
   Do not guess at destructive actions.

## Definition of done

- The repository builds and its tests pass (or the reason they cannot run is documented).
- The change is committed on the issue branch.
- The ticket carries a status label that reflects the real outcome plus a comment a reviewer can act on.
