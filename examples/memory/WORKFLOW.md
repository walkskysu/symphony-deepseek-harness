---
# Offline demo: an in-memory issue list plus a fake coding agent.
#
#   npm run demo
#
# The demo script injects the agent executable and the workspace root, so this
# file stays portable. It exercises the whole loop: dispatch -> workspace ->
# prompt -> agent turn -> host-side tracker tool -> handoff state -> retry
# release.
tracker:
  kind: memory
  provider:
    issues:
      - id: "1"
        identifier: DEMO-1
        title: Fix the flaky login test
        state: open
        description: |
          `auth.spec.ts` fails intermittently in CI. Find the race and fix it.
        priority: 1
        labels: [bug, ci]
      - id: "2"
        identifier: DEMO-2
        title: Document the release process
        state: done
        description: Already finished; its workspace is cleaned at startup.
        priority: 3
        labels: [docs]
  active_states: [open]
  terminal_states: [done]

polling:
  interval_ms: 2000

workspace:
  root: $SYMPHONY_DEMO_WORKSPACES

agent:
  max_turns: 3
  max_concurrent_agents: 2

harness:
  kind: dsh

server:
  port: 0
---

You are working on `{{ issue.identifier }}`: **{{ issue.title }}**.

{{ issue.description }}

Labels: {% for label in issue.labels %}`{{ label }}`{% unless forloop.last %}, {% endunless %}{% endfor %}
Attempt: {{ attempt | default: "first run" }}

Use the tracker tools to record progress, then move the issue to `review`.
