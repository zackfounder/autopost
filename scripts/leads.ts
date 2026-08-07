import { initSchema, getAccountByName, listCampaigns } from '../src/db/index.ts';
import { importCsv } from '../src/sources/csv.ts';
import { harvestSearch } from '../src/sources/search.ts';
import { openSession } from '../src/browser/session.ts';

/**
 *   npm run leads -- csv <file.csv> [--campaign <id>]
 *   npm run leads -- harvest <account> "<linkedin search url>" [--campaign <id>] [--pages 5] [--max 100]
 */
const args = process.argv.slice(2);
const mode = args[0];

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const campaignId = flag('campaign') ? Number(flag('campaign')) : undefined;

initSchema();

if (mode === 'csv') {
  const file = args[1];
  if (!file) {
    console.error('usage: npm run leads -- csv <file.csv> [--campaign <id>]');
    process.exit(1);
  }
  console.log(importCsv(file, { campaignId, source: 'csv' }));
  process.exit(0);
}

if (mode === 'harvest') {
  const accountName = args[1];
  const url = args[2];
  if (!accountName || !url) {
    console.error('usage: npm run leads -- harvest <account> "<search url>" [--campaign <id>]');
    process.exit(1);
  }
  const account = getAccountByName(accountName);
  if (!account) {
    console.error(`no account "${accountName}". Run: npm run login -- ${accountName}`);
    process.exit(1);
  }
  const session = await openSession(account, { headless: false });
  const result = await harvestSearch(session.page, {
    url,
    campaignId,
    maxPages: flag('pages') ? Number(flag('pages')) : 5,
    maxLeads: flag('max') ? Number(flag('max')) : 100,
    source: 'search',
    onLog: (l) => console.log(l),
  });
  console.log(result);
  await session.close();
  process.exit(0);
}

console.error('usage:');
console.error('  npm run leads -- csv <file.csv> [--campaign <id>]');
console.error('  npm run leads -- harvest <account> "<search url>" [--campaign <id>]');
console.error('\ncampaigns:', listCampaigns().map((c) => `${c.id}=${c.name}`).join(', ') || '(none)');
process.exit(1);
