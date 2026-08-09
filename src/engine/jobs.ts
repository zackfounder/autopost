import type { Page } from 'playwright';
import type { Account, Pacing } from '../db/types.ts';
import type { AiClient } from '../ai/client.ts';
import { getPlatform, type PlatformId, type EngageAction } from '../platforms/index.ts';
import { generate } from '../content/generate.ts';
import { gate } from '../content/gate.ts';
import { checkQuota } from './limits.ts';
import { logAction } from '../db/index.ts';
import {
  createContent,
  dueContent,
  setContentState,
  recentPublishedBodies,
  recordTemplateUse,
  templateUsage,
  markFeedSeen,
  hasSeenFeedItem,
  type JobRow,
} from '../db/content.ts';
import { sleep, randInt, dwell } from '../browser/human.ts';

export interface JobDeps {
  page: Page;
  account: Account;
  ai: AiClient;
  pacing: Pacing;
  log: (line: string) => void;
}

export interface JobOutcome {
  ok: boolean;
  detail: Record<string, unknown>;
  error?: string;
}

/**
 * Scheduled, non-funnel work: writing a post, publishing what's due, engaging with a
 * feed, sending a DM. Every path that produces outbound text goes through
 * generate() -> gate(), and nothing publishes on a gate failure.
 */
export async function runJob(deps: JobDeps, job: JobRow): Promise<JobOutcome> {
  const platformId = deps.account.platform as PlatformId;
  const payload = safeJson(job.payload);

  switch (job.kind) {
    case 'generate_post':
      return generatePost(deps, platformId, payload);
    case 'publish_due':
      return publishDue(deps, platformId);
    case 'engage_feed':
      return engageFeed(deps, platformId, payload);
    case 'send_dm':
      return sendDm(deps, platformId, payload);
    default:
      return { ok: false, detail: {}, error: `unknown job kind "${job.kind}"` };
  }
}

/* ─────────────────────────────────────────────────────────── generate_post */

/**
 * Writes a post and QUEUES it. Generation and publication are separate jobs so a
 * blocked draft is a database row you can read, not a silent nothing — and so the
 * expensive model call never happens inside the publish path.
 */
async function generatePost(
  deps: JobDeps,
  platform: PlatformId,
  payload: Record<string, unknown>,
): Promise<JobOutcome> {
  const brief = String(payload.brief ?? '').trim();
  if (!brief) return { ok: false, detail: {}, error: 'generate_post needs a `brief`' };

  const result = await generate({
    ai: deps.ai,
    platform,
    kind: 'post',
    brief,
    facts: payload.facts ? String(payload.facts) : undefined,
    templateId: payload.templateId ? String(payload.templateId) : undefined,
    usage: templateUsage(deps.account.id),
    recentBodies: recentPublishedBodies(deps.account.id),
    onLog: deps.log,
  });

  const scheduledAt = payload.scheduledAt ? String(payload.scheduledAt) : null;

  const row = createContent({
    accountId: deps.account.id,
    platform,
    kind: 'post',
    templateId: result.templateId,
    targetRef: payload.targetRef ? String(payload.targetRef) : null,
    body: result.body,
    state: result.ok ? 'queued' : 'blocked',
    violations: result.violations,
    meta: { brief, attempts: result.attempts },
    scheduledAt,
  });

  if (result.templateId) recordTemplateUse(deps.account.id, result.templateId);

  if (!result.ok) {
    deps.log(`draft #${row.id} BLOCKED after ${result.attempts} attempts — not published`);
    return {
      ok: false,
      detail: { contentId: row.id, violations: result.violations },
      error: 'draft never passed the content gate',
    };
  }

  deps.log(`draft #${row.id} queued (${result.templateId})`);
  return { ok: true, detail: { contentId: row.id, templateId: result.templateId } };
}

/* ──────────────────────────────────────────────────────────── publish_due */

