import { initSchema, listAccounts } from '../src/db/index.ts';
import { getPlatform, PLATFORM_IDS } from '../src/platforms/index.ts';
import { quotaSnapshot } from '../src/engine/limits.ts';

/**
 *   npm run accounts          what is connected, what it can do, today's budget
 *
 * Read-only. Touches nothing.
 */
initSchema();

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
