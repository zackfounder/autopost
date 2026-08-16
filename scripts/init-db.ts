import { initSchema, getSetting, setSetting } from '../src/db/index.ts';
import { DEFAULT_LIMITS, DEFAULT_WORKING_HOURS, repairSeededLimits } from '../src/engine/limits.ts';
import { DEFAULT_PACING } from '../src/browser/human.ts';
import { env } from '../src/config/env.ts';

initSchema();

if (getSetting<unknown>('workingHours', null) === null) {
  setSetting('workingHours', DEFAULT_WORKING_HOURS);
}
if (getSetting<unknown>('pacing', null) === null) setSetting('pacing', DEFAULT_PACING);
if (getSetting<unknown>('paused', null) === null) setSetting('paused', false);

if (repairSeededLimits()) console.log('cleared a seeded limits row that was overriding the platform caps');
console.log(`database ready at ${env.dbPath}`);
console.log('warm-up limits in force:', JSON.stringify(DEFAULT_LIMITS));
console.log('\nnext: npm run login -- <account-name>');
