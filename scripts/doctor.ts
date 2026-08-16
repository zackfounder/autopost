/**
 * Is this machine actually able to run the engine?
 *
 *   npm run doctor
 *
 * Read-only. It opens no browser, touches no account, and publishes nothing —
 * the one network call is a free `/models` lookup to prove the AI key is live.
 * Use it after `npm run setup`, and when a scheduled job starts failing for a
 * reason the log does not explain.
 */
import { existsSync, statSync } from 'node:fs';
import { env } from '../src/config/env.ts';
import { buildAiClient } from '../src/ai/client.ts';

let problems = 0;
const ok = (label: string, detail = '') => console.log(`  ok    ${label}${detail ? `  ${detail}` : ''}`);
const warn = (label: string, fix: string) => console.log(`  warn  ${label}\n        ${fix}`);
const bad = (label: string, fix: string) => {
  problems++;
  console.log(`  FAIL  ${label}\n        ${fix}`);
};

console.log('\nautopost doctor\n───────────────');

// node:sqlite is the database; it does not exist before 22.5.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 5)) ok('node', process.versions.node);
else bad(`node ${process.versions.node}`, 'needs 22.5+ for node:sqlite — `nvm install 22`');

if (existsSync(new URL('../.env', import.meta.url))) ok('.env');
else bad('.env missing', 'run `npm run setup`');

if (env.apiToken) ok('API_TOKEN', 'set');
else warn('API_TOKEN blank', 'the control API is unauthenticated to anything on this machine — run `npm run setup`');

// The dashboard serves the API token to whoever loads it, and that token can
// publish to a real account. Loopback is what makes that acceptable.
if (env.bindHost === '127.0.0.1' || env.bindHost === 'localhost' || env.bindHost === '::1') {
  ok('BIND_HOST', `${env.bindHost} (this machine only)`);
} else if (env.apiToken) {
  warn(`BIND_HOST ${env.bindHost}`, 'the dashboard is reachable from the network; it is token-gated, but loopback is safer');
} else {
  bad(`BIND_HOST ${env.bindHost} with no API_TOKEN`, 'the server will refuse to start — set API_TOKEN or BIND_HOST=127.0.0.1');
}

// .env holds the AI key and the control token.
const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) {
  const mode = statSync(envFile).mode & 0o777;
  if (mode & 0o077) warn(`.env is mode ${mode.toString(8)}`, 'others on this machine can read your keys — `chmod 600 .env`');
  else ok('.env permissions', '600');
}

// The AI lane. Which client you get is decided in src/ai/client.ts: paid only on
// purpose, then free, then mock.
const ai = buildAiClient();
if (ai.kind === 'mock') {
  warn('AI provider: mock', 'no key set, so every generated post is blocked by the gate.\n        Free key: https://console.groq.com/keys, then `npm run setup`');
} else if (ai.kind === 'anthropic') {
  ok('AI provider: anthropic (paid)', env.aiModel);
} else {
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${env.groqApiKey}` },
  }).catch((e: Error) => e);

  if (res instanceof Error) warn('AI provider: groq', `could not reach Groq: ${res.message}`);
  else if (res.status === 401) bad('GROQ_API_KEY rejected (401)', 'get a fresh key at https://console.groq.com/keys');
  else if (!res.ok) warn('AI provider: groq', `Groq answered ${res.status}`);
  else {
    const ids = ((await res.json() as { data?: { id: string }[] }).data ?? []).map((m) => m.id);
    if (ids.includes(env.groqModel)) ok('AI provider: groq (free)', env.groqModel);
    // A retired model id is the failure that shows up hours later, inside a
    // scheduled job, and looks like a broken key.
    else bad(`GROQ_MODEL ${env.groqModel} no longer exists`, `pick one of: ${ids.filter((i) => !/whisper|guard|tts/.test(i)).slice(0, 4).join(', ')}`);
  }
}

// Database + what is connected. Never opens a browser.
if (!existsSync(env.dbPath)) {
  bad('database missing', 'run `npm run setup`');
} else {
  const { listAccounts } = await import('../src/db/index.ts');
  const accounts = listAccounts();
  ok('database', env.dbPath);
  if (accounts.length === 0) {
    warn('no accounts connected', 'e.g. `npm run login -- main-li --platform linkedin`');
  } else {
    for (const a of accounts) {
      const profile = `${env.profilesDir}/${a.name}`;
      if (existsSync(profile)) ok(`account ${a.name}`, a.platform ?? 'linkedin');
      else bad(`account ${a.name} has no browser profile`, `re-run \`npm run login -- ${a.name}\``);
    }
  }
}

if (env.paused) warn('PAUSED=1', 'the scheduler will refuse to run anything until this is 0');

console.log(problems === 0 ? '\nno blocking problems.\n' : `\n${problems} thing(s) to fix.\n`);
process.exit(problems === 0 ? 0 : 1);
