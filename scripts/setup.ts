/**
 * One command to go from `git clone` to a running engine.
 *
 *   npm run setup
 *
 * It writes `.env`, generates the API token, takes one free Groq key and proves
 * it works, creates the database, and prints the exact login commands. Nothing
 * here touches a social account, and nothing types a credential — connecting an
 * account is still a browser window you log into yourself.
 *
 * Safe to re-run. Existing values in `.env` are never overwritten silently: the
 * prompt shows what is already set and Enter keeps it.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const interactive = process.stdin.isTTY === true;

/** Prompts only make sense on a terminal. In CI, take the default and move on. */
async function ask(question: string, fallback = ''): Promise<string> {
  if (!interactive) return fallback;
  const answer = (await rl.question(question)).trim();
  return answer === '' ? fallback : answer;
}

const say = (line = '') => console.log(line);
const step = (n: number, label: string) => say(`\n${n}. ${label}`);

// ── 0. Node version ──────────────────────────────────────────────────────────
// node:sqlite is the database. It does not exist before 22.5, and the failure
// without this check is an import error three files deep.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  say(`\nnode ${process.versions.node} is too old — this needs 22.5 or newer (it uses the`);
  say('built-in node:sqlite). Install it with `nvm install 22` or from nodejs.org.\n');
  rl.close();
  process.exit(1);
}

say('\nlinkedin-browser-agent setup\n──────────────');

// ── 1. .env ──────────────────────────────────────────────────────────────────
step(1, 'configuration');
if (!existsSync(envPath)) {
  copyFileSync(examplePath, envPath);
  say('   created .env from .env.example');
} else {
  say('   .env already exists — keeping every value that is already set');
}

const original = readFileSync(envPath, 'utf8');

/** Reads a key out of the raw file rather than process.env, so re-runs see the file's truth. */
function current(key: string): string {
  const line = new RegExp(`^${key}=(.*)$`, 'm').exec(original);
  return line?.[1]?.trim() ?? '';
}

/** Rewrites a key in place, or appends it if the file predates that setting. */
function set(text: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  return pattern.test(text) ? text.replace(pattern, `${key}=${value}`) : `${text}\n${key}=${value}`;
}

let next = original;

// ── 2. API token ─────────────────────────────────────────────────────────────
step(2, 'control API token');
if (current('API_TOKEN')) {
  say('   already set, left alone');
} else {
  next = set(next, 'API_TOKEN', randomBytes(24).toString('hex'));
  say('   generated — the dashboard and every /api call require it');
}

// ── 3. The free AI key ───────────────────────────────────────────────────────
step(3, 'AI key (free)');
const existingGroq = current('GROQ_API_KEY');
if (existingGroq) {
  say(`   GROQ_API_KEY already set (${existingGroq.slice(0, 7)}…) — Enter keeps it`);
} else {
  say('   Get one free at https://console.groq.com/keys — no card, about a minute.');
  say('   Leave blank to run the mock provider (everything works, but generated');
  say('   posts are always blocked, on purpose).');
}
const groqKey = (await ask('   paste key > ', existingGroq)).trim();

const { DEFAULT_GROQ_MODEL } = await import('../src/ai/models.ts');
let model = current('GROQ_MODEL') || DEFAULT_GROQ_MODEL;

if (groqKey) {
  // Validate against /models rather than a completion: it costs no tokens, and it
  // also tells us whether the configured model still exists. Groq retires model
  // ids on its own schedule, and a stale one fails at first generation — hours
  // after setup, in a scheduled job, where nobody is watching.
  const { fetchModelIds, pickChatModel } = await import('../src/ai/models.ts');
  const res = await fetchModelIds(groqKey);

  if (!res.ok) {
    say(`   ${res.error} — key saved, verify later with \`npm run doctor\``);
  } else {
    const picked = pickChatModel(res.ids, model);
    model = picked.model;
    say(picked.switched
      ? `   key works. The configured model is gone from Groq — switching to ${model}`
      : `   key works, and ${model} is live`);
  }
  next = set(next, 'GROQ_API_KEY', groqKey);
  next = set(next, 'GROQ_MODEL', model);
} else {
  say('   no key — running the deterministic mock provider');
}

