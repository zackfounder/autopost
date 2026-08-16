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
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
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

say('\nautopost setup\n──────────────');

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

let model = current('GROQ_MODEL') || 'llama-3.3-70b-versatile';

if (groqKey) {
  // Validate against /models rather than a completion: it costs no tokens, and it
  // also tells us whether the configured model still exists. Groq retires model
  // ids on its own schedule, and a stale one fails at first generation — hours
  // after setup, in a scheduled job, where nobody is watching.
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${groqKey}` },
  }).catch((e: Error) => e);

  if (res instanceof Error) {
    say(`   could not reach Groq (${res.message}) — key saved, verify later with \`npm run doctor\``);
  } else if (res.status === 401) {
    say('   that key was rejected (401). Saved anyway — re-run setup to replace it.');
  } else if (!res.ok) {
    say(`   Groq answered ${res.status} — key saved, verify later with \`npm run doctor\``);
  } else {
    const body = await res.json() as { data?: { id: string }[] };
    const ids = (body.data ?? []).map((m) => m.id);
    if (ids.includes(model)) {
      say(`   key works, and ${model} is live`);
    } else {
      // Prefer a same-family replacement over the first id in the list, which is
      // frequently a whisper or guard model that cannot write a post at all.
      const replacement = ids.find((id) => /llama.*70b/.test(id))
        ?? ids.find((id) => /llama/.test(id) && !/guard/.test(id))
        ?? ids.find((id) => !/whisper|guard|tts/.test(id));
      if (replacement) {
        say(`   key works. ${model} is gone from Groq — switching to ${replacement}`);
        model = replacement;
      } else {
        say(`   key works, but ${model} is not in this account's model list`);
      }
    }
  }
  next = set(next, 'GROQ_API_KEY', groqKey);
  next = set(next, 'GROQ_MODEL', model);
} else {
  say('   no key — running the deterministic mock provider');
}

writeFileSync(envPath, next);

// ── 4. Database ──────────────────────────────────────────────────────────────
// Imported only now: src/config/env.ts reads .env at import time, so anything
// loaded before this point would see the file as it was before setup wrote it.
step(4, 'database');
const { initSchema, getSetting, setSetting } = await import('../src/db/index.ts');
const { DEFAULT_LIMITS, DEFAULT_WORKING_HOURS } = await import('../src/engine/limits.ts');
const { DEFAULT_PACING } = await import('../src/browser/human.ts');
const { env } = await import('../src/config/env.ts');

initSchema();
if (getSetting<unknown>('limits', null) === null) setSetting('limits', DEFAULT_LIMITS);
if (getSetting<unknown>('workingHours', null) === null) setSetting('workingHours', DEFAULT_WORKING_HOURS);
if (getSetting<unknown>('pacing', null) === null) setSetting('pacing', DEFAULT_PACING);
if (getSetting<unknown>('paused', null) === null) setSetting('paused', false);
say(`   ready at ${env.dbPath}, seeded with warm-up limits`);

// ── 5. What to do next ───────────────────────────────────────────────────────
const { buildAiClient } = await import('../src/ai/client.ts');
say('\n──────────────');
say(`setup done. AI provider: ${buildAiClient().kind}${groqKey ? ` (${model})` : ''}`);
say('\nConnect the accounts you want. A real browser opens and waits for you to log');
say('in yourself — nothing here types a password or touches 2FA. Pick any names:\n');
say('   npm run login -- main-li    --platform linkedin');
say('   npm run login -- main-x     --platform x');
say('   npm run login -- main-quora --platform quora');
say('   npm run login -- main-ih    --platform indiehackers');
say('\nThen:\n');
say('   npm run accounts     # what is connected, and today\'s budget');
say(`   npm run start        # dashboard at http://localhost:${env.port}`);
say('\nThe engine never auto-starts. You press the button.\n');

rl.close();
