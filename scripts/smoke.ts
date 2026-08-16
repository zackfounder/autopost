/**
 * Full lifecycle with zero credentials, zero network, and zero browser.
 *
 * It exercises the parts that must be right before you ever point this at a real
 * account: URL normalization, workflow validation (including the funnel-logic traps),
 * the queue state machine, the rolling rate limiter, and the AI layer via its mock.
 * Browser actions are covered by a stub page — this proves the engine, not the
 * selectors. Selectors can only be proven against a live logged-in session.
 *
 *   npm run smoke
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'pilot-smoke-')), 'smoke.db');
process.env.ANTHROPIC_API_KEY = '';

const { initSchema, upsertAccount, upsertLead, enrollLead, listSteps, campaignFunnel, nextDueLead, countRecentActions, getSetting, setSetting } =
  await import('../src/db/index.ts');
const { loadWorkflow, validateWorkflow, WorkflowSchema } = await import('../src/engine/workflow.ts');
const { runStep } = await import('../src/engine/runner.ts');
const { mockAiClient } = await import('../src/ai/client.ts');
const { DEFAULT_PACING } = await import('../src/browser/human.ts');
const { normalizeProfileUrl } = await import('../src/util/url.ts');
const { checkQuota, DEFAULT_LIMITS, insideWorkingHours } = await import('../src/engine/limits.ts');

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail !== undefined && !ok ? ` -> ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

console.log('\n1. URL normalization');
check(
  'locale prefix + query + trailing slash all collapse to one key',
  normalizeProfileUrl('https://fr.linkedin.com/fr-fr/in/Jane-Doe-123/?trk=x') ===
    'https://www.linkedin.com/in/Jane-Doe-123',
  normalizeProfileUrl('https://fr.linkedin.com/fr-fr/in/Jane-Doe-123/?trk=x'),
);
check('bare host form is accepted', normalizeProfileUrl('linkedin.com/in/foo') === 'https://www.linkedin.com/in/foo');
check('company pages are rejected', normalizeProfileUrl('https://www.linkedin.com/company/acme') === null);
check('non-linkedin is rejected', normalizeProfileUrl('https://example.com/in/foo') === null);

console.log('\n2. Workflow validation catches the funnel traps');
const twoMessagesNoCheck = WorkflowSchema.parse({
  name: 'bad',
  account: 'smoke',
  steps: [
    { action: 'message', params: { body: 'one' } },
    { action: 'delay', params: { hours: 48 } },
    { action: 'message', params: { body: 'two' } },
  ],
});
const trapIssues = validateWorkflow(twoMessagesNoCheck);
check(
  'two messages separated by a plain delay is an ERROR',
  trapIssues.some((i) => i.level === 'error' && i.message.includes('check_replies')),
  trapIssues,
);

const inviteThenMessage = WorkflowSchema.parse({
  name: 'bad2',
  account: 'smoke',
  steps: [{ action: 'invite' }, { action: 'message', params: { body: 'hi' } }],
});
check(
  'invite -> message with no filter_connected is a warning',
  validateWorkflow(inviteThenMessage).some((i) => i.message.includes('filter_connected')),
);

const longNote = WorkflowSchema.parse({
  name: 'bad3',
  account: 'smoke',
  steps: [{ action: 'invite', params: { note: 'x'.repeat(301) } }],
});
check('a 301-char invite note is an ERROR', validateWorkflow(longNote).some((i) => i.level === 'error'));

console.log('\n3. Load a browser-free workflow and walk leads through it');
initSchema();
const account = upsertAccount('smoke', '/tmp/smoke-profile');

const { campaign } = loadWorkflow({
  name: 'smoke-funnel',
  account: 'smoke',
  status: 'paused',
  steps: [
    { action: 'ai_qualify', params: { icp: 'founders at seed-stage startups', minScore: 60, into: 'icp' } },
    { action: 'tag', params: { key: 'stage', value: 'qualified-{{first_name}}' } },
    { action: 'ai_message', params: { brief: 'ask for 15 minutes', into: 'note', maxChars: 280 } },
    { action: 'condition', params: { field: 'vars.note', op: 'exists', onFalse: 'exit' } },
    { action: 'end' },
  ],
});
check('workflow persisted with 5 steps', listSteps(campaign.id).length === 5);

for (let i = 1; i <= 3; i++) {
  const lead = upsertLead({
    profile_url: `https://www.linkedin.com/in/smoke-lead-${i}`,
    full_name: `Smoke Lead ${i}`,
    first_name: 'Smoke',
    headline: 'Founder',
    degree: '2nd',
  });
  enrollLead(campaign.id, lead.id);
}

const steps = listSteps(campaign.id);
const deps = {
  page: {} as never, // no browser action in this workflow touches it
  account,
  ai: mockAiClient(),
  pacing: DEFAULT_PACING,
  onLog: () => {},
};
check('this suite runs entirely on the mock, whatever keys are configured',
  mockAiClient().kind === 'mock');

for (let pass = 0; pass < 40; pass++) {
  let did = false;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    const lead = nextDueLead(campaign.id, step.position);
    if (!lead) continue;
    await runStep(deps, campaign, step, lead);
    did = true;
    break;
  }
  if (!did) break;
}

const funnel = campaignFunnel(campaign.id);
const done = funnel.filter((f) => f.state === 'done').reduce((s, f) => s + f.n, 0);
check('all 3 leads reached the end of the workflow', done === 3, funnel);

console.log('\n4. Rolling rate limiter');
setSetting('limits', { ...DEFAULT_LIMITS, invite: { perDay: 2, perHour: 2 } });
check('quota open before any invite', checkQuota(account.id, 'invite').allowed);

const { logAction } = await import('../src/db/index.ts');
logAction({ accountId: account.id, action: 'invite', status: 'ok', counted: true });
check('one counted invite recorded', countRecentActions(account.id, 'invite', 24) === 1);
check('still open at 1/2', checkQuota(account.id, 'invite').allowed);

logAction({ accountId: account.id, action: 'invite', status: 'ok', counted: true });
const blocked = checkQuota(account.id, 'invite');
check('closed at 2/2', !blocked.allowed && blocked.reason === 'invite_hourly_cap', blocked);

logAction({ accountId: account.id, action: 'invite', status: 'fail', counted: false });
check(
  'a failed attempt does not consume quota',
  countRecentActions(account.id, 'invite', 24) === 2,
);

console.log('\n5. Working hours');
const window = insideWorkingHours();
check(
  'window evaluates without throwing and reports a reason when closed',
  typeof window.open === 'boolean' && (window.open || typeof window.reason === 'string'),
  window,
);
check('settings round-trip through JSON', getSetting<{ invite: { perDay: number } }>('limits', { invite: { perDay: 0 } }).invite.perDay === 2);

/* ══════════════════════════ multi-platform ═══════════════════════════════ */

