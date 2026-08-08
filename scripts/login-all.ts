/**
 * Walk every account that still needs a session, one browser at a time.
 *
 * `npm run login` handles exactly one account, so setting up four platforms means
 * remembering four names, four platform flags, and which ones are already done.
 * This asks the database which are actually missing and only opens those.
 *
 *   npm run login:all              every platform that has no live session
 *   npm run login:all -- --only quora,indiehackers
 *   npm run login:all -- --force   re-check the ones already connected too
 *
 * It never sees a password, never types credentials, never touches a 2FA code.
 * You log in by hand in a real window; it waits until the platform says you are
 * in, then leaves the session in that account's profile directory and moves on.
 */
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { initSchema, listAccounts } from '../src/db/index.ts';
import { PLATFORM_IDS, getPlatform } from '../src/platforms/index.ts';
import { checkLogin, openSession } from '../src/browser/session.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const force = args.includes('--force');
const only = (flag('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// The name each platform's account gets if it does not exist yet. One account,
// one profile directory, one platform — never shared.
const DEFAULT_NAME: Record<string, string> = {
  linkedin: 'main',
  x: 'main-x',
  quora: 'main-quora',
  indiehackers: 'main-ih',
};

initSchema();

const existing = listAccounts();
const byPlatform = new Map(existing.map((a) => [a.platform, a]));

const targets = PLATFORM_IDS
  .filter((p) => (only.length ? only.includes(p) : true))
  .map((p) => ({
    platform: p,
    name: byPlatform.get(p)?.name ?? DEFAULT_NAME[p] ?? `main-${p}`,
    known: byPlatform.has(p),
  }));

console.log('\nChecking which accounts already have a live session.\n');

const needed: typeof targets = [];

for (const t of targets) {
  if (!t.known) {
    console.log(`  ${getPlatform(t.platform).displayName.padEnd(14)} no account yet → will create "${t.name}"`);
    needed.push(t);
    continue;
  }
  if (force) {
    console.log(`  ${getPlatform(t.platform).displayName.padEnd(14)} re-checking (--force)`);
    needed.push(t);
    continue;
  }
  // The only way to know is to open the profile and ask the platform.
  process.stdout.write(`  ${getPlatform(t.platform).displayName.padEnd(14)} checking… `);
  const account = byPlatform.get(t.platform)!;
  try {
    const session = await openSession(account, { headless: true });
    const state = await checkLogin(session);
    await session.close();
    if (state === 'ok') {
      console.log('already logged in, skipping');
    } else {
      console.log(state === 'checkpoint'
        ? 'the platform is challenging this account → needs you'
        : 'session expired → needs login');
      needed.push(t);
    }
  } catch {
    console.log('could not check → will try login');
    needed.push(t);
  }
}

if (!needed.length) {
  console.log('\nEvery account already has a live session. Nothing to do.\n');
  process.exit(0);
}

console.log(`\n${needed.length} to do: ${needed.map((t) => t.platform).join(', ')}`);
console.log('A real browser opens for each. Log in by hand, then close the window.');
console.log('Nothing here ever sees your password or your 2FA code.\n');

const rl = createInterface({ input: stdin, output: stdout });

for (const [i, t] of needed.entries()) {
  const label = getPlatform(t.platform).displayName;
  const answer = await rl.question(
    `[${i + 1}/${needed.length}] Open ${label} now? (enter to go, s to skip) `,
  );
  if (answer.trim().toLowerCase() === 's') {
    console.log(`  skipped ${label}\n`);
    continue;
  }

  const res = spawnSync(
    'npx',
    ['tsx', 'scripts/login.ts', t.name, '--platform', t.platform],
    { stdio: 'inherit' },
  );

  console.log(res.status === 0 ? `  ${label} done\n` : `  ${label} did not finish — run it again later\n`);
}

rl.close();

console.log('Where things stand:\n');
spawnSync('npx', ['tsx', 'scripts/accounts.ts'], { stdio: 'inherit' });
console.log(
  '\nQuora and Indie Hackers need a real account on the platform first.\n' +
  'If one of those failed, register there in a normal browser, then rerun this.\n',
);
