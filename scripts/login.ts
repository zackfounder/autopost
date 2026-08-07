import { initSchema, upsertAccount, setAccountStatus } from '../src/db/index.ts';
import { openSession, profileDirFor, checkLogin, whoAmI } from '../src/browser/session.ts';
import { getPlatform, PLATFORM_IDS, isPlatformId } from '../src/platforms/index.ts';

/**
 * One-time, interactive, and deliberately manual: this opens a real browser window
 * and YOU log in. The script never sees or asks for a password, never types
 * credentials, and never touches a 2FA code. It waits until the platform says
 * you're in, then leaves the session in that account's profile directory.
 *
 *   npm run login -- main-linkedin --platform linkedin
 *   npm run login -- main-x        --platform x
 *   npm run login -- main-quora    --platform quora
 *   npm run login -- main-ih       --platform indiehackers
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

if (!name || !isPlatformId(platform)) {
  console.error('usage: npm run login -- <account-name> --platform <platform> [--proxy <url>]');
  console.error(`platforms: ${PLATFORM_IDS.join(' | ')}`);
  process.exit(1);
}

const adapter = getPlatform(platform);

initSchema();
const account = upsertAccount(name, profileDirFor(name), proxy, platform);
console.log(`account "${name}"  platform=${adapter.displayName}`);
console.log(`profile dir: ${account.profile_dir}`);
if (proxy) console.log(`proxy: ${proxy.replace(/:[^:@]+@/, ':***@')}`);

const session = await openSession(account, { headless: false });
await session.page.goto(adapter.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

console.log(`\nA browser window is open at ${adapter.displayName}.`);
console.log('Log in there yourself, including any 2FA. This script will wait.');
console.log('Nothing is typed for you and no credentials are read.\n');

const deadline = Date.now() + 10 * 60_000;
let state = await checkLogin(session);
while (state !== 'ok' && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5_000));
  state = await checkLogin(session);
  process.stdout.write('.');
}
console.log('');

if (state !== 'ok') {
  console.error(`\nStill "${state}" after 10 minutes. Leaving the window open — rerun when logged in.`);
  process.exit(1);
}

const handle = await whoAmI(session);
setAccountStatus(account.id, 'ok', handle ?? undefined);
console.log(`logged in${handle ? ` as ${handle}` : ''}. Session saved — you can close the window.`);
console.log(`\ncapabilities: post=${adapter.can.post} dm=${adapter.can.dm} feed=${adapter.can.feed} engage=${adapter.can.engage.join('/') || 'none'}`);
console.log('\nnext: npm run schedule -- list');

await session.close();
process.exit(0);
