/**
 * Setup as a web page instead of a list of commands.
 *
 *   npm run setup
 *
 * Starts a throwaway server on 127.0.0.1, opens a browser at it, and walks
 * through three things: paste a free AI key and watch it get verified, click a
 * button to connect LinkedIn, and schedule the first post. Nothing here is
 * reachable from the network, and the page is served from this file — no CDN,
 * no fonts, no analytics, nothing fetched from anywhere.
 *
 * `npm run setup:cli` is the same flow in the terminal, for a machine with no
 * browser.
 *
 * Deliberate: this file never imports anything that reads `.env` at module load.
 * `src/config/env.ts` snapshots the file on import, so a module loaded before the
 * wizard writes the key would hold a stale copy of it for the whole session.
 * Every database and AI import below is lazy, inside the handler that needs it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { page } from './page.ts';
import { DEFAULT_GROQ_MODEL } from '../ai/models.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');

/* ─────────────────────────────────────────────────────────────── .env I/O */

function readEnv(): Record<string, string> {
  if (!existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

function writeEnv(updates: Record<string, string>): void {
  if (!existsSync(envPath)) copyFileSync(examplePath, envPath);
  let text = readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    text = pattern.test(text) ? text.replace(pattern, `${key}=${value}`) : `${text}\n${key}=${value}`;
  }
  writeFileSync(envPath, text);
  // Holds the AI key and the control-API token.
  chmodSync(envPath, 0o600);
}

/* ────────────────────────────────────────────────────────────── the state */

/** Everything the page needs to draw itself. Recomputed on every poll. */
async function currentState() {
  const env = readEnv();
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);

  let accounts: { name: string; platform: string; status: string }[] = [];
  let jobs = 0;
  let dbReady = false;
  try {
    const { initSchema, listAccounts } = await import('../db/index.ts');
    const { listJobs } = await import('../db/content.ts');
    initSchema();
    dbReady = true;
    accounts = listAccounts().map((a) => ({ name: a.name, platform: a.platform, status: a.status }));
    jobs = listJobs().length;
  } catch {
    /* the database is created on the first key save; before that this is empty */
  }

  return {
    node: { version: process.versions.node, ok: major > 22 || (major === 22 && minor >= 5) },
    hasKey: Boolean(env.GROQ_API_KEY || (env.ANTHROPIC_API_KEY && env.AI_PAID === 'true')),
    keyPreview: env.GROQ_API_KEY ? `${env.GROQ_API_KEY.slice(0, 7)}…` : '',
    model: env.GROQ_MODEL || '',
    hasToken: Boolean(env.API_TOKEN),
    port: Number(env.PORT || 4310),
    dbReady,
    accounts,
    linkedin: accounts.find((a) => a.platform === 'linkedin') ?? null,
    jobs,
    connecting,
  };
}

/** Set while a login browser is open, so the page can show it is waiting. */
let connecting: string | null = null;

/* ────────────────────────────────────────────────────────────── handlers */