const { loadTemplates, templatesFor, pickTemplate } = await import('../src/content/templates.ts');
const { gate } = await import('../src/content/gate.ts');
const { loadInstructions, generate } = await import('../src/content/generate.ts');
const { describePlatforms, PLATFORM_IDS, getPlatform } = await import('../src/platforms/index.ts');
const { splitThread } = await import('../src/platforms/x.ts');
const { createJob, nextDueJob, finishJob, nextRunAt, createContent, recentPublishedBodies } =
  await import('../src/db/content.ts');

console.log('\n6. Platforms and template bank');
check('both platforms load', describePlatforms().length === 2, PLATFORM_IDS);
check('X caps a post at 280 chars', getPlatform('x').rules.post.maxChars === 280);
check('LinkedIn caps a post at 6 lines', getPlatform('linkedin').rules.post.maxLines === 6);
check('only linkedin and x exist', PLATFORM_IDS.join(',') === 'linkedin,x');

loadTemplates(true);
for (const p of PLATFORM_IDS) {
  check(`${p} has exactly 5 approved templates`, templatesFor(p).length === 5, templatesFor(p).length);
}

console.log('\n7. Template rotation is fair');
const usage = new Map<string, number>();
const picked: string[] = [];
for (let i = 0; i < 5; i++) {
  const t = pickTemplate('linkedin', usage);
  picked.push(t.id);
  usage.set(t.id, Date.now() + i);
}
check('five picks produce five distinct templates', new Set(picked).size === 5, picked);
const sixth = pickTemplate('linkedin', usage);
check('the sixth pick recycles the least-recently-used', sixth.id === picked[0], sixth.id);

console.log('\n8. The content gate holds');
const g = (body: string, extra: Record<string, unknown> = {}) =>
  gate({ platform: 'linkedin', kind: 'post', templateId: 'linkedin.uncomfortable-number', body, ...extra } as never);

