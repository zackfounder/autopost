import { initSchema, listAccounts, getAccountByName, deleteAccount } from '../src/db/index.ts';
import { getPlatform, PLATFORM_IDS, isPlatformId } from '../src/platforms/index.ts';
import { quotaSnapshot } from '../src/engine/limits.ts';

/**
 *   npm run accounts                what is connected, what it can do, today's budget
 *   npm run accounts -- forget <n>  remove an account from the engine
 *
 * The listing is read-only. `forget` deletes the row and its scheduled jobs, and
 * deliberately leaves the browser profile directory alone — that directory is the
 * logged-in session, and throwing it away is a separate decision.
 */
initSchema();

const [cmd, target] = process.argv.slice(2);

if (cmd === 'forget') {
  if (!target) {
    console.error('usage: npm run accounts -- forget <account-name>');
    process.exit(1);
  }
  const account = getAccountByName(target);
  if (!account) {
    console.error(`no account "${target}"`);
    process.exit(1);
  }
  deleteAccount(account.id);
  console.log(`forgot "${target}" (${account.platform}) and any jobs it had.`);
  console.log(`Its session is still on disk at ${account.profile_dir} — delete that yourself if you want it gone.`);
  process.exit(0);
}

const accounts = listAccounts();

if (accounts.length === 0) {
  console.log('No accounts connected yet.\n');
  console.log('Connect one per platform (each opens a browser; you log in yourself):');
  for (const id of PLATFORM_IDS) {
    console.log(`  npm run login -- main-${id} --platform ${id}`);
  }
  process.exit(0);
}

for (const a of accounts) {
  // An account can outlive its platform: dropping Quora and Indie Hackers left
  // rows behind pointing at adapters that no longer exist. Say so and move on
  // rather than throwing, which took the whole read-only listing down with it.
  if (!isPlatformId(a.platform)) {
    console.log(`\n${a.name}  [${a.platform}]  RETIRED — this platform is no longer supported`);
    console.log(`  remove it with: npm run accounts -- forget ${a.name}`);
    continue;
  }
  const p = getPlatform(a.platform);
  const flag =
    a.status === 'ok' ? 'connected'
    : a.status === 'checkpoint' ? 'CHALLENGED — clear it in the browser'
    : a.status === 'logged_out' ? `LOGGED OUT — npm run login -- ${a.name} --platform ${a.platform}`
    : 'never checked';

  console.log(`\n${a.name}  [${p.displayName}]  ${flag}`);
  console.log(
    `  can: post=${p.can.post} dm=${p.can.dm} feed=${p.can.feed} engage=${p.can.engage.join('/') || 'none'}`,
  );
  console.log(`  profile dir: ${a.profile_dir}`);

  const used = quotaSnapshot(a.id, a.platform).filter(
    (q) => !q.action.startsWith('_') && (q.usedToday > 0 || q.perDay !== null),
  );
  const line = used
    .map((q) => `${q.action} ${q.usedToday}/${q.perDay ?? '∞'}`)
    .join('   ');
  if (line) console.log(`  today: ${line}`);
}

console.log('');
