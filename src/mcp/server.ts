import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { initSchema } from '../db/index.ts';
import { describeActions } from '../actions/index.ts';
import { loadWorkflow, validateWorkflow, WorkflowSchema } from '../engine/workflow.ts';
import { engine } from '../engine/scheduler.ts';
import { JOB_KINDS } from '../engine/jobs.ts';
import { openSession } from '../browser/session.ts';
import { describePlatforms, getPlatform } from '../platforms/index.ts';
import { loadTemplates } from '../content/templates.ts';
import { gate } from '../content/gate.ts';
import { generate, loadInstructions } from '../content/generate.ts';
import { buildAiClient } from '../ai/client.ts';
import {
  createContent, getContent, listContent, setContentState, recentPublishedBodies,
  templateUsage, recordTemplateUse, listJobs, createJob, setJobState, deleteJob,
  recentFeedActions, scheduleContent,
} from '../db/content.ts';
import { harvestSearch } from '../sources/search.ts';
import { normalizeProfileUrl, publicIdOf } from '../util/url.ts';
import {
  campaignFunnel,
  enrollLead,
  getAccountByName,
  getCampaign,
  listAccounts,
  listCampaigns,
  listSteps,
  recentLog,
  setCampaignStatus,
  suppress,
  upsertLead,
} from '../db/index.ts';
import {
  loadLimits,
  loadPacing,
  loadWorkingHours,
  quotaSnapshot,
  saveLimits,
  saveWorkingHours,
  setGloballyPaused,
} from '../engine/limits.ts';

/**
 * The agent-facing control surface. Register this with Claude Code and the model can
 * author workflows, load leads, watch the funnel, and adjust caps — but it cannot
 * bypass the caps, and it cannot make the engine act outside working hours. The
 * safety rails live in the engine, not in the tool descriptions.
 */

initSchema();

const server = new McpServer({ name: 'autopost', version: '0.1.0' });

const text = (v: unknown) => ({
  content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
});

server.tool(
  'list_actions',
  'The catalogue of workflow actions, with what each does, which connection degrees ' +
    'it can process, whether it consumes a rate-limit slot, and its parameters. Read ' +
    'this before authoring a workflow.',
  {},
  async () => text(describeActions()),
);

server.tool(
  'validate_workflow',
  'Dry-run a campaign JSON document. Returns structural errors plus funnel-logic ' +
    'warnings (missing filter_connected before a message, two messages with no ' +
    'check_replies between them, an ai_message draft nothing consumes). Nothing is saved.',
  { workflow: z.record(z.unknown()) },
  async ({ workflow }) => {
    const doc = WorkflowSchema.parse(workflow);
    return text({ issues: validateWorkflow(doc) });
  },
);

server.tool(
  'load_workflow',
  'Validate and save a campaign. Replaces the campaign\'s steps entirely. Loads as ' +
    '"paused" unless status says otherwise — review the funnel before starting it.',
  { workflow: z.record(z.unknown()) },
  async ({ workflow }) => text(loadWorkflow(workflow)),
);

server.tool(
  'list_campaigns',
  'Every campaign with its workflow and a per-step breakdown of where leads are queued.',
  {},
  async () =>
    text(
      listCampaigns().map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        steps: listSteps(c.id).map((s) => `${s.position}. ${s.action}`),
        funnel: campaignFunnel(c.id),
      })),
    ),
);

server.tool(
  'set_campaign_status',
  'Start or pause one campaign. "running" makes it eligible for the scheduler; it still ' +
    'obeys working hours and rate limits.',
  {
    campaignId: z.number(),
    status: z.enum(['running', 'paused', 'draft', 'done']),
  },
  async ({ campaignId, status }) => {
    if (!getCampaign(campaignId)) throw new Error(`no campaign ${campaignId}`);
    setCampaignStatus(campaignId, status);
    return text({ campaignId, status });
  },
);

