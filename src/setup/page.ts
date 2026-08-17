/**
 * The setup wizard's one page.
 *
 * Everything is inline — no CDN, no font, no image, nothing fetched from
 * anywhere. This page is served for about two minutes on 127.0.0.1 and then the
 * server exits, and it should not need the internet to render.
 */
export const page = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>linkedin-browser-agent setup</title>
<style>
  :root {
    --bg: #0b0d10; --card: #14181d; --line: #232a32; --text: #e8edf2;
    --dim: #8b97a5; --ok: #3ddc97; --warn: #ffb457; --bad: #ff6b6b; --accent: #4c8dff;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f8fa; --card:#fff; --line:#e2e7ec; --text:#12171c; --dim:#5d6b7a; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text); line-height: 1.55;
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; justify-content: center; padding: 40px 20px 80px;
  }
  .wrap { width: 100%; max-width: 620px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.02em; }
  .sub { color: var(--dim); margin: 0 0 28px; }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 20px 22px; margin-bottom: 14px; transition: opacity .2s;
  }
  .card.locked { opacity: .45; pointer-events: none; }
  .head { display: flex; align-items: center; gap: 11px; margin-bottom: 6px; }
  .num {
    width: 24px; height: 24px; flex: none; border-radius: 50%; font-size: 13px; font-weight: 600;
    display: grid; place-items: center; background: var(--line); color: var(--dim);
  }
  .card.done .num { background: var(--ok); color: #06120c; }
  h2 { font-size: 16px; margin: 0; font-weight: 600; }
  p.note { color: var(--dim); margin: 0 0 14px 35px; font-size: 14px; }
  .body { margin-left: 35px; }
  label { display: block; font-size: 13px; color: var(--dim); margin: 12px 0 5px; }
  input, textarea, select {
    width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--bg); color: var(--text); font: inherit; font-size: 14px;
  }
  textarea { min-height: 62px; resize: vertical; }
  input:focus, textarea:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  button {
    margin-top: 14px; padding: 10px 18px; border-radius: 8px; border: 0; cursor: pointer;
    background: var(--accent); color: #fff; font: inherit; font-weight: 600; font-size: 14px;
  }
  button.ghost { background: transparent; color: var(--dim); border: 1px solid var(--line); }
  button:disabled { opacity: .5; cursor: default; }
  a { color: var(--accent); }
  .msg { margin-top: 12px; font-size: 14px; display: none; }
  .msg.show { display: block; }
  .msg.ok { color: var(--ok); } .msg.bad { color: var(--bad); } .msg.warn { color: var(--warn); }
  .checks { list-style: none; padding: 0; margin: 18px 0 0; font-size: 14px; }
  .checks li { display: flex; gap: 10px; padding: 5px 0; color: var(--dim); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--line); margin-top: 7px; flex: none; }
  .dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); } .dot.warn { background: var(--warn); }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
    background: var(--bg); border: 1px solid var(--line); border-radius: 5px; padding: 1px 6px;
  }
  .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--line);
    border-top-color: var(--accent); border-radius: 50%; animation: s .7s linear infinite; vertical-align: -1px; }
  @keyframes s { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="wrap">
  <h1>linkedin-browser-agent</h1>
  <p class="sub">Three steps. Nothing leaves this machine.</p>

  <!-- 1 ─────────────────────────────────────────────────────────────────── -->
  <div class="card" id="c1">
    <div class="head"><div class="num">1</div><h2>Add a free AI key</h2></div>
    <p class="note">
      Groq's free tier, no card:
      <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">console.groq.com/keys</a>.
      It is checked against Groq before it is saved.
    </p>
    <div class="body">
      <input id="key" type="password" placeholder="gsk_..." autocomplete="off" spellcheck="false">
      <button id="saveKey">Verify and save</button>
      <div class="msg" id="keyMsg"></div>
    </div>
  </div>

  <!-- 2 ─────────────────────────────────────────────────────────────────── -->
  <div class="card locked" id="c2">
    <div class="head"><div class="num">2</div><h2>Connect LinkedIn</h2></div>
    <p class="note">
      A real browser window opens and <strong>you</strong> log in. Nothing here types a
      password, reads a credential, or touches 2FA. Come back to this page when you are in.
    </p>
    <div class="body">
      <button id="connect">Open the login window</button>
      <div class="msg" id="connectMsg"></div>
    </div>
  </div>

  <!-- 3 ─────────────────────────────────────────────────────────────────── -->
  <div class="card locked" id="c3">
    <div class="head"><div class="num">3</div><h2>Schedule the first post</h2></div>
    <p class="note">
      It writes a draft on a schedule and publishes what passed the content gate.
      Nothing is published until you start the engine.
    </p>
    <div class="body">
      <label for="brief">What should it write about?</label>
      <textarea id="brief" placeholder="This week's real number or decision. Nothing invented."></textarea>
      <label for="facts">The only facts it may use (optional but strongly recommended)</label>
      <textarea id="facts" placeholder="MRR 180. 12 trials. Shipped the Telegram loop Tuesday."></textarea>
      <label for="every">How often?</label>
      <select id="every">
        <option value="1d">Once a day</option>
        <option value="2d">Every two days</option>
        <option value="7d">Once a week</option>
      </select>
      <button id="schedule">Schedule it</button>
      <button id="skip" class="ghost">Skip for now</button>
      <div class="msg" id="jobMsg"></div>
    </div>
  </div>

  <div class="card" id="status">
    <div class="head"><div class="num">✓</div><h2>Where things stand</h2></div>
    <div class="body">
      <ul class="checks" id="checks"></ul>
      <div id="finish" style="display:none">
        <button id="done">Finish</button>
      </div>
    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const api = async (path, body) => (await fetch(path, {
  method: body ? 'POST' : 'GET',
  headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
})).json();

const say = (el, text, kind) => { el.className = 'msg show ' + (kind || ''); el.innerHTML = text; };

let state = {};

function render() {
  const keyed = state.hasKey;
  const linked = state.linkedin && state.linkedin.status === 'ok';

  $('c1').classList.toggle('done', keyed);
  $('c2').classList.toggle('locked', !keyed);
  $('c2').classList.toggle('done', !!linked);
  $('c3').classList.toggle('locked', !linked);
  $('c3').classList.toggle('done', state.jobs > 0);

  if (state.connecting && !linked) {
    say($('connectMsg'), '<span class="spin"></span> Waiting for you to finish logging in…', 'warn');
  } else if (linked) {
    say($('connectMsg'), 'Connected as ' + state.linkedin.name + '.', 'ok');
  }

  const rows = [
    ['Node ' + state.node.version, state.node.ok, 'needs 22.5 or newer'],
    [keyed ? 'AI key verified (' + (state.model || 'ready') + ')' : 'No AI key yet', keyed, 'step 1'],
    [state.dbReady ? 'Database ready' : 'No database yet', state.dbReady, 'created with the key'],
    [linked ? 'LinkedIn connected as ' + state.linkedin.name : 'LinkedIn not connected', !!linked, 'step 2'],
    [state.jobs > 0 ? state.jobs + ' job(s) scheduled' : 'Nothing scheduled', state.jobs > 0, 'step 3, optional'],
    ['Reachable from this machine only (127.0.0.1)', true, ''],
  ];
  $('checks').innerHTML = rows.map(([label, ok, hint]) =>
    '<li><span class="dot ' + (ok ? 'ok' : 'warn') + '"></span><span>' + label +
    (ok || !hint ? '' : ' <span style="opacity:.6">— ' + hint + '</span>') + '</span></li>').join('');

  $('finish').style.display = linked ? 'block' : 'none';
}

async function poll() {
  state = await api('/api/state');
  render();
}

$('saveKey').onclick = async () => {
  const key = $('key').value.trim();
  if (!key) return say($('keyMsg'), 'Paste the key first.', 'bad');
  $('saveKey').disabled = true;
  say($('keyMsg'), '<span class="spin"></span> Asking Groq…', 'warn');
  const r = await api('/api/key', { key });
  $('saveKey').disabled = false;
  if (!r.ok) return say($('keyMsg'), r.error, 'bad');
  say($('keyMsg'), 'Verified and saved. Model: ' + r.model +
    (r.switched ? ' (the configured one was retired, so this replaced it)' : '') + '.' +
    (r.seeded && r.seeded.length
      ? '<br>Your brief and template bank are now in <code>instructions/</code> and ' +
        '<code>templates/</code> — edit them to sound like you.'
      : ''), 'ok');
  $('key').value = '';
  poll();
};

$('connect').onclick = async () => {
  say($('connectMsg'), '<span class="spin"></span> Opening a browser window…', 'warn');
  const r = await api('/api/connect', { platform: 'linkedin' });
  if (!r.ok) say($('connectMsg'), r.error, 'bad');
  poll();
};

$('schedule').onclick = async () => {
  const brief = $('brief').value.trim();
  if (!brief) return say($('jobMsg'), 'Say what it should write about.', 'bad');
  const r = await api('/api/first-job', {
    account: state.linkedin && state.linkedin.name,
    brief, facts: $('facts').value.trim(), every: $('every').value,
  });
  say($('jobMsg'), r.ok ? 'Scheduled. It drafts on your schedule and publishes every 2 hours.' : r.error,
    r.ok ? 'ok' : 'bad');
  poll();
};

$('skip').onclick = () => say($('jobMsg'), 'Skipped. Add one later with <code>npm run schedule</code>.', 'warn');

$('done').onclick = async () => {
  await api('/api/quit', {});
  document.body.innerHTML =
    '<div class="wrap"><h1>Done.</h1><p class="sub">Back to your terminal:</p>' +
    '<div class="card"><div class="body" style="margin:0">' +
    '<p><code>npm run start</code> — the dashboard, on port ' + (state.port || 4310) + '. ' +
    'The engine stays stopped until you press the button.</p>' +
    '<p><code>npm run doctor</code> — if anything ever looks wrong.</p>' +
    '</div></div></div>';
};

poll();
setInterval(poll, 2500);
</script>
</body>
</html>`;
