import { initSchema, getAccountByName, listAccounts } from '../src/db/index.ts';
import { createJob, listJobs, deleteJob, setJobState } from '../src/db/content.ts';
import { getPlatform } from '../src/platforms/index.ts';

/**
 * Manage the job queue: what each account does, and how often.
 *
 *   npm run schedule -- list
 *   npm run schedule -- add main-x engage_feed --every 6h --max 3
 *   npm run schedule -- add main-li generate_post --every 1d --brief "..." --facts "..."
 *   npm run schedule -- add main-li publish_due --every 2h
 *   npm run schedule -- pause 3
 *   npm run schedule -- resume 3
 *   npm run schedule -- rm 3
 *
 * Nothing here contacts a platform. It only writes rows the engine reads later.
 */
const args = process.argv.slice(2);
const cmd = args[0];

function flag(n: string): string | undefined {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
}

initSchema();

if (cmd === 'list' || !cmd) {
  const jobs = listJobs();
  if (jobs.length === 0) {
    console.log('no jobs scheduled.\n');
    console.log('accounts:', listAccounts().map((a) => `${a.name} (${a.platform})`).join(', ') || '(none)');
    console.log('\nadd one:  npm run schedule -- add <account> <kind> --every 6h');
    process.exit(0);
  }
  for (const j of jobs) {
    const rec = j.recurrence ? `every ${j.recurrence}` : 'one-shot';
    console.log(
      `#${j.id}  ${j.account_name} (${j.platform})  ${j.kind}  ${rec}  next=${j.run_at}  [${j.state}]` +
        (j.last_error ? `\n      last error: ${j.last_error}` : ''),
    );
  }
  process.exit(0);
}

if (cmd === 'add') {
  const accountName = args[1];
  const kind = args[2];
  const valid = ['generate_post', 'publish_due', 'engage_feed', 'send_dm'];
  if (!accountName || !kind || !valid.includes(kind)) {
    console.error(`usage: npm run schedule -- add <account> <${valid.join('|')}> [--every 6h] [...]`);
    process.exit(1);
  }
  const account = getAccountByName(accountName);
  if (!account) {
    console.error(`no account "${accountName}". Accounts: ${listAccounts().map((a) => a.name).join(', ') || '(none)'}`);
    process.exit(1);
  }
  const adapter = getPlatform(account.platform);

  if (kind === 'engage_feed' && !adapter.can.feed) {
    console.error(`${adapter.displayName} has no feed capability.`);
    process.exit(1);
  }
  if (kind === 'send_dm' && !adapter.can.dm) {
    console.error(`${adapter.displayName} has no DM capability.`);
    process.exit(1);
  }

  const payload: Record<string, unknown> = {};
  for (const key of ['brief', 'facts', 'templateId', 'targetRef', 'criteria', 'target', 'body']) {
    const v = flag(key);
    if (v) payload[key] = v;
  }
  if (flag('max')) payload.maxActions = Number(flag('max'));
  if (flag('scan')) payload.scan = Number(flag('scan'));
  if (flag('actions')) payload.actions = flag('actions')!.split(',');

  const job = createJob({
    accountId: account.id,
    kind,
    payload,
    recurrence: flag('every') ?? null,
    runAt: flag('at'),
  });

  console.log(`job #${job.id}: ${kind} on ${account.name} (${account.platform})`);
  console.log(`  next run: ${job.run_at}${job.recurrence ? `, then every ${job.recurrence}` : ' (one-shot)'}`);
  console.log(`  payload: ${JSON.stringify(payload)}`);
  console.log('\nThe engine picks this up when it is running and inside working hours.');
  process.exit(0);
}

if (cmd === 'pause' || cmd === 'resume') {
  const id = Number(args[1]);
  if (!id) {
    console.error(`usage: npm run schedule -- ${cmd} <job-id>`);
    process.exit(1);
  }
  setJobState(id, cmd === 'pause' ? 'disabled' : 'ready');
  console.log(`job #${id} ${cmd === 'pause' ? 'disabled' : 'ready'}`);
  process.exit(0);
}

if (cmd === 'rm') {
  const id = Number(args[1]);
  if (!id) {
    console.error('usage: npm run schedule -- rm <job-id>');
    process.exit(1);
  }
  deleteJob(id);
  console.log(`job #${id} deleted`);
  process.exit(0);
}

console.error('commands: list | add | pause | resume | rm');
process.exit(1);