server.tool(
  'add_leads',
  'Add LinkedIn profile URLs and optionally enroll them in a campaign. URLs are ' +
    'normalized and deduped; anything on the suppression list is silently refused.',
  {
    urls: z.array(z.string()),
    campaignId: z.number().optional(),
    source: z.string().optional(),
  },
  async ({ urls, campaignId, source }) => {
    let added = 0;
    let enrolled = 0;
    const rejected: string[] = [];
    for (const raw of urls) {
      const url = normalizeProfileUrl(raw);
      if (!url) {
        rejected.push(raw);
        continue;
      }
      const lead = upsertLead({
        profile_url: url,
        public_id: publicIdOf(url) ?? undefined,
        source: source ?? 'agent',
      });
      added++;
      if (campaignId && enrollLead(campaignId, lead.id)) enrolled++;
    }
    return text({ added, enrolled, rejected });
  },
);

server.tool(
  'harvest_search',
  'Open a LinkedIn results URL in the account\'s browser and collect profile links into ' +
    'a campaign. Works with regular search, Sales Navigator, group members, event ' +
    'attendees, alumni pages, and your connections list. Paced deliberately — expect ' +
    'this to take a minute or two per page.',
  {
    account: z.string(),
    url: z.string(),
    campaignId: z.number().optional(),
    maxPages: z.number().optional(),
    maxLeads: z.number().optional(),
  },
  async ({ account, url, campaignId, maxPages, maxLeads }) => {
    const acc = getAccountByName(account);
    if (!acc) throw new Error(`no account named "${account}"`);
    const session = await openSession(acc);
    const result = await harvestSearch(session.page, {
      url,
      campaignId,
      maxPages,
      maxLeads,
      source: 'search',
      onLog: (l) => engine.log(l),
    });
    return text(result);
  },
);

server.tool(
  'engine_control',
  'Start or stop the scheduler, or set the global pause. Pause is a hard kill switch: ' +
    'while paused the scheduler performs no action at all.',
  { command: z.enum(['start', 'stop', 'pause', 'resume', 'status']) },
  async ({ command }) => {
    if (command === 'start') engine.start();
    if (command === 'stop') await engine.stop();
    if (command === 'pause') setGloballyPaused(true);
    if (command === 'resume') setGloballyPaused(false);
    return text(engine.status());
  },
);

server.tool(
  'get_limits',
  'Current rate limits, working hours, pacing, and how much of today\'s budget is spent.',
  { account: z.string().optional() },
  async ({ account }) => {
    const acc = account ? getAccountByName(account) : listAccounts()[0];
    return text({
      limits: loadLimits(),
      workingHours: loadWorkingHours(),
      pacing: loadPacing(),
      usage: acc ? quotaSnapshot(acc.id) : [],
    });
  },
);

server.tool(
  'set_limits',
  'Adjust per-action daily/hourly caps or the working-hours window. Windows are rolling ' +
    '24h/1h, not calendar days. Raising caps raises ban risk — the defaults are a ' +
    'warm-up profile, and going above ~100 total actions/day is against the grain of ' +
    'what LinkedIn tolerates.',
  {
    limits: z
      .record(z.object({ perDay: z.number().optional(), perHour: z.number().optional() }))
      .optional(),
    workingHours: z
      .object({
        start: z.string(),
        end: z.string(),
        days: z.array(z.number()),
        startJitterMinutes: z.number(),
      })
      .optional(),
  },
  async ({ limits, workingHours }) => {
    if (limits) saveLimits(limits);
    if (workingHours) saveWorkingHours(workingHours);
    return text({ limits: loadLimits(), workingHours: loadWorkingHours() });
  },
);

server.tool(
  'get_activity',
  'Recent actions the engine performed, newest first, with status and detail. This is ' +
    'the audit trail — read it before concluding anything about what happened.',
  { limit: z.number().optional() },
  async ({ limit }) => text(recentLog(limit ?? 50)),
);

server.tool(
  'suppress_lead',
  'Permanently exclude a profile from every campaign, forever. Use for opt-outs. Cannot ' +
    'be undone through this API.',
  { url: z.string(), reason: z.string() },
  async ({ url, reason }) => {
    const norm = normalizeProfileUrl(url);
    if (!norm) throw new Error('not a LinkedIn profile URL');
    suppress(norm, reason);
    return text({ url: norm, suppressed: true });
  },
);

/* ══════════════════════════ multi-platform: content & engagement ══════════ */

server.tool(
  'list_platforms',
  'The four connected platforms and what each can actually do (post / dm / feed / ' +
    'engage), their content rules (character caps, links, threads), and their default ' +
    'rate limits. Read this before scheduling anything.',
  {},
  async () => text(describePlatforms()),
);