/** Publishes ONE due item per run. One action at a time, always. */
async function publishDue(deps: JobDeps, platform: PlatformId): Promise<JobOutcome> {
  const adapter = getPlatform(platform);
  const queue = dueContent(deps.account.id);
  if (queue.length === 0) return { ok: true, detail: { published: 0, reason: 'nothing due' } };

  const item = queue[0]!;

  const quotaAction = item.kind === 'dm' ? 'dm' : 'post';
  const quota = checkQuota(deps.account.id, quotaAction, platform);
  if (!quota.allowed) {
    deps.log(`publish held: ${quota.reason} (${quota.used}/${quota.cap})`);
    return { ok: true, detail: { published: 0, held: quota.reason } };
  }

  // Re-gate immediately before publishing. The body could have been edited in the
  // dashboard since it was queued, and the gate is the only thing standing between
  // an edit and a real account.
  const recheck = gate({
    platform,
    kind: item.kind as 'post' | 'dm' | 'comment' | 'reply',
    body: item.body,
    templateId: item.template_id,
    recentBodies: recentPublishedBodies(deps.account.id),
  });
  if (!recheck.pass) {
    setContentState(item.id, 'blocked', { violations: recheck.violations });
    deps.log(`content #${item.id} failed the pre-publish re-check — blocked`);
    return { ok: false, detail: { contentId: item.id, violations: recheck.violations } };
  }

  if (!adapter.post) {
    setContentState(item.id, 'failed', { error: 'platform cannot post' });
    return { ok: false, detail: { contentId: item.id }, error: `${platform} has no post capability` };
  }

  // Quora answers and Indie Hackers posts need to start from the target page.
  if (item.target_ref) {
    await deps.page.goto(item.target_ref, { waitUntil: 'domcontentloaded' });
    await dwell();
  }

  const out = await adapter.post(deps.page, item.body, { postAs: deps.account.post_as });

  logAction({
    accountId: deps.account.id,
    action: 'post',
    status: out.ok ? 'ok' : 'fail',
    counted: out.ok,
    detail: { contentId: item.id, platform, error: out.error ?? null },
  });

  if (!out.ok) {
    setContentState(item.id, 'failed', { error: out.error });
    deps.log(`publish failed: ${out.error}`);
    return { ok: false, detail: { contentId: item.id }, error: out.error };
  }

  setContentState(item.id, 'published', { permalink: out.permalink ?? null });
  deps.log(`published #${item.id} to ${platform}${out.permalink ? ` -> ${out.permalink}` : ''}`);
  return { ok: true, detail: { contentId: item.id, permalink: out.permalink ?? null } };
}

/* ──────────────────────────────────────────────────────────── engage_feed */

/**
 * Read the feed, decide what deserves a reaction, react. The decision is a model
 * call constrained by instructions/<platform>.md; the ACTION is constrained by the
 * rate limiter and the seen-list. An item is recorded as seen whether or not it was
 * engaged with, so the same post is never reconsidered.
 */
async function engageFeed(
  deps: JobDeps,
  platform: PlatformId,
  payload: Record<string, unknown>,
): Promise<JobOutcome> {
  const adapter = getPlatform(platform);
  if (!adapter.readFeed || !adapter.engage) {
    return { ok: false, detail: {}, error: `${platform} has no feed capability` };
  }

  const scan = Math.min(Number(payload.scan ?? 15), 40);
  const maxActions = Math.min(Number(payload.maxActions ?? 3), 10);
  const allowed = (Array.isArray(payload.actions) ? payload.actions : adapter.can.engage) as EngageAction[];
  const criteria = String(payload.criteria ?? 'genuinely useful posts from builders and founders');

  const items = await adapter.readFeed(deps.page, scan);
  const fresh = items.filter((i) => !hasSeenFeedItem(deps.account.id, i.ref));
  deps.log(`feed: ${items.length} scanned, ${fresh.length} new`);
  if (fresh.length === 0) return { ok: true, detail: { scanned: items.length, engaged: 0 } };

  const decisions = await decideEngagements(deps, platform, fresh, allowed, criteria, maxActions);

  let engaged = 0;
  for (const d of decisions) {
    const item = fresh.find((i) => i.ref === d.ref);
    if (!item) continue;

    if (d.action === 'skip') {
      markFeedSeen({
        accountId: deps.account.id,
        platform,
        postRef: item.ref,
        author: item.author,
        excerpt: item.excerpt,
        action: 'skipped',
        reason: d.reason,
      });
      continue;
    }

    const quotaKey = `engage_${d.action}`;
    const quota = checkQuota(deps.account.id, quotaKey, platform);
    if (!quota.allowed) {
      deps.log(`engagement held: ${quota.reason} (${quota.used}/${quota.cap})`);
      break;
    }

    // A comment is outbound text, so it goes through the gate like anything else.
    let body: string | undefined;
    if (d.action === 'comment') {
      const drafted = await generate({
        ai: deps.ai,
        platform,
        kind: 'comment',
        brief: `Write one comment replying to this post. ${d.reason}\n\nThe post:\n${item.excerpt}`,
        facts: payload.facts ? String(payload.facts) : undefined,
        onLog: deps.log,
      });
      if (!drafted.ok) {
        markFeedSeen({
          accountId: deps.account.id,
          platform,
          postRef: item.ref,
          author: item.author,
          excerpt: item.excerpt,
          action: 'skipped',
          reason: `comment blocked by gate: ${drafted.violations.join('; ')}`,
        });
        continue;
      }
      body = drafted.body;
    }

    const out = await adapter.engage(deps.page, item, d.action, body);

    logAction({
      accountId: deps.account.id,
      action: quotaKey,
      status: out.ok ? 'ok' : 'fail',
      counted: out.ok,
      detail: { platform, ref: item.ref, error: out.error ?? null },
    });

    markFeedSeen({
      accountId: deps.account.id,
      platform,
      postRef: item.ref,
      author: item.author,
      excerpt: item.excerpt,
      action: out.ok ? d.action : 'skipped',
      reason: out.ok ? d.reason : (out.error ?? 'engage failed'),
    });

    if (out.ok) {
      engaged++;
      if (body) {
        createContent({
          accountId: deps.account.id,
          platform,
          kind: 'comment',
          targetRef: item.permalink ?? item.ref,
          body,
          state: 'published',
        });
      }
      deps.log(`${d.action} on ${item.author ?? 'unknown'}: ${d.reason}`);
    }

    // Human gap between two engagements, same as between funnel actions.
    await sleep(randInt(deps.pacing.minGapSeconds, deps.pacing.maxGapSeconds) * 1000);
    if (engaged >= maxActions) break;
  }

  return { ok: true, detail: { scanned: items.length, fresh: fresh.length, engaged } };
}

