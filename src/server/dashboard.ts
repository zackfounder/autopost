/**
 * Single-file dashboard. No build step, no CDN — everything inline, because this
 * page has to work on a laptop that may be running the browser automation in the
 * foreground and nothing else.
 */
export function dashboardHtml(apiToken: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pilot</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --mut:#666; --line:#e4e4e7; --ok:#0a7d32; --warn:#a15c00; --bad:#b42318; --card:#fafafa; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d0d0f; --fg:#ededed; --mut:#9a9a9a; --line:#26262b; --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; --card:#151518; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg); font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; letter-spacing:-.01em; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--mut); margin:28px 0 10px; font-weight:600; }
  .sub { color:var(--mut); margin:0 0 20px; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  button { font:inherit; padding:6px 12px; border:1px solid var(--line); border-radius:7px; background:var(--card); color:var(--fg); cursor:pointer; }
  button:hover { border-color:var(--mut); }
  button.primary { background:var(--fg); color:var(--bg); border-color:var(--fg); }
  .card { border:1px solid var(--line); border-radius:10px; padding:14px 16px; background:var(--card); }
  .grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--mut); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
  .scroll { overflow-x:auto; }
  pre { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; overflow:auto; max-height:320px; font-size:12px; margin:0; white-space:pre-wrap; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; border:1px solid var(--line); }
  .ok{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)} .mut{color:var(--mut)}
  .bar { height:4px; border-radius:3px; background:var(--line); overflow:hidden; margin-top:5px; }
  .bar > i { display:block; height:100%; background:var(--fg); }
  .qline { display:flex; justify-content:space-between; font-size:12px; margin-top:6px; }
  .body { font-size:12px; max-width:520px; white-space:pre-wrap; }
</style>
</head>
<body>
<h1>pilot</h1>
<p class="sub" id="status">loading…</p>

<div class="row">
  <button class="primary" onclick="api('/api/engine/start','POST')">Start engine</button>
  <button onclick="api('/api/engine/stop','POST')">Stop</button>
  <button onclick="api('/api/engine/pause','POST',{paused:true})">Pause all</button>
  <button onclick="api('/api/engine/pause','POST',{paused:false})">Resume</button>
  <button onclick="refresh()">Refresh</button>
</div>

<h2>Accounts &amp; today's budget</h2>
<div class="grid" id="accounts"></div>

<h2>Scheduled jobs</h2>
<div class="scroll"><table id="jobs"><thead>
<tr><th>#</th><th>Account</th><th>Job</th><th>Every</th><th>Next run</th><th>State</th><th></th></tr>
</thead><tbody></tbody></table></div>

<h2>Content</h2>
<div class="scroll"><table id="content"><thead>
<tr><th>#</th><th>Account</th><th>Kind</th><th>Template</th><th>State</th><th>Body / why it was blocked</th><th></th></tr>
</thead><tbody></tbody></table></div>

<h2>Feed engagement</h2>
<div class="scroll"><table id="feed"><thead>
<tr><th>When</th><th>Account</th><th>Action</th><th>Author</th><th>Reason</th></tr>
</thead><tbody></tbody></table></div>

<h2>Outreach campaigns</h2>
<div class="scroll"><table id="campaigns"><thead>
<tr><th>#</th><th>Name</th><th>Status</th><th>Workflow</th><th>Queue</th><th></th></tr>
</thead><tbody></tbody></table></div>

<h2>Recent actions</h2>
<div class="scroll"><table id="log"><thead>
<tr><th>When</th><th>Action</th><th>Status</th><th>Lead</th><th>Detail</th></tr>
</thead><tbody></tbody></table></div>

<h2>Engine log</h2>
<pre id="tail"></pre>

