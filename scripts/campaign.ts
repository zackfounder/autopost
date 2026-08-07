import { readFileSync } from 'node:fs';
import { initSchema } from '../src/db/index.ts';
import { loadWorkflow, validateWorkflow, WorkflowSchema } from '../src/engine/workflow.ts';

/**
 *   npm run campaign -- campaigns/example.json            validate + load (paused)
 *   npm run campaign -- campaigns/example.json --check    validate only, save nothing
 */
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const checkOnly = args.includes('--check');

if (!file) {
  console.error('usage: npm run campaign -- <workflow.json> [--check]');
  process.exit(1);
}

initSchema();
const doc = WorkflowSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
const issues = validateWorkflow(doc);

for (const i of issues) {
  const tag = i.level === 'error' ? 'ERROR' : 'warn ';
  console.log(`${tag} step ${i.step ?? '-'}: ${i.message}`);
}

if (checkOnly) {
  console.log(issues.length === 0 ? 'no issues' : `${issues.length} issue(s)`);
  process.exit(issues.some((i) => i.level === 'error') ? 1 : 0);
}

const result = loadWorkflow(doc);
console.log(`\nloaded campaign #${result.campaign.id} "${result.campaign.name}" (${result.campaign.status})`);
for (const s of result.steps) console.log(`  ${s.position}. ${s.action}`);
console.log('\nAdd leads, then start it from the dashboard.');