writeFileSync(envPath, next);
// The API key and the control-API token both live in this file. On a shared
// machine the default umask leaves it world-readable.
chmodSync(envPath, 0o600);

// ── 4. Database ──────────────────────────────────────────────────────────────
// Imported only now: src/config/env.ts reads .env at import time, so anything
// loaded before this point would see the file as it was before setup wrote it.
step(4, 'your brief and your templates');
const { seedConfigFiles } = await import('../src/setup/seed.ts');
const made = seedConfigFiles(root);
say(made.length
  ? `   created ${made.length} file(s) from the examples — edit them to sound like you:\n     ${made.join('\n     ')}`
  : '   already yours, left alone');

step(5, 'database');
const { initSchema, getSetting, setSetting } = await import('../src/db/index.ts');
const { DEFAULT_WORKING_HOURS, repairSeededLimits } = await import('../src/engine/limits.ts');
const { DEFAULT_PACING } = await import('../src/browser/human.ts');
const { env } = await import('../src/config/env.ts');

initSchema();
// Deliberately NOT seeding `limits`: a settings row outranks the per-platform
// caps, so writing the generic defaults there would override LinkedIn's own.
repairSeededLimits();
if (getSetting<unknown>('workingHours', null) === null) setSetting('workingHours', DEFAULT_WORKING_HOURS);
if (getSetting<unknown>('pacing', null) === null) setSetting('pacing', DEFAULT_PACING);
if (getSetting<unknown>('paused', null) === null) setSetting('paused', false);
say(`   ready at ${env.dbPath}, seeded with warm-up limits`);

// ── 6. Connect LinkedIn ──────────────────────────────────────────────────────
// Offered here rather than left as an instruction, because this is the step that
// actually takes a minute and the one people put off.
const { buildAiClient } = await import('../src/ai/client.ts');
const { listAccounts } = await import('../src/db/index.ts');

step(6, 'LinkedIn');
const connected = listAccounts();
let launched = false;

if (connected.some((a) => a.platform === 'linkedin')) {
  say(`   already connected: ${connected.filter((a) => a.platform === 'linkedin').map((a) => a.name).join(', ')}`);
} else {
  say('   A real browser window opens and waits while YOU log in. Nothing here');
  say('   types a password, reads a credential, or touches 2FA.');
  const go = (await ask('   connect LinkedIn now? [Y/n] ', 'n')).toLowerCase();
  if (go === 'y' || go === 'yes' || go === '') {
    rl.close();
    const { spawnSync } = await import('node:child_process');
    // Inherit the terminal: login.ts asks its own question, and it has to reach
    // the same person who is sitting here.
    spawnSync('npx', ['tsx', 'scripts/login.ts', 'main-li', '--platform', 'linkedin'], {
      cwd: root,
      stdio: 'inherit',
    });
    launched = true;
  } else {
    say('   skipped — run it yourself when you are ready:');
    say('     npm run login -- main-li  --platform linkedin');
  }
}

// ── What to do next ──────────────────────────────────────────────────────────
say('\n──────────────');
say(`setup done. AI provider: ${buildAiClient().kind}${groqKey ? ` (${model})` : ''}`);
if (!launched) {
  say('\nConnect an account when you want one. Pick any name:\n');
  say('   npm run login -- main-li  --platform linkedin');
  say('   npm run login -- main-x   --platform x');
}
say('\nThen:\n');
say('   npm run doctor       # anything wrong? read-only, opens no browser');
say('   npm run accounts     # what is connected, and today\'s budget');
say(`   npm run start        # dashboard at http://localhost:${env.port}`);
say('\nSchedule the first job — one post a day, published every two hours:\n');
say('   npm run schedule -- add main-li generate_post --every 1d \\');
say('     --brief "this week\'s real number or decision" --facts "..."');
say('   npm run schedule -- add main-li publish_due --every 2h');
say('\nThe engine never auto-starts. You press the button.\n');

if (!launched) rl.close();