server.tool(
  'list_templates',
  'The approved template bank. THIS IS THE BOUNDARY ON WHAT YOU MAY PUBLISH: five ' +
    'shapes per platform, and a post whose template id is not in this list is rejected ' +
    'by code before it can reach an account. You choose which shape fits and write the ' +
    'words inside it; you cannot invent a sixth shape.',
  { platform: z.enum(['linkedin', 'x']).optional() },
  async ({ platform }) => {
    const all = [...loadTemplates(true).values()];
    return text(platform ? all.filter((t) => t.platform === platform) : all);
  },
);

server.tool(
  'read_instructions',
  'The operating brief you are working under for a platform: voice, hard rules, what ' +
    'is never allowed, and the engagement bar. instructions/GLOBAL.md plus the platform ' +
    'file. Read this before writing anything for that account.',
  { platform: z.enum(['linkedin', 'x']) },
  async ({ platform }) => text(loadInstructions(platform)),
);

server.tool(
  'check_content',
  'Run a body through the content gate WITHOUT saving or publishing it. Returns every ' +
    'violation. Use this to iterate on wording before committing. The same checks run ' +
    'again at publish time, so passing here is necessary but the check is never skipped later.',
  {
    platform: z.enum(['linkedin', 'x']),
    kind: z.enum(['post', 'dm', 'comment', 'reply']).default('post'),
    body: z.string(),
    templateId: z.string().optional(),
  },
  async ({ platform, kind, body, templateId }) =>
    text(gate({ platform, kind, body, templateId: templateId ?? null })),
);

server.tool(
  'draft_content',
  'Write a draft for an account: picks a template by rotation (or uses the one you name), ' +
    'generates, and runs the gate, repairing up to 3 times. Saves the result as `drafted` ' +
    'or `blocked`. Does NOT publish. Pass everything factual in `facts` — anything not in ' +
    'there must not appear in the copy.',
  {
    account: z.string(),
    platform: z.enum(['linkedin', 'x']),
    kind: z.enum(['post', 'dm', 'comment', 'reply']).default('post'),
    brief: z.string().describe('what this piece needs to accomplish, in your own words'),
    facts: z.string().optional().describe('the ONLY verified facts the copy may use'),
    templateId: z.string().optional(),
    targetRef: z.string().optional().describe('the post/profile URL this content is aimed at, or a DM target'),
  },
  async ({ account, platform, kind, brief, facts, templateId, targetRef }) => {
    const acc = getAccountByName(account);
    if (!acc) throw new Error(`no account "${account}"`);

    const result = await generate({
      ai: buildAiClient(),
      platform,
      kind,
      brief,
      facts,
      templateId,
      usage: templateUsage(acc.id),
      recentBodies: recentPublishedBodies(acc.id),
      onLog: (l) => engine.log(l),
    });

    const row = createContent({
      accountId: acc.id,
      platform,
      kind,
      templateId: result.templateId,
      targetRef: targetRef ?? null,
      body: result.body,
      state: result.ok ? 'drafted' : 'blocked',
      violations: result.violations,
      meta: { brief },
    });
    if (result.templateId) recordTemplateUse(acc.id, result.templateId);

    return text({
      contentId: row.id,
      state: row.state,
      templateId: result.templateId,
      attempts: result.attempts,
      violations: result.violations,
      body: result.body,
    });
  },
);

server.tool(
  'queue_content',
  'Move a draft into the publish queue. The gate runs again here, and again immediately ' +
    'before the browser publishes it — a body edited after drafting cannot slip through. ' +
    'Use state "skipped" to discard a draft instead.',
  {
    contentId: z.number(),
    state: z.enum(['queued', 'skipped', 'blocked']).default('queued'),
    scheduledAt: z.string().optional().describe('"YYYY-MM-DD HH:MM:SS" local; omit for as-soon-as-due'),
  },
  async ({ contentId, state, scheduledAt }) => {
    const item = getContent(contentId);
    if (!item) throw new Error(`no content #${contentId}`);

    if (state === 'queued') {
      const check = gate({
        platform: item.platform as never,
        kind: item.kind as 'post' | 'dm' | 'comment' | 'reply',
        body: item.body,
        templateId: item.template_id,
      });
      if (!check.pass) {
        setContentState(contentId, 'blocked', { violations: check.violations });
        throw new Error(`cannot queue: ${check.violations.join(' | ')}`);
      }
    }
    setContentState(contentId, state);
    if (scheduledAt) scheduleContent(contentId, scheduledAt);
    return text(getContent(contentId));
  },
);

