import { SEL, firstVisible, clickIfPresent, textOf } from '../browser/selectors.ts';
import { readPage, dwell, typeLikeHuman, sleep, randInt } from '../browser/human.ts';
import { recordMessage, upsertLead, suppress } from '../db/index.ts';
import { parseDegree } from '../util/url.ts';
import { renderTemplate, pickVariant, type ActionDef } from './types.ts';

/** Open the lead's 1:1 thread. Returns false if LinkedIn won't give us one. */
async function openThread(ctx: {
  page: import('playwright').Page;
  lead: { profile_url: string };
}): Promise<boolean> {
  const { page, lead } = ctx;
  if (!page.url().startsWith(lead.profile_url)) {
    await page.goto(lead.profile_url, { waitUntil: 'domcontentloaded' });
    await readPage(page, 1);
  }
  const ok = await clickIfPresent(page, SEL.messageButton, 5_000);
  if (!ok) return false;
  await sleep(randInt(1200, 2600));
  return Boolean(await firstVisible(page, SEL.messageComposer, 8_000));
}

/** Read the open thread. `incoming` = did the OTHER party send the most recent message. */
async function readThread(
  page: import('playwright').Page,
): Promise<{ incoming: boolean; lastIncomingText: string | null; count: number }> {
  const bubbles = page.locator(SEL.messageBubbles.join(', '));
  const count = await bubbles.count().catch(() => 0);
  if (count === 0) return { incoming: false, lastIncomingText: null, count: 0 };

  let lastIncomingText: string | null = null;
  let lastWasIncoming = false;

  for (let i = 0; i < count; i++) {
    const b = bubbles.nth(i);
    const cls = (await b.getAttribute('class').catch(() => '')) ?? '';
    const isOther = SEL.incomingBubbleMarker.some((m) => cls.includes(m.replace('.', '')));
    lastWasIncoming = isOther;
    if (isOther) lastIncomingText = (await b.innerText().catch(() => null))?.trim() ?? null;
  }

  return { incoming: lastWasIncoming, lastIncomingText, count };
}

export const message: ActionDef = {
  name: 'message',
  description:
    'Send a direct message to a 1st-degree connection. `body` is a template; ' +
    '`bodyVariants` is an array for a stable per-lead A/B split. Refuses to send if ' +
    'the lead has already replied (that check is structural, not optional).',
  degrees: ['1st'],
  ratedLimited: true,
  paramsSchema: {
    body: 'template string, supports {{first_name}}, {{company}}, {{vars.*}}',
    bodyVariants: 'array of template strings',
    skipIfThreadHasMessages: 'boolean; skip if any message already exists, default false',
  },
  async run(ctx) {
    const { page, lead, vars } = ctx;

    await page.goto(lead.profile_url, { waitUntil: 'domcontentloaded' });
    if (/\/checkpoint\/|\/authwall|\/login/.test(page.url())) {
      return { status: 'blocked', advance: false, counted: false };
    }
    await readPage(page, 1);

    const degree = parseDegree(await textOf(page, SEL.degreeBadge));
    if (degree !== '1st') {
      upsertLead({ profile_url: lead.profile_url, degree });
      return { status: 'skip', advance: false, counted: false, waitSeconds: 24 * 3600 };
    }

    if (!(await openThread(ctx))) {
      return { status: 'skip', counted: false, detail: { reason: 'no_message_button' } };
    }

    const thread = await readThread(page);

    // Stop-on-reply. This is a hard invariant, not a setting: nobody gets a
    // follow-up after they answered.
    if (thread.incoming) {
      if (thread.lastIncomingText) {
        recordMessage(lead.lead_id, ctx.campaign.id, 'in', thread.lastIncomingText);
      }
      ctx.log('lead already replied — leaving the sequence');
      return {
        status: 'skip',
        counted: false,
        exit: { state: 'replied', reason: 'replied_before_send' },
        detail: { reply: thread.lastIncomingText },
      };
    }

    if (ctx.params.skipIfThreadHasMessages === true && thread.count > 0) {
      return { status: 'skip', counted: false, detail: { reason: 'thread_not_empty' } };
    }

    const variants = Array.isArray(ctx.params.bodyVariants)
      ? (ctx.params.bodyVariants as string[])
      : [];
    const raw =
      variants.length > 0
        ? pickVariant(variants, lead.lead_id)
        : typeof ctx.params.body === 'string'
          ? ctx.params.body
          : '';
    const body = renderTemplate(raw, lead, vars).trim();
    if (!body) {
      return { status: 'fail', counted: false, detail: { reason: 'empty_body' } };
    }

    const composer = await firstVisible(page, SEL.messageComposer, 6_000);
    if (!composer) {
      return { status: 'fail', advance: false, counted: false, detail: { reason: 'no_composer' } };
    }

    await typeLikeHuman(composer, body, ctx.pacing);
    await dwell();

    const sendBtn = await firstVisible(page, SEL.messageSendButton, 4_000);
    if (!sendBtn) {
      return { status: 'fail', advance: false, counted: false, detail: { reason: 'no_send' } };
    }
    await sendBtn.click();
    await sleep(randInt(1500, 3500));

    recordMessage(lead.lead_id, ctx.campaign.id, 'out', body);
    ctx.log(`messaged ${lead.full_name ?? lead.profile_url}`);
    return { status: 'ok', detail: { chars: body.length } };
  },
};

