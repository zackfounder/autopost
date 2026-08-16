import type { Page } from 'playwright';
import type { Account, Pacing } from '../db/types.ts';
import type { AiClient } from '../ai/client.ts';
import { getPlatform, type PlatformId, type EngageAction } from '../platforms/index.ts';
import type { Invitation } from '../platforms/types.ts';
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
    case 'engage_post':
      return engagePost(deps, platformId, payload);
    case 'grow_network':
      return growNetwork(deps, platformId, payload);
    case 'visit_profiles':
      return visitProfiles(deps, platformId, payload);
    case 'follow_targets':
      return followTargets(deps, platformId, payload);
    case 'reply_comments':
      return replyComments(deps, platformId, payload);
    default:
      return { ok: false, detail: {}, error: `unknown job kind "${job.kind}"` };
  }
}

/** Every job kind this engine knows, in one place so the CLI and MCP cannot drift. */
export const JOB_KINDS = [
  'generate_post',
  'publish_due',
  'engage_feed',
  'send_dm',
  'engage_post',
  'grow_network',
  'visit_profiles',
  'follow_targets',
  'reply_comments',
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

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

  // Some content is authored from a specific page rather than the composer.
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

/* ─────────────────────────────────────────────────────────── engage_post */

/**
 * Engage with ONE post you named, rather than whatever the feed served up.
 *
 * Any of react / comment / repost, in that order, on the same URL. Each is
 * quota-checked on its own, so hitting the comment cap still lets the reaction
 * through — and a comment is generated text, so it goes through the gate like
 * every other outbound word.
 */
async function engagePost(
  deps: JobDeps,
  platform: PlatformId,
  payload: Record<string, unknown>,
): Promise<JobOutcome> {
  const adapter = getPlatform(platform);
  const url = String(payload.url ?? '').trim();
  if (!url) return { ok: false, detail: {}, error: 'engage_post needs a `url`' };

  const done: string[] = [];
  const skipped: Record<string, string> = {};

  const reaction = payload.reaction ? String(payload.reaction) : null;
  if (reaction) {
    if (!adapter.reactToPost) {
      skipped.react = `${platform} cannot react to a post by URL`;
    } else {
      const quota = checkQuota(deps.account.id, 'react_post', platform);
      if (!quota.allowed) {
        skipped.react = quota.reason ?? 'capped';
      } else {
        const out = await adapter.reactToPost(deps.page, url, reaction as never);
        logAction({
          accountId: deps.account.id,
          action: 'react_post',
          status: out.ok ? 'ok' : 'fail',
          counted: out.ok,
          detail: { platform, url, reaction, error: out.error ?? null },
        });
        if (out.ok) done.push(`react:${reaction}`);
        else skipped.react = out.error ?? 'failed';
      }
    }
  }

  const wantsComment = Boolean(payload.comment ?? payload.brief);
  if (wantsComment) {
    if (!adapter.commentOnPost) {
      skipped.comment = `${platform} cannot comment on a post by URL`;
    } else {
      const quota = checkQuota(deps.account.id, 'comment_post', platform);
      if (!quota.allowed) {
        skipped.comment = quota.reason ?? 'capped';
      } else {
        const written = await draftGated(deps, platform, 'comment', {
          body: payload.comment ? String(payload.comment) : '',
          brief: payload.brief ? String(payload.brief) : '',
          facts: payload.facts ? String(payload.facts) : undefined,
        });
        if (!written.ok) {
          skipped.comment = `blocked by the gate: ${written.violations.join('; ')}`;
        } else {
          await sleep(randInt(deps.pacing.minGapSeconds, deps.pacing.maxGapSeconds) * 1000);
          const out = await adapter.commentOnPost(deps.page, url, written.body);
          logAction({
            accountId: deps.account.id,
            action: 'comment_post',
            status: out.ok ? 'ok' : 'fail',
            counted: out.ok,
            detail: { platform, url, error: out.error ?? null },
          });
          if (out.ok) {
            done.push('comment');
            createContent({
              accountId: deps.account.id,
              platform,
              kind: 'comment',
              targetRef: url,
              body: written.body,
              state: 'published',
            });
          } else {
            skipped.comment = out.error ?? 'failed';
          }
        }
      }
    }
  }

  if (payload.repost) {
    if (!adapter.repost) {
      skipped.repost = `${platform} cannot repost`;
    } else {
      const quota = checkQuota(deps.account.id, 'repost', platform);
      if (!quota.allowed) {
        skipped.repost = quota.reason ?? 'capped';
      } else {
        // A repost "with your thoughts" publishes text under your own name on
        // your own feed, so that text is gated exactly like a post would be.
        let thought: string | undefined;
        const raw = typeof payload.repost === 'string' ? payload.repost.trim() : '';
        if (raw) {
          const written = await draftGated(deps, platform, 'post', { body: raw, brief: '' });
          if (!written.ok) {
            skipped.repost = `blocked by the gate: ${written.violations.join('; ')}`;
          } else {
            thought = written.body;
          }
        }
        if (!skipped.repost) {
          await sleep(randInt(deps.pacing.minGapSeconds, deps.pacing.maxGapSeconds) * 1000);
          const out = await adapter.repost(deps.page, url, thought);
          logAction({
            accountId: deps.account.id,
            action: 'repost',
            status: out.ok ? 'ok' : 'fail',
            counted: out.ok,
            detail: { platform, url, error: out.error ?? null },
          });
          if (out.ok) done.push('repost');
          else skipped.repost = out.error ?? 'failed';
        }
      }
    }
  }

  if (done.length === 0 && Object.keys(skipped).length === 0) {
    return { ok: false, detail: {}, error: 'engage_post was given nothing to do' };
  }
  deps.log(`engage_post ${url}: ${done.join(', ') || 'nothing'}`);
  return { ok: done.length > 0, detail: { url, done, skipped } };
}

/* ────────────────────────────────────────────────────────── grow_network */

/**
 * Accept the invitations worth accepting, and withdraw the ones nobody answered.
 *
 * The withdrawal half is the one that matters most: LinkedIn counts outstanding
 * invitations against a weekly cap no tool can raise, so old unanswered invites
 * are quota being paid for and not used.
 */
async function growNetwork(
  deps: JobDeps,
  platform: PlatformId,
  payload: Record<string, unknown>,
): Promise<JobOutcome> {
  const adapter = getPlatform(platform);
  if (!adapter.listInvitations || !adapter.acceptInvitation) {
    return { ok: false, detail: {}, error: `${platform} has no invitation manager` };
  }

  const maxAccept = Math.min(Number(payload.maxAccept ?? 10), 25);
  const criteria = String(payload.criteria ?? '').trim();
  let accepted = 0;

  const pending = await adapter.listInvitations(deps.page, Math.max(maxAccept * 2, 20));
  deps.log(`${pending.length} pending invitation(s)`);

  // With no criteria, accept in order. With criteria, ask the model which ones
  // fit — on the headline only, which is all the invitation card shows.
  let wanted = pending.slice(0, maxAccept);
  if (criteria && pending.length > 0) {
    wanted = await filterInvitations(deps, pending, criteria, maxAccept);
    deps.log(`${wanted.length} of ${pending.length} match: ${criteria}`);
  }

  for (const inv of wanted) {
    const quota = checkQuota(deps.account.id, 'accept_invite', platform);
    if (!quota.allowed) {
      deps.log(`accepting held: ${quota.reason} (${quota.used}/${quota.cap})`);
      break;
    }
    const out = await adapter.acceptInvitation(deps.page, inv);
    logAction({
      accountId: deps.account.id,
      action: 'accept_invite',
      status: out.ok ? 'ok' : 'fail',
      counted: out.ok,
      detail: { platform, name: inv.name, error: out.error ?? null },
    });
    if (out.ok) {
      accepted++;
      deps.log(`accepted ${inv.name ?? 'an invitation'}`);
    }
    await sleep(randInt(deps.pacing.minGapSeconds, deps.pacing.maxGapSeconds) * 1000);
  }

  let withdrawn = 0;
  const afterDays = Number(payload.withdrawAfterDays ?? 0);
  if (afterDays > 0 && adapter.withdrawStaleInvitations) {
    const quota = checkQuota(deps.account.id, 'withdraw_invite', platform);
    if (quota.allowed) {
      const maxWithdraw = Math.min(Number(payload.maxWithdraw ?? 10), 25);
      const out = await adapter.withdrawStaleInvitations(deps.page, afterDays, maxWithdraw);
      withdrawn = out.withdrawn;
      for (let i = 0; i < withdrawn; i++) {
        logAction({
          accountId: deps.account.id,
          action: 'withdraw_invite',
          status: 'ok',
          counted: true,
          detail: { platform, olderThanDays: afterDays },
        });
      }
      if (withdrawn) deps.log(`withdrew ${withdrawn} invitation(s) older than ${afterDays}d`);
    }
  }

  return { ok: true, detail: { pending: pending.length, accepted, withdrawn } };
}

/** Which pending invitations are worth accepting. Headlines only — that is all the card shows. */
async function filterInvitations(
  deps: JobDeps,
  pending: Invitation[],
  criteria: string,
  max: number,
): Promise<Invitation[]> {
  const schema = {
    type: 'object',
    properties: { accept: { type: 'array', items: { type: 'string' } } },
    required: ['accept'],
    additionalProperties: false,
  };
  try {
    const out = await deps.ai.json<{ accept: string[] }>({
      system: [
        'You are deciding which pending LinkedIn connection requests to accept.',
        `Accept at most ${max}. Accepting none is a valid answer.`,
        `The bar: ${criteria}`,
        'Skip recruiters spraying, obvious lead-gen agencies, and anything that reads as automated.',
        'Return the exact refs to accept, nothing else.',
      ].join('\n'),
      prompt: pending.map((p) => `ref=${p.ref}\n${p.name ?? 'unknown'} — ${p.headline ?? 'no headline'}`).join('\n\n'),
      schema,
      maxTokens: 1_500,
    });
    const wanted = new Set(out.accept ?? []);
    return pending.filter((p) => wanted.has(p.ref)).slice(0, max);
  } catch (err) {
    // Failing closed here means accepting nobody, which costs a day.
    deps.log(`invitation filter failed, accepting nobody this round: ${String(err)}`);
    return [];
  }
}

/* ─────────────────────────────────────────────────────── visit_profiles */

/**
 * Visit profiles. The read is incidental — the visit is the action, because
 * LinkedIn tells the other person you looked. Linked Helper's warm-up step.
 */
async function visitProfiles(
  deps: JobDeps,
  platform: PlatformId,
  payload: Record<string, unknown>,
): Promise<JobOutcome> {
  const adapter = getPlatform(platform);
  if (!adapter.visitProfile) return { ok: false, detail: {}, error: `${platform} cannot visit profiles` };

  const urls = toUrlList(payload.urls ?? payload.url);
  if (urls.length === 0) return { ok: false, detail: {}, error: 'visit_profiles needs `urls`' };

  const visited: string[] = [];
  for (const url of urls.slice(0, Math.min(Number(payload.max ?? 10), 25))) {
    const quota = checkQuota(deps.account.id, 'visit_profile', platform);
    if (!quota.allowed) {
      deps.log(`visits held: ${quota.reason} (${quota.used}/${quota.cap})`);
      break;
    }
    const out = await adapter.visitProfile(deps.page, url);
    logAction({
      accountId: deps.account.id,
      action: 'visit_profile',
      status: out.ok ? 'ok' : 'fail',
      counted: out.ok,
      detail: { platform, url, name: out.name, error: out.error ?? null },
    });
    if (out.ok) {
      visited.push(out.name ?? url);
      deps.log(`visited ${out.name ?? url}`);
    }
    await sleep(randInt(deps.pacing.minGapSeconds, deps.pacing.maxGapSeconds) * 1000);
  }
  return { ok: true, detail: { requested: urls.length, visited } };
}

/* ─────────────────────────────────────────────────────── follow_targets */

async function followTargets(
  deps: JobDeps,
  platform: PlatformId,
  payload: Record<string, unknown>,
): Promise<JobOutcome> {
  const adapter = getPlatform(platform);
  if (!adapter.follow) return { ok: false, detail: {}, error: `${platform} cannot follow` };

  const urls = toUrlList(payload.urls ?? payload.url);
  if (urls.length === 0) return { ok: false, detail: {}, error: 'follow_targets needs `urls`' };

  const followed: string[] = [];
  for (const url of urls.slice(0, Math.min(Number(payload.max ?? 5), 15))) {
    const quota = checkQuota(deps.account.id, 'follow', platform);
    if (!quota.allowed) {
      deps.log(`follows held: ${quota.reason} (${quota.used}/${quota.cap})`);
      break;
    }
    const out = await adapter.follow(deps.page, url);
    logAction({
      accountId: deps.account.id,
      action: 'follow',
      status: out.ok ? 'ok' : 'fail',
      counted: out.ok,
      detail: { platform, url, error: out.error ?? null },
    });
    if (out.ok) followed.push(url);
    await sleep(randInt(deps.pacing.minGapSeconds, deps.pacing.maxGapSeconds) * 1000);
  }
  return { ok: true, detail: { requested: urls.length, followed } };
}

/* ─────────────────────────────────────────────────────── reply_comments */

/**
 * Answer the people who commented on your own posts.
 *
 * This is the highest-value thing an account can do on LinkedIn and the thing
 * that gets dropped first, because it is invisible until you go looking. With
 * no `postUrl` it reads your latest posts and works through their comments.
 *
 * Your own comments are skipped by name — replying to yourself in a public
 * thread is the one failure here that everybody sees.
 */
async function replyComments(
  deps: JobDeps,
  platform: PlatformId,
  payload: Record<string, unknown>,
): Promise<JobOutcome> {
  const adapter = getPlatform(platform);
  if (!adapter.readPostComments || !adapter.replyToComment) {
    return { ok: false, detail: {}, error: `${platform} cannot reply to comments` };
  }

  const max = Math.min(Number(payload.max ?? 3), 10);
  let posts: string[] = toUrlList(payload.postUrl ?? payload.postUrls);

  if (posts.length === 0) {
    if (!adapter.myRecentPosts) return { ok: false, detail: {}, error: 'no `postUrl`, and this platform cannot list your posts' };
    const recent = await adapter.myRecentPosts(deps.page, Number(payload.scanPosts ?? 3));
    posts = recent.map((p) => p.url);
    deps.log(`no postUrl given — checking ${posts.length} recent post(s)`);
  }

  // Whoever this account is, by the handle it reported at login. Used only to
  // avoid replying to itself.
  const me = (deps.account.handle ?? '').trim().toLowerCase();
  let replied = 0;

  for (const postUrl of posts) {
    if (replied >= max) break;
    const comments = await adapter.readPostComments(deps.page, postUrl, 20);
    const answerable = comments.filter((c) => {
      if (c.answered) return false;
      if (me && (c.author ?? '').trim().toLowerCase() === me) return false;
      if (hasSeenFeedItem(deps.account.id, `reply:${c.ref}`)) return false;
      return c.text.trim().length > 0;
    });
    deps.log(`${postUrl}: ${comments.length} comment(s), ${answerable.length} unanswered`);

    for (const comment of answerable) {
      if (replied >= max) break;

      const quota = checkQuota(deps.account.id, 'reply_comment', platform);
      if (!quota.allowed) {
        deps.log(`replies held: ${quota.reason} (${quota.used}/${quota.cap})`);
        return { ok: true, detail: { replied, held: quota.reason } };
      }

      const written = await draftGated(deps, platform, 'reply', {
        body: '',
        brief: [
          'Reply to this comment on your own post. One or two sentences.',
          'Answer what they actually said. Do not thank them for engaging, and do not restate the post.',
          `They wrote:\n${comment.text}`,
        ].join('\n'),
        facts: payload.facts ? String(payload.facts) : undefined,
      });

      // Record it as handled either way, or a blocked reply is re-attempted on
      // every run until the cap absorbs the whole job.
      markFeedSeen({
        accountId: deps.account.id,
        platform,
        postRef: `reply:${comment.ref}`,
        author: comment.author,
        excerpt: comment.text.slice(0, 200),
        action: written.ok ? 'comment' : 'skipped',
        reason: written.ok ? 'replied' : `blocked: ${written.violations.join('; ')}`,
      });

      if (!written.ok) continue;

      const out = await adapter.replyToComment(deps.page, postUrl, comment, written.body);
      logAction({
        accountId: deps.account.id,
        action: 'reply_comment',
        status: out.ok ? 'ok' : 'fail',
        counted: out.ok,
        detail: { platform, postUrl, author: comment.author, error: out.error ?? null },
      });

      if (out.ok) {
        replied++;
        createContent({
          accountId: deps.account.id,
          platform,
          kind: 'reply',
          targetRef: postUrl,
          body: written.body,
          state: 'published',
        });
        deps.log(`replied to ${comment.author ?? 'a comment'}`);
      }
      await sleep(randInt(deps.pacing.minGapSeconds, deps.pacing.maxGapSeconds) * 1000);
    }
  }

  return { ok: true, detail: { posts: posts.length, replied } };
}

/* ─────────────────────────────────────────────────────────────── helpers */

/**
 * Produce gated text: either check the body you supplied, or write one from a
 * brief. Both routes end at the gate, and there is no third route.
 */
async function draftGated(
  deps: JobDeps,
  platform: PlatformId,
  kind: 'post' | 'comment' | 'reply' | 'dm',
  input: { body: string; brief: string; facts?: string },
): Promise<{ ok: boolean; body: string; violations: string[] }> {
  if (input.body.trim()) {
    const checked = gate({ platform, kind, body: input.body });
    return { ok: checked.pass, body: input.body, violations: checked.violations };
  }
  if (!input.brief.trim()) return { ok: false, body: '', violations: ['nothing to write from'] };

  const drafted = await generate({
    ai: deps.ai,
    platform,
    kind,
    brief: input.brief,
    facts: input.facts,
    onLog: deps.log,
  });
  return { ok: drafted.ok, body: drafted.body, violations: drafted.violations };
}

function toUrlList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    return raw.split(/[,\s]+/).map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