<script>
const TOKEN = ${JSON.stringify(apiToken)};
async function api(path, method='GET', body) {
  const res = await fetch(path, {
    method,
    headers: Object.assign({'content-type':'application/json'}, TOKEN ? {authorization:'Bearer '+TOKEN} : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (method !== 'GET') setTimeout(refresh, 350);
  return data;
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const statusClass = s => s==='ok'||s==='published' ? 'ok' : s==='blocked'||s==='fail'||s==='failed' ? 'bad' : 'mut';

async function refresh() {
  const [health, limits, jobs, content, feed, camps, log, tail] = await Promise.all([
    api('/api/health'), api('/api/limits'), api('/api/jobs'), api('/api/content?limit=25'),
    api('/api/feed?limit=20'), api('/api/campaigns'), api('/api/log?limit=25'), api('/api/engine/tail?n=50'),
  ]);

  const e = health.engine || {};
  document.getElementById('status').innerHTML =
    '<span class="pill ' + (e.running ? 'ok' : 'mut') + '">' + (e.running ? 'running' : 'stopped') + '</span> ' +
    '<span class="mut">' + esc(e.state) + '</span>' +
    (e.paused ? ' <span class="pill bad">PAUSED</span>' : '') +
    ' <span class="mut">· AI: ' + esc(health.ai) + '</span>';

  document.getElementById('accounts').innerHTML = (limits.usage || []).map(a => {
    const rows = (a.quota || []).filter(q => q.perDay !== null).map(q => {
      const pct = q.perDay ? Math.min(100, Math.round(q.usedToday / q.perDay * 100)) : 0;
      const cls = pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
      return '<div class="qline"><span>' + esc(q.action) + '</span>' +
        '<span class="' + cls + '">' + q.usedToday + ' / ' + q.perDay + '</span></div>' +
        '<div class="bar"><i style="width:' + pct + '%"></i></div>';
    }).join('');
    const st = a.status === 'ok' ? 'ok' : a.status === 'checkpoint' ? 'bad' : 'warn';
    return '<div class="card"><div class="row" style="justify-content:space-between">' +
      '<strong>' + esc(a.account) + '</strong>' +
      '<span class="pill">' + esc(a.platform) + '</span></div>' +
      '<div class="' + st + '" style="font-size:12px;margin:4px 0 8px">' + esc(a.status) + '</div>' +
      rows + '</div>';
  }).join('') || '<div class="card mut">No accounts connected. Run <code>npm run login -- main-x --platform x</code></div>';

  document.getElementById('jobs').querySelector('tbody').innerHTML = (jobs || []).map(j =>
    '<tr><td>' + j.id + '</td><td>' + esc(j.account_name) + ' <span class="mut">' + esc(j.platform) + '</span></td>' +
    '<td>' + esc(j.kind) + '</td><td class="mut">' + esc(j.recurrence || 'one-shot') + '</td>' +
    '<td class="mut">' + esc(j.run_at) + '</td>' +
    '<td class="' + (j.state === 'ready' ? 'ok' : j.state === 'disabled' ? 'mut' : 'warn') + '">' + esc(j.state) +
    (j.last_error ? '<div class="bad" style="font-size:11px">' + esc(j.last_error) + '</div>' : '') + '</td>' +
    '<td><button onclick="api(\\'/api/jobs/state\\',\\'POST\\',{id:' + j.id + ',state:\\'' +
      (j.state === 'ready' ? 'disabled' : 'ready') + '\\'})">' + (j.state === 'ready' ? 'pause' : 'resume') + '</button></td></tr>'
  ).join('') || '<tr><td colspan="7" class="mut">No jobs. <code>npm run schedule -- add &lt;account&gt; engage_feed --every 6h</code></td></tr>';

  document.getElementById('content').querySelector('tbody').innerHTML = (content || []).map(c => {
    const viol = (() => { try { return JSON.parse(c.violations || '[]'); } catch { return []; } })();
    const detail = viol.length ? '<span class="bad">' + esc(viol.join(' · ')) + '</span>' : esc(c.body).slice(0, 400);
    const act = c.state === 'drafted'
      ? '<button onclick="api(\\'/api/content/state\\',\\'POST\\',{id:' + c.id + ',state:\\'queued\\'})">queue</button>'
      : c.permalink ? '<a href="' + esc(c.permalink) + '" target="_blank">open</a>' : '';
    return '<tr><td>' + c.id + '</td><td>' + esc(c.account_name) + '</td><td>' + esc(c.kind) + '</td>' +
      '<td class="mut" style="font-size:11px">' + esc(c.template_id || '—') + '</td>' +
      '<td class="' + statusClass(c.state) + '">' + esc(c.state) + '</td>' +
      '<td class="body">' + detail + '</td><td>' + act + '</td></tr>';
  }).join('') || '<tr><td colspan="7" class="mut">Nothing drafted yet.</td></tr>';

  document.getElementById('feed').querySelector('tbody').innerHTML = (feed || []).map(f =>
    '<tr><td class="mut">' + esc(f.created_at) + '</td><td>' + esc(f.account_name) + '</td>' +
    '<td class="' + (f.action === 'skipped' ? 'mut' : 'ok') + '">' + esc(f.action) + '</td>' +
    '<td>' + esc(f.author || '—') + '</td><td class="mut body">' + esc(f.reason || '') + '</td></tr>'
  ).join('') || '<tr><td colspan="5" class="mut">No feed activity yet.</td></tr>';

  document.getElementById('campaigns').querySelector('tbody').innerHTML = (camps || []).map(c => {
    const queue = (c.funnel || []).map(f => 'step ' + f.step_position + ' ' + f.state + '×' + f.n).join(', ') || '—';
    const wf = (c.steps || []).map(s => s.position + '. ' + s.action).join(' → ');
    const next = c.status === 'running' ? 'paused' : 'running';
    return '<tr><td>' + c.id + '</td><td><strong>' + esc(c.name) + '</strong></td>' +
      '<td><span class="pill ' + (c.status === 'running' ? 'ok' : 'mut') + '">' + esc(c.status) + '</span></td>' +
      '<td class="mut" style="font-size:12px">' + esc(wf) + '</td>' +
      '<td class="mut" style="font-size:12px">' + esc(queue) + '</td>' +
      '<td><button onclick="api(\\'/api/campaign/status\\',\\'POST\\',{id:' + c.id + ',status:\\'' + next + '\\'})">' + next + '</button></td></tr>';
  }).join('') || '<tr><td colspan="6" class="mut">No outreach campaigns.</td></tr>';

  document.getElementById('log').querySelector('tbody').innerHTML = (log || []).map(r =>
    '<tr><td class="mut">' + esc(r.created_at) + '</td><td>' + esc(r.action) + '</td>' +
    '<td class="' + statusClass(r.status) + '">' + esc(r.status) + (r.counted ? ' <span class="mut">·quota</span>' : '') + '</td>' +
    '<td>' + esc(r.full_name || r.profile_url || '—') + '</td>' +
    '<td class="mut body">' + esc(r.detail) + '</td></tr>'
  ).join('') || '<tr><td colspan="5" class="mut">Nothing yet.</td></tr>';

  document.getElementById('tail').textContent = (tail || []).join('\\n');
}
refresh();
setInterval(refresh, 8000);
</script>
</body>
</html>`;
}