const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  'GET /api/state': async () => currentState(),

  /**
   * Verify a key before saving it. `/models` costs nothing and also catches a
   * retired model id — the failure that otherwise appears hours later inside a
   * scheduled job and reads as a broken key.
   */
  'POST /api/key': async (body) => {
    const key = String(body.key ?? '').trim();
    if (!key) return { ok: false, error: 'paste a key first' };

    const { fetchModelIds, pickChatModel } = await import('../ai/models.ts');
    const res = await fetchModelIds(key);
    if (!res.ok) {
      return { ok: false, error: res.status === 401 ? 'Groq rejected that key (401). Copy it again?' : res.error };
    }

    const wanted = readEnv().GROQ_MODEL || DEFAULT_GROQ_MODEL;
    const { model } = pickChatModel(res.ids, wanted);

    const updates: Record<string, string> = { GROQ_API_KEY: key, GROQ_MODEL: model };
    if (!readEnv().API_TOKEN) updates.API_TOKEN = randomBytes(24).toString('hex');
    writeEnv(updates);

    // Your own brief and bank, copied from the examples so you have something
    // to edit that pulling will never overwrite.
    const { seedConfigFiles } = await import('./seed.ts');
    const seeded = seedConfigFiles(root);

    // Now that .env exists, the database can be created.
    const { initSchema, getSetting, setSetting } = await import('../db/index.ts');
    const { DEFAULT_WORKING_HOURS, repairSeededLimits } = await import('../engine/limits.ts');
    const { DEFAULT_PACING } = await import('../browser/human.ts');
    initSchema();
    // Never seed `limits`: a settings row outranks the per-platform caps.
    repairSeededLimits();
    if (getSetting<unknown>('workingHours', null) === null) setSetting('workingHours', DEFAULT_WORKING_HOURS);
    if (getSetting<unknown>('pacing', null) === null) setSetting('pacing', DEFAULT_PACING);
    if (getSetting<unknown>('paused', null) === null) setSetting('paused', false);

    return { ok: true, model, switched: model !== wanted, seeded };
  },

  /**
   * Open a real browser and let the person log in themselves.
   *
   * Detached and silent: nothing here types a password, reads a credential or
   * touches 2FA. `--auto` means login.ts watches the address bar instead of
   * asking a terminal question, because the person is looking at this page.
   */
  'POST /api/connect': async (body) => {
    const platform = String(body.platform ?? 'linkedin');
    const name = String(body.name ?? `main-${platform === 'linkedin' ? 'li' : platform}`);
    if (connecting) return { ok: false, error: `already waiting on ${connecting}` };

    connecting = name;
    const child = spawn('npx', ['tsx', 'scripts/login.ts', name, '--platform', platform, '--auto'], {
      cwd: root,
      stdio: 'ignore',
      detached: true,
    });
    child.on('exit', () => { connecting = null; });
    child.unref();
    return { ok: true, name };
  },

  /** One post a day, published every two hours. The shape almost everyone wants first. */
  'POST /api/first-job': async (body) => {
    const account = String(body.account ?? '').trim();
    const brief = String(body.brief ?? '').trim();
    if (!account) return { ok: false, error: 'connect an account first' };
    if (!brief) return { ok: false, error: 'say what the post should be about' };

    const { getAccountByName } = await import('../db/index.ts');
    const { createJob } = await import('../db/content.ts');
    const acc = getAccountByName(account);
    if (!acc) return { ok: false, error: `no account "${account}"` };

    const payload: Record<string, unknown> = { brief };
    if (body.facts) payload.facts = String(body.facts);

    createJob({ accountId: acc.id, kind: 'generate_post', payload, recurrence: String(body.every ?? '1d') });
    createJob({ accountId: acc.id, kind: 'publish_due', payload: {}, recurrence: '2h' });
    return { ok: true };
  },
};

/* ─────────────────────────────────────────────────────────────── serving */

function send(res: ServerResponse, status: number, payload: unknown, type = 'application/json') {
  const body = type === 'application/json' ? JSON.stringify(payload) : String(payload);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

export function startWizard(port: number): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (url.pathname === '/') return send(res, 200, page(), 'text/html; charset=utf-8');
    if (url.pathname === '/api/quit') {
      send(res, 200, { ok: true });
      console.log('\nSetup finished. See you.\n');
      return setTimeout(() => process.exit(0), 200);
    }

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { error: 'no such route' });

    try {
      let body: Record<string, unknown> = {};
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      send(res, 200, await handler(body));
    } catch (err) {
      send(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 127.0.0.1 only. This server writes .env and can start a login browser; it has
  // no business being reachable from the network for the two minutes it exists.
  server.listen(port, '127.0.0.1', () => {
    const at = `http://127.0.0.1:${port}`;
    console.log(`\nsocial-media-automation-agent setup — open ${at}\n`);
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [at], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
    console.log('If no window opened, paste that address into your browser.');
    console.log('No browser on this machine? Ctrl-C and run: npm run setup:cli\n');
  });
}