/**
 * Linked Helper's "Check for replies". It is BOTH the delay between two messages
 * AND the reply detector — that is why you must not substitute a plain `delay`
 * between messaging steps.
 */
export const checkReplies: ActionDef = {
  name: 'check_replies',
  description:
    'The correct wait between two message steps: it holds the lead for `waitHours` and, ' +
    'each time it runs, checks whether they replied. A reply ends the sequence for that ' +
    'lead. Never use a plain `delay` between two messages — it cannot see the reply.',
  degrees: ['1st'],
  ratedLimited: false,
  paramsSchema: {
    waitHours: 'hours to wait before the next step, default 72',
    onReply: '"stop" (default) or "continue"',
    suppressOnReply: 'boolean; also add them to the global suppression list, default false',
  },
  async run(ctx) {
    const { page, lead } = ctx;

    const waitHours = Number(ctx.params.waitHours ?? 72);
    const elapsedMs = ctx.lead.last_action_at
      ? Date.now() - Date.parse(String(ctx.lead.last_action_at).replace(' ', 'T') + 'Z')
      : Number.POSITIVE_INFINITY;

    await page.goto(lead.profile_url, { waitUntil: 'domcontentloaded' });
    if (/\/checkpoint\/|\/authwall|\/login/.test(page.url())) {
      return { status: 'blocked', advance: false, counted: false };
    }
    await readPage(page, 1);

    if (await openThread(ctx)) {
      const thread = await readThread(page);
      if (thread.incoming) {
        if (thread.lastIncomingText) {
          recordMessage(lead.lead_id, ctx.campaign.id, 'in', thread.lastIncomingText);
        }
        if (ctx.params.suppressOnReply === true) {
          suppress(lead.profile_url, 'replied');
        }
        ctx.log(`reply from ${lead.full_name ?? lead.profile_url}`);
        if ((ctx.params.onReply ?? 'stop') === 'stop') {
          return {
            status: 'ok',
            counted: false,
            exit: { state: 'replied', reason: 'replied' },
            detail: { reply: thread.lastIncomingText },
          };
        }
        return { status: 'ok', counted: false, detail: { reply: thread.lastIncomingText } };
      }
    }

    // No reply yet. Advance only once the wait has genuinely elapsed.
    if (elapsedMs >= waitHours * 3600_000) {
      return { status: 'ok', counted: false, detail: { waited: true } };
    }
    const remaining = Math.max(
      3600,
      Math.round((waitHours * 3600_000 - elapsedMs) / 1000),
    );
    return {
      status: 'skip',
      advance: false,
      counted: false,
      waitSeconds: Math.min(remaining, 12 * 3600),
    };
  },
};
