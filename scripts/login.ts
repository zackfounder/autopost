import { initSchema, upsertAccount, setAccountStatus } from '../src/db/index.ts';
import { openSession, profileDirFor, checkLogin, observeLogin, whoAmI } from '../src/browser/session.ts';
import { getPlatform, PLATFORM_IDS, isPlatformId } from '../src/platforms/index.ts';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/**
 * One-time, interactive, and deliberately manual: this opens a real browser window
 * and YOU log in. The script never sees or asks for a password, never types
 * credentials, and never touches a 2FA code. It waits until the platform says
 * you're in, then leaves the session in that account's profile directory.
 *
 *   npm run login -- main-linkedin --platform linkedin
 *   npm run login -- main-x        --platform x
 *
 * One account = one browser profile = one platform. Never share a profile directory
 * between two accounts, and never between two platforms.
 */
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true);

function flag(n: string): string | undefined {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const platform = flag('platform') ?? 'linkedin';
const proxy = flag('proxy');
// --auto: no terminal question. Used by the browser setup wizard, where the
// person is looking at a web page, not at this shell.
const auto = args.includes('--auto');

if (!name || !isPlatformId(platform)) {
  console.error('usage: npm run login -- <account-name> --platform <platform> [--proxy <url>] [--reset]');
  console.error(`platforms: ${PLATFORM_IDS.join(' | ')}`);
  process.exit(1);
}

const adapter = getPlatform(platform);
const reset = args.includes('--reset');

initSchema();

// Signing out inside the platform is unreliable and slow. Deleting the profile
// directory is the honest way to say "this is the wrong account" — the next
// launch starts with no cookies at all.
if (reset) {
  const { rmSync } = await import('node:fs');
  const dir = profileDirFor(name);
  rmSync(dir, { recursive: true, force: true });
  console.log(`wiped the session for "${name}". Starting clean.`);
}
const account = upsertAccount(name, profileDirFor(name), proxy, platform);
console.log(`account "${name}"  platform=${adapter.displayName}`);
console.log(`profile dir: ${account.profile_dir}`);
if (proxy) console.log(`proxy: ${proxy.replace(/:[^:@]+@/, ':***@')}`);

const session = await openSession(account, { headless: false });
await session.page.goto(adapter.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

console.log(`\nA browser window is open at ${adapter.displayName}.`);
console.log('Log in there yourself, including any 2FA. This script will wait.');
console.log('Nothing is typed for you and no credentials are read.\n');

// Watch, do not touch — and never decide on your own that he is finished.
//
// The first version navigated every five seconds and destroyed LinkedIn's 2FA.
// The second stopped navigating but still guessed from the URL, which is wrong
// for any platform that opens its login in a modal over the homepage: the
// address bar reads the same either way, so "logged in" fires while the person
// is still looking at the form.
//
// The person at the keyboard knows when they are logged in. Ask them.
const deadline = Date.now() + 20 * 60_000;
let state = observeLogin(session);

if (auto) {
  // Watch, never navigate. observeLogin only reads the address bar, so this
  // cannot interrupt a 2FA form the way an early navigation once did.
  //
  // Three consecutive reads, not one: the URL passes through /feed briefly on
  // the way to a challenge, and a single sample calls that a finished login.
  console.log('Waiting for you to finish logging in (this window is watching, not touching).');
  let streak = 0;
  while (Date.now() < deadline && streak < 3) {
    await new Promise((r) => setTimeout(r, 3_000));
    streak = observeLogin(session) === 'ok' ? streak + 1 : 0;
  }
  if (streak < 3) {
    console.error('Gave up waiting. The window is still open — rerun when you are logged in.');
    process.exit(1);
  }
  // One navigation, now that it looks finished, to prove the session persisted
  // rather than living only in the tab.
  if ((await checkLogin(session)) !== 'ok') {
    console.error('The platform still says logged out. Leaving the window open — rerun when you are in.');
    process.exit(1);
  }
  const who = await whoAmI(session);
  setAccountStatus(account.id, 'ok', who ?? undefined);
  console.log(`logged in${who ? ` as ${who}` : ''}. Session saved — you can close the window.`);
  await session.close();
  process.exit(0);
}

const rl = createInterface({ input: stdin, output: stdout });
let answered = false;
const pressed = rl.question('Press enter once you are logged in (or type q to give up): ')
  .then((a) => { answered = true; return a.trim().toLowerCase(); });

// A quiet heartbeat so he can see it is alive and what it currently thinks.
let last = '';
while (!answered && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3_000));
  const now = observeLogin(session);
  if (now !== last) {
    if (now === 'checkpoint') {
      console.log('\n  two-step verification detected — take your time, nothing will interrupt you');
      rl.setPrompt('Press enter once you are logged in (or type q to give up): ');
      rl.prompt();
    }
    last = now;
  }
  state = now;
}

const reply = answered ? await pressed : 'q';
rl.close();

if (reply === 'q') {
  console.error('\nGave up. The window is still open — rerun when you are logged in.');
  process.exit(1);
}

// He says he is in. Confirm it for real with one navigation, which also proves
// the session persisted rather than living only in the tab he was looking at.
state = await checkLogin(session);

if (state !== 'ok') {
  console.error(
    state === 'checkpoint'
      ? '\nThe platform is still challenging this account. Finish the challenge, then rerun.'
      : `\nThe platform still says logged out. Leaving the window open — rerun when you are in.`,
  );
  process.exit(1);
}

const handle = await whoAmI(session);
setAccountStatus(account.id, 'ok', handle ?? undefined);
console.log(`logged in${handle ? ` as ${handle}` : ''}. Session saved — you can close the window.`);
console.log(`\ncapabilities: post=${adapter.can.post} dm=${adapter.can.dm} feed=${adapter.can.feed} engage=${adapter.can.engage.join('/') || 'none'}`);
console.log('\nnext: npm run schedule -- list');

await session.close();
process.exit(0);