check('a post with no template id is rejected',
  !gate({ platform: 'linkedin', kind: 'post', body: 'Shipped 3 fixes today. Betting on it.' }).pass);
check('an unapproved template id is rejected',
  !g('Shipped 3 fixes today.', { templateId: 'linkedin.made-this-up' }).pass);

// The second source of authority. Crew HQ writes a post, a chief reviews it,
// HQ's content law checks it in code, HQ's surface gate rules on it, and the
// founder's door opens for that specific deliverable — then the rail carries
// it. Requiring a template match on top of that chain would not add safety; it
// would mean no HQ post could ever be published, which is exactly what happened
// on the first four.
// The breach of 2026-08-14, as a check that cannot pass again.
{
  const li = getPlatform('linkedin');
  const refused = await li.post!(
    { goto: async () => {}, } as never,
    'Account: company copy',
    { postAs: 'crew co-founder' } as never,
  ).catch(() => ({ ok: false, error: 'threw' }));
  check('a page post with no page composer is refused, never sent to the feed',
    refused.ok === false && /personal profile|composer URL/i.test(refused.error ?? ''));
}

check('a founder-approved post needs no template id',
  gate({ platform: 'x', kind: 'post', provenance: 'founder_approved',
         body: 'Crew locks one priority a day. Nothing else counts.' }).pass);
check('founder-approved does NOT disable the other rules',
  !gate({ platform: 'x', kind: 'post', provenance: 'founder_approved',
          body: 'We need to leverage this synergy — betting on it.' }).pass);
check('founder-approved does not lift the length cap',
  !gate({ platform: 'x', kind: 'post', provenance: 'founder_approved',
          body: 'x'.repeat(300) }).pass);
check('an agent still cannot post without a template',
  !gate({ platform: 'x', kind: 'post', body: 'Crew locks one priority a day.' }).pass);
check('a banned word is rejected',
  !g('Did the math: 12 users. We need to leverage this. Betting on it.').pass);
check('an em-dash is rejected',
  !g('Did the math — 12 users. Betting on it.').pass);
check('emoji are rejected', !g('Did the math: 12 users 🚀. Betting on it.').pass);
check('engagement bait is rejected',
  !g('Did the math: 12 users. Betting on it. Thoughts?').pass);
check('an unfilled placeholder is rejected',
  !g('Did the math: {{the_number}} users. Betting on it.').pass);
check('a raw KPI column name is rejected',
  !g('Did the math: mrr_usd is 40. Betting on it.').pass);
check('outreach mechanics are rejected',
  !g('Did the math on my DM script: 12 replies from 200 cold DMs. Betting on it.').pass);
check('a template requiring a number rejects a draft with no digits',
  !g('Did the math on my runway. It is humbling. Betting on it.').pass);
check('over the 6-line cap is rejected',
  !g('a 1\nb\nc\nd\ne\nf\ng').pass);

const goodLinkedIn =
  'Did the math on my runway this morning: 14-day trial, $19 a month, 2 committed testers.\n' +
  'That is 500 users to match one hour of somebody else\'s revenue.\n' +
  'Writing it out is humbling.\n' +
  'I am not competing with them and I cannot.\n' +
  'Betting the next month on staying small and specific instead.';
const goodResult = g(goodLinkedIn);
check('a clean, on-brand post passes', goodResult.pass, goodResult.violations);

check('a near-duplicate of a published post is rejected',
  !g(goodLinkedIn, { recentBodies: [goodLinkedIn] }).pass);

console.log('\n9. X thread handling');
check('a 300-char single tweet is rejected',
  !gate({ platform: 'x', kind: 'post', templateId: 'x.one-number', body: 'x'.repeat(300) }).pass);
const thread = '1/ Shipped 3 fixes today.\n2/ The second one took 4 hours.\n3/ Worth it.';
check('splitThread finds 3 tweets', splitThread(thread).length === 3, splitThread(thread));
check('a valid thread passes the per-tweet cap',
  gate({ platform: 'x', kind: 'post', templateId: 'x.breakdown-thread', body: thread }).pass);
check('one over-long tweet inside a thread is rejected',
  !gate({ platform: 'x', kind: 'post', templateId: 'x.breakdown-thread', body: `1/ ok\n2/ ${'y'.repeat(300)}` }).pass);

console.log('\n10. Instructions load for every platform');
for (const p of PLATFORM_IDS) {
  const text = loadInstructions(p);
  check(`${p} instructions include the global brief`, text.includes('Operating brief'), text.length);
}