server.tool(
  'list_content',
  'Everything drafted, queued, published, blocked or failed across all accounts, newest ' +
    'first. This is the complete public record of what has been said on your behalf, plus ' +
    'every draft that was stopped and why.',
  { limit: z.number().optional() },
  async ({ limit }) => text(listContent(limit ?? 40)),
);

server.tool(
  'schedule_job',
  'Schedule recurring work for an account.\n' +
    'Content: "generate_post" (writes a draft and queues it), "publish_due" (publishes one ' +
    'queued item per run).\n' +
    'Feed: "engage_feed" (reads the feed, decides, likes/comments), "send_dm".\n' +
    'Targeted (LinkedIn, on a URL you name): "engage_post" {url, reaction?, comment?|brief?, ' +
    'repost?} — react, comment and/or share one specific post; "reply_comments" {postUrl?, max} ' +
    '— answer the comments on your own posts, defaulting to your most recent ones; ' +
    '"grow_network" {maxAccept, criteria?, withdrawAfterDays?} — accept the invitations worth ' +
    'accepting and withdraw stale ones you sent; "visit_profiles" {urls} — profile visits, ' +
    'which the other person is notified of; "follow_targets" {urls}.\n' +
    'Recurrence is "90m", "6h", "1d" — it re-arms with up to 20% jitter so it never fires at ' +
    'the same minute daily. Everything still obeys working hours and rate limits, and every ' +
    'word these produce goes through the content gate.',
  {
    account: z.string(),
    kind: z.enum(JOB_KINDS),
    recurrence: z.string().optional().describe('"90m" | "6h" | "1d"; omit for one-shot'),
    payload: z.record(z.unknown()).optional(),
    runAt: z.string().optional(),
  },
  async ({ account, kind, recurrence, payload, runAt }) => {
    const acc = getAccountByName(account);
    if (!acc) throw new Error(`no account "${account}"`);
    const adapter = getPlatform(acc.platform);
    if (kind === 'engage_feed' && !adapter.can.feed) {
      throw new Error(`${adapter.displayName} has no feed capability`);
    }
    if (kind === 'send_dm' && !adapter.can.dm) {
      throw new Error(`${adapter.displayName} has no DM capability`);
    }
    const NEEDS: Record<string, keyof typeof adapter> = {
      engage_post: 'commentOnPost',
      grow_network: 'listInvitations',
      visit_profiles: 'visitProfile',
      follow_targets: 'follow',
      reply_comments: 'readPostComments',
    };
    const needed = NEEDS[kind];
    if (needed && typeof adapter[needed] !== 'function') {
      throw new Error(`${adapter.displayName} does not support "${kind}"`);
    }
    return text(
      createJob({ accountId: acc.id, kind, payload: payload ?? {}, recurrence: recurrence ?? null, runAt }),
    );
  },
);

server.tool(
  'list_jobs',
  'Every scheduled job with its next run time, recurrence, state and last error.',
  {},
  async () => text(listJobs()),
);

server.tool(
  'control_job',
  'Pause, resume, or delete a scheduled job.',
  { jobId: z.number(), command: z.enum(['pause', 'resume', 'delete']) },
  async ({ jobId, command }) => {
    if (command === 'delete') {
      deleteJob(jobId);
      return text({ jobId, deleted: true });
    }
    setJobState(jobId, command === 'pause' ? 'disabled' : 'ready');
    return text({ jobId, state: command === 'pause' ? 'disabled' : 'ready' });
  },
);

server.tool(
  'feed_activity',
  'What the engine has upvoted, liked, commented on or deliberately skipped, with the ' +
    'reason it recorded for each. Audit surface for engagement behaviour.',
  { limit: z.number().optional() },
  async ({ limit }) => text(recentFeedActions(limit ?? 30)),
);

await server.connect(new StdioServerTransport());