interface Decision {
  ref: string;
  action: EngageAction | 'skip';
  reason: string;
}

/** One structured call for the whole batch, rather than one call per post. */
async function decideEngagements(
  deps: JobDeps,
  platform: PlatformId,
  items: { ref: string; author: string | null; excerpt: string }[],
  allowed: EngageAction[],
  criteria: string,
  maxActions: number,
): Promise<Decision[]> {
  const schema = {
    type: 'object',
    properties: {
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string' },
            action: { type: 'string', enum: [...allowed, 'skip'] },
            reason: { type: 'string', description: 'one sentence, specific to this post' },
          },
          required: ['ref', 'action', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['decisions'],
    additionalProperties: false,
  };

  const listing = items
    .map((i, n) => `[${n}] ref=${i.ref}\nauthor: ${i.author ?? 'unknown'}\n${i.excerpt.slice(0, 400)}`)
    .join('\n\n');

  try {
    const out = await deps.ai.json<{ decisions: Decision[] }>({
      system: [
        `You are deciding how ${platform} feed posts should be engaged with, on behalf of a real founder.`,
        `Allowed actions: ${allowed.join(', ')}, or "skip".`,
        `Engage with at most ${maxActions} posts. Skipping everything is a valid and common answer.`,
        '',
        'The bar for engaging:',
        `- ${criteria}`,
        '- Skip anything promotional, political, hostile, or from an account that looks automated.',
        '- Skip anything you would only engage with to be seen engaging.',
        '- A comment is only justified when there is something specific to add that the author does not already know. Otherwise like/upvote, or skip.',
        '',
        'Return a decision for EVERY post, using its exact ref.',
      ].join('\n'),
      prompt: listing,
      schema,
      maxTokens: 3_000,
    });
    return Array.isArray(out.decisions) ? out.decisions : [];
  } catch (err) {
    deps.log(`engagement decision failed, skipping this round: ${String(err)}`);
    return [];
  }
}

/* ─────────────────────────────────────────────────────────────── send_dm */

async function sendDm(
  deps: JobDeps,
  platform: PlatformId,
  payload: Record<string, unknown>,
): Promise<JobOutcome> {
  const adapter = getPlatform(platform);
  if (!adapter.dm) return { ok: false, detail: {}, error: `${platform} has no DM capability` };

  const target = String(payload.target ?? '').trim();
  if (!target) return { ok: false, detail: {}, error: 'send_dm needs a `target`' };

  const quota = checkQuota(deps.account.id, 'dm', platform);
  if (!quota.allowed) {
    return { ok: true, detail: { sent: 0, held: quota.reason } };
  }

  let body = String(payload.body ?? '').trim();
  if (!body) {
    const brief = String(payload.brief ?? '').trim();
    if (!brief) return { ok: false, detail: {}, error: 'send_dm needs either `body` or `brief`' };
    const drafted = await generate({
      ai: deps.ai,
      platform,
      kind: 'dm',
      brief,
      facts: payload.facts ? String(payload.facts) : undefined,
      onLog: deps.log,
    });
    if (!drafted.ok) {
      return { ok: false, detail: { violations: drafted.violations }, error: 'DM blocked by the gate' };
    }
    body = drafted.body;
  } else {
    const checked = gate({ platform, kind: 'dm', body });
    if (!checked.pass) {
      return { ok: false, detail: { violations: checked.violations }, error: 'DM blocked by the gate' };
    }
  }

  const row = createContent({
    accountId: deps.account.id,
    platform,
    kind: 'dm',
    targetRef: target,
    body,
    state: 'queued',
  });

  const out = await adapter.dm(deps.page, target, body);

  logAction({
    accountId: deps.account.id,
    action: 'dm',
    status: out.ok ? 'ok' : 'fail',
    counted: out.ok,
    detail: { platform, target, error: out.error ?? null },
  });

  setContentState(row.id, out.ok ? 'published' : 'failed', { error: out.error });
  if (out.ok) deps.log(`DM sent to ${target}`);
  return { ok: out.ok, detail: { contentId: row.id, target }, error: out.error };
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