console.log('\n11. Generation fails CLOSED when the gate never passes');
const blockedDraft = await generate({
  ai: mockAiClient(),           // forced: this suite never touches the network
  platform: 'linkedin',
  kind: 'post',
  brief: 'anything',
  templateId: 'linkedin.uncomfortable-number',
  maxAttempts: 2,
});
check('a draft that cannot pass returns ok:false and is not publishable',
  blockedDraft.ok === false && blockedDraft.violations.length > 0, blockedDraft.violations);

console.log('\n12. Job queue');
const jobA = createJob({ accountId: account.id, kind: 'engage_feed', recurrence: '6h' });
const due = nextDueJob(account.id);
check('a job created now is immediately due', due?.id === jobA.id);
finishJob(jobA, 'done');
check('a recurring job re-arms into the future', (nextDueJob(account.id)?.id ?? null) === null);
const next = nextRunAt('6h');
check('nextRunAt returns a future timestamp', Date.parse(`${next.replace(' ', 'T')}Z`) > Date.now());
let recurrenceRejected = false;
try { nextRunAt('every tuesday'); } catch { recurrenceRejected = true; }
check('a malformed recurrence is rejected', recurrenceRejected);

console.log('\n13. Content rows');
createContent({
  accountId: account.id, platform: 'linkedin', kind: 'post',
  templateId: 'linkedin.uncomfortable-number', body: goodLinkedIn, state: 'published',
});
check('published bodies feed the repetition check',
  recentPublishedBodies(account.id).includes(goodLinkedIn));

console.log('\n14. LinkedIn targeted actions');
const { runJob, JOB_KINDS } = await import('../src/engine/jobs.ts');
const { targetedActions } = await import('../src/platforms/index.ts');
const { ageInDays } = await import('../src/platforms/linkedin.ts');
const { loadLimitsFor, repairSeededLimits, DEFAULT_LIMITS: DEF } = await import('../src/engine/limits.ts');

const liActions = targetedActions(getPlatform('linkedin'));
for (const m of ['reactToPost', 'commentOnPost', 'repost', 'follow', 'visitProfile',
                 'listInvitations', 'withdrawStaleInvitations', 'readPostComments', 'replyToComment']) {
  check(`linkedin implements ${m}`, liActions.includes(m));
}
check('x does not claim LinkedIn-only actions', !targetedActions(getPlatform('x')).includes('listInvitations'));

// Every kind the CLI and MCP offer must actually be handled. An unhandled kind
// schedules fine and then fails at 09:15 tomorrow with "unknown job kind".
const jobDeps = {
  page: {} as never,
  account,
  ai: mockAiClient(),
  pacing: DEFAULT_PACING,
  log: () => {},
};
const unhandled: string[] = [];
for (const kind of JOB_KINDS) {
  const out = await runJob(jobDeps, { kind, payload: '{}' } as never).catch((e: Error) => ({
    ok: false, detail: {}, error: e.message,
  }));
  if ((out.error ?? '').includes('unknown job kind')) unhandled.push(kind);
}
check('every scheduleable job kind is handled by runJob', unhandled.length === 0, unhandled);

// Withdrawal reads the card's own wording. Anything it cannot parse must read as
// brand new, or a fresh invite gets withdrawn and the weekly quota is wasted.
check('"Sent 3 weeks ago" is 21 days', ageInDays('Sent 3 weeks ago') === 21);
check('"Sent 2 months ago" is 60 days', ageInDays('Sent 2 months ago') === 60);
check('"Sent 5 hours ago" is 0 days', ageInDays('Sent 5 hours ago') === 0);
check('unparseable card text is treated as brand new', ageInDays('Pending') === 0);

console.log('\n15. Platform caps outrank the seeded defaults');
setSetting('limits', DEF);
check('a seeded limits row is recognised and cleared', repairSeededLimits() === true);
setSetting('limits', { invite: { perDay: 3 } });
check('an edited limits row is left alone', repairSeededLimits() === false);
setSetting('limits', {});
const liLimits = loadLimitsFor('linkedin');
check('LinkedIn keeps its own visit cap, not the generic one',
  liLimits.visit_profile?.perDay === 40, liLimits.visit_profile);
check('the new targeted caps are in force', liLimits.react_post?.perDay === 20 && liLimits.repost?.perDay === 3);

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — db at ${process.env.DB_PATH}`);
process.exit(failures === 0 ? 0 : 1);
