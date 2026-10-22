/** Server-rendered operator dashboard (SPEC 13.7.1). */
import type { RuntimeSnapshot } from '../observability/snapshot.js';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSeconds(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${rest}s` : minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

/** Render the dashboard from an orchestrator snapshot only. */
export function renderDashboard(snapshot: RuntimeSnapshot | null, workflowPath: string): string {
  const title = 'Symphony';
  if (snapshot === null) {
    return page(title, `<p class="muted">Starting… no runtime snapshot yet.</p>`);
  }
  const runningRows = snapshot.running.length === 0
    ? `<tr><td colspan="8" class="muted">No active sessions.</td></tr>`
    : snapshot.running
        .map(
          (row) => `<tr>
  <td><a href="/api/v1/${encodeURIComponent(row.issue_identifier)}">${escapeHtml(row.issue_identifier)}</a></td>
  <td>${escapeHtml(row.state)}</td>
  <td>${escapeHtml(row.phase)}</td>
  <td>${escapeHtml(row.session_id ?? '—')}</td>
  <td class="num">${row.turn_count}</td>
  <td>${escapeHtml(row.last_event ?? '—')}</td>
  <td>${escapeHtml(row.last_event_at ?? '—')}</td>
  <td class="num">${row.tokens.total_tokens}</td>
</tr>`,
        )
        .join('\n');

  const retryRows = snapshot.retrying.length === 0
    ? `<tr><td colspan="5" class="muted">Retry queue is empty.</td></tr>`
    : snapshot.retrying
        .map(
          (row) => `<tr>
  <td><a href="/api/v1/${encodeURIComponent(row.issue_identifier)}">${escapeHtml(row.issue_identifier)}</a></td>
  <td class="num">${row.attempt}</td>
  <td>${escapeHtml(row.due_at)}</td>
  <td>${row.continuation ? 'continuation' : 'backoff'}</td>
  <td>${escapeHtml(row.error ?? '—')}</td>
</tr>`,
        )
        .join('\n');

  const health = snapshot.last_error === null ? '<span class="ok">healthy</span>' : `<span class="bad">${escapeHtml(snapshot.last_error)}</span>`;

  return page(
    title,
    `
<section class="cards">
  <div class="card"><div class="label">Running</div><div class="value">${snapshot.counts.running}</div></div>
  <div class="card"><div class="label">Retrying</div><div class="value">${snapshot.counts.retrying}</div></div>
  <div class="card"><div class="label">Total tokens</div><div class="value">${snapshot.codex_totals.total_tokens}</div></div>
  <div class="card"><div class="label">Runtime</div><div class="value">${formatSeconds(snapshot.codex_totals.seconds_running)}</div></div>
  <div class="card"><div class="label">Completed</div><div class="value">${snapshot.completed_count}</div></div>
</section>

<p class="meta">status ${health} · poll every ${snapshot.poll_interval_ms}ms · max ${snapshot.max_concurrent_agents} agents · last tick ${escapeHtml(snapshot.last_tick_at ?? '—')} · generated ${escapeHtml(snapshot.generated_at)}</p>
<p class="meta">workflow <code>${escapeHtml(workflowPath)}</code></p>

<h2>Running sessions</h2>
<table>
<thead><tr><th>Issue</th><th>State</th><th>Phase</th><th>Session</th><th>Turns</th><th>Last event</th><th>Last event at</th><th>Tokens</th></tr></thead>
<tbody>
${runningRows}
</tbody>
</table>

<h2>Retry queue</h2>
<table>
<thead><tr><th>Issue</th><th>Attempt</th><th>Due at</th><th>Kind</th><th>Reason</th></tr></thead>
<tbody>
${retryRows}
</tbody>
</table>

<h2>Tokens</h2>
<table>
<thead><tr><th>Input</th><th>Output</th><th>Total</th></tr></thead>
<tbody><tr><td class="num">${snapshot.codex_totals.input_tokens}</td><td class="num">${snapshot.codex_totals.output_tokens}</td><td class="num">${snapshot.codex_totals.total_tokens}</td></tr></tbody>
</table>
`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="5" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; margin: 24px auto; max-width: 1100px; padding: 0 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; text-transform: uppercase; letter-spacing: .06em; opacity: .75; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent); padding: 6px 8px; text-align: left; vertical-align: top; }
  th { font-weight: 600; opacity: .7; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 18px 0 8px; }
  .card { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 8px; padding: 10px 12px; }
  .card .label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .65; }
  .card .value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .meta { font-size: 12px; opacity: .7; margin: 4px 0; }
  .muted { opacity: .55; }
  .ok { color: #1a7f37; }
  .bad { color: #b42318; }
  code { font-size: 12px; }
  a { color: inherit; }
</style>
</head>
<body>
<h1>Symphony</h1>
<p class="meta">Coding-agent orchestrator · <a href="/api/v1/state">/api/v1/state</a></p>
${body}
</body>
</html>`;
}
