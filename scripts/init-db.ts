import { initSchema, getSetting, setSetting } from '../src/db/index.ts';
import { DEFAULT_LIMITS, DEFAULT_WORKING_HOURS } from '../src/engine/limits.ts';
import { DEFAULT_PACING } from '../src/browser/human.ts';
import { env } from '../src/config/env.ts';

initSchema();

if (getSetting<unknown>('limits', null) === null) setSetting('limits', DEFAULT_LIMITS);
if (getSetting<unknown>('workingHours', null) === null) {
  setSetting('workingHours', DEFAULT_WORKING_HOURS);
}
if (getSetting<unknown>('pacing', null) === null) setSetting('pacing', DEFAULT_PACING);
if (getSetting<unknown>('paused', null) === null) setSetting('paused', false);

console.log(`database ready at ${env.dbPath}`);
console.log('seeded warm-up limits:', JSON.stringify(DEFAULT_LIMITS));
console.log('\nnext: npm run login -- <account-name>');
