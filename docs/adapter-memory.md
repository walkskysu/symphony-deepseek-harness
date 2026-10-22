# In-memory adapter profile

`tracker.kind: memory`

A deterministic issue list for tests, local demos and smoke runs without credentials. It implements the
same read kernel as the GitHub adapter and additionally ships two mutating tools so the full
agent → tracker loop can be exercised offline.

## Configuration

```yaml
tracker:
  kind: memory
  provider:
    issues:
      - id: "1"
        identifier: DEMO-1
        title: Fix the widget
        state: open
        description: The widget is broken.
        priority: 1
        labels: [bug]
    file: ./issues.json        # optional: re-read this JSON array on every fetch
  active_states: [open]
  terminal_states: [done, closed]
```

| Key | Default | Notes |
|---|---|---|
| `issues` | `[]` | Array of raw records |
| `file` | `null` | JSON array on disk; re-read on every fetch (state changes survive an edit) |

### State defaults

`active_states: [open]`, `terminal_states: [closed]`.

## Normalization

Records use the normalized field names directly. `dispatchable` defaults to `true` when absent because
the adapter itself is the eligibility authority. Everything else follows the shared rules: labels are
trimmed/lowercased/de-duplicated, timestamps parsed, priority coerced to an integer or `null`,
`blocked_by` best-effort.

Malformed records are skipped on a state list and fail an ID refresh, mirroring the GitHub adapter.

## Errors

`invalid_tracker_config` for a non-list `issues` value; `tracker_response` when the configured file cannot
be read or parsed.

## Provider-native agent tools

| Tool | Mutates | Arguments | Result |
|---|---|---|---|
| `issue_set_state` | yes | `state` | `{state}` |
| `issue_comment` | yes | `body` | `{commented}` |

Mutations are in-memory; with `provider.file` set, a subsequent fetch reloads the file and discards them
— point the file at a JSON array only if you want that behavior.

## Secret environment names

None. The adapter declares no credentials, so no environment names are stripped for it.

## When not to use it

There is no durability, no pagination and no scope isolation; it is a fixture, not a tracker.
