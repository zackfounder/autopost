import { SEL, firstVisible, clickIfPresent, textOf } from '../browser/selectors.ts';
import { readPage, dwell, typeLikeHuman, sleep, randInt } from '../browser/human.ts';
import { fetchProfile } from '../browser/voyager.ts';
import { upsertLead } from '../db/index.ts';
import { parseDegree, publicIdOf, splitName } from '../util/url.ts';
import { renderTemplate, pickVariant, type ActionDef } from './types.ts';

/** Open a profile, scroll it like a reader, and harvest what's on it. */
export const visitProfile: ActionDef = {
  name: 'visit_profile',
  description:
    "Open the lead's profile, read it, and store name/headline/company/location/degree. " +
    'Doubles as the warm-up touch before an invite: a profile view is the cheapest ' +
    'signal you exist. Enriches the lead record for every later step.',
  ratedLimited: true,
  paramsSchema: { dwellPasses: 'number of scroll passes, default 3' },
  async run(ctx) {
    const { page, lead } = ctx;
    await page.goto(lead.profile_url, { waitUntil: 'domcontentloaded' });

    if (/\/checkpoint\/|\/authwall|\/login/.test(page.url())) {
      return { status: 'blocked', advance: false, counted: false, detail: { url: page.url() } };
    }
    if (/unavailable|profile-not-found/i.test(page.url())) {
      return {
        status: 'skip',
        exit: { state: 'excluded', reason: 'profile_unavailable' },
        counted: false,
      };
    }

    await readPage(page, Number(ctx.params.dwellPasses ?? 3));

    const name = await textOf(page, SEL.profileName);
    const headline = await textOf(page, SEL.profileHeadline);
    const location = await textOf(page, SEL.profileLocation);
    const degree = parseDegree(await textOf(page, SEL.degreeBadge));
    const { first, last } = splitName(name);

    // Voyager fills gaps the DOM hides behind lazy-loading. Never load-bearing.
    let company: string | null = null;
    const pid = publicIdOf(lead.profile_url);
    if (pid) {
      const v = await fetchProfile(page, pid).catch(() => null);
      company = v?.company ?? null;
      if (v?.memberUrn) {
        upsertLead({ profile_url: lead.profile_url, member_urn: v.memberUrn });
      }
    }

    upsertLead({
      profile_url: lead.profile_url,
      full_name: name ?? undefined,
      first_name: first ?? undefined,
      last_name: last ?? undefined,
      headline: headline ?? undefined,
      location: location ?? undefined,
      company: company ?? undefined,
      degree,
    });

    ctx.log(`visited ${name ?? lead.profile_url} (${degree})`);
    return { status: 'ok', detail: { name, degree, headline } };
  },
};

/** Send a connection request, optionally with a note. */
export const invite: ActionDef = {
  name: 'invite',
  description:
    'Send a connection request to a 2nd/3rd-degree lead. Optional note (LinkedIn caps ' +
    'the note at 300 characters). Set `note` to a template string, or `noteVariants` ' +
    'to an array — each lead deterministically gets one variant and keeps it. ' +
    'Skips anyone already 1st-degree.',
  degrees: ['2nd', '3rd', 'out', 'unknown'],
  ratedLimited: true,
  paramsSchema: {
    note: 'template string, supports {{first_name}} etc. Omit for a note-less invite',
    noteVariants: 'array of template strings for a stable A/B split',
  },
  async run(ctx) {
    const { page, lead, vars } = ctx;
    await page.goto(lead.profile_url, { waitUntil: 'domcontentloaded' });
    if (/\/checkpoint\/|\/authwall|\/login/.test(page.url())) {
      return { status: 'blocked', advance: false, counted: false };
    }
    await readPage(page, 2);

    const degree = parseDegree(await textOf(page, SEL.degreeBadge));
    if (degree === '1st') {
      upsertLead({ profile_url: lead.profile_url, degree: '1st' });
      ctx.log('already connected, skipping invite');
      return { status: 'skip', counted: false, detail: { reason: 'already_1st' } };
    }

    // The Connect button is top-level on some profiles and buried under "More" on others.
    let clicked = await clickIfPresent(page, SEL.connectButton, 4_000);
    if (!clicked) {
      if (await clickIfPresent(page, SEL.moreActionsButton, 3_000)) {
        await sleep(randInt(500, 1200));
        clicked = await clickIfPresent(page, SEL.connectInMoreMenu, 3_000);
      }
    }
    if (!clicked) {
      ctx.log('no Connect control on this profile');
      return {
        status: 'skip',
        counted: false,
        exit: { state: 'excluded', reason: 'no_connect_button' },
      };
    }

    await dwell();

    const variants = Array.isArray(ctx.params.noteVariants)
      ? (ctx.params.noteVariants as string[])
      : [];
    const rawNote =
      variants.length > 0
        ? pickVariant(variants, lead.lead_id)
        : typeof ctx.params.note === 'string'
          ? ctx.params.note
          : '';
    const note = rawNote ? renderTemplate(rawNote, lead, vars).slice(0, 300) : '';

    if (note) {
      if (await clickIfPresent(page, SEL.addNoteButton, 3_000)) {
        const box = await firstVisible(page, SEL.noteTextarea, 4_000);
        if (box) await typeLikeHuman(box, note, ctx.pacing);
        await dwell();
      } else {
        ctx.log('note requested but LinkedIn offered no note field — sending without');
      }
    }

    const sent = await clickIfPresent(page, SEL.sendInviteButton, 5_000);
    if (!sent) {
      await clickIfPresent(page, SEL.dialogDismiss, 2_000);
      return { status: 'fail', advance: false, counted: false, detail: { reason: 'no_send' } };
    }

    await sleep(randInt(1200, 3000));

    // The weekly-invite wall shows up as a modal instead of an error, so look for it.
    const body = await page.locator('body').innerText().catch(() => '');
    if (/weekly invitation limit|you've reached the weekly/i.test(body)) {
      ctx.log('LinkedIn weekly invitation limit hit — stopping invites for now');
      return {
        status: 'blocked',
        advance: false,
        counted: true,
        waitSeconds: 60 * 60 * 24,
        detail: { reason: 'weekly_invite_limit' },
      };
    }

    ctx.log(`invited ${lead.full_name ?? lead.profile_url}${note ? ' with note' : ''}`);
    return { status: 'ok', detail: { note: note || null } };
  },
};

/**
 * Linked Helper's "Filter contacts out of my network (keep 1st level only)".
 * The gate between "invite sent" and "now message them".
 */
export const filterConnected: ActionDef = {
  name: 'filter_connected',
  description:
    'Gate step. Checks whether the lead has accepted yet. Accepted (1st-degree) leads ' +
    'move on; everyone else waits here and is re-checked. After `giveUpDays` of waiting ' +
    'the lead exits the campaign. Put this between an invite and any message step.',
  ratedLimited: false,
  paramsSchema: {
    recheckHours: 'hours between checks, default 24',
    giveUpDays: 'stop waiting after this many days, default 21',
  },
  async run(ctx) {
    const { page, lead } = ctx;
    await page.goto(lead.profile_url, { waitUntil: 'domcontentloaded' });
    if (/\/checkpoint\/|\/authwall|\/login/.test(page.url())) {
      return { status: 'blocked', advance: false, counted: false };
    }
    await readPage(page, 1);

    const degree = parseDegree(await textOf(page, SEL.degreeBadge));
    upsertLead({ profile_url: lead.profile_url, degree });

    if (degree === '1st') {
      upsertLead({
        profile_url: lead.profile_url,
        connected_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      });
      ctx.log('accepted — moving on');
      return { status: 'ok', counted: false, detail: { degree } };
    }

    // Anchor the give-up clock to the first time this lead reached THIS step, not to
    // when they entered the campaign — otherwise a slow earlier step eats the window.
    const key = `_waiting_since_step_${ctx.step.position}`;
    if (typeof ctx.vars[key] !== 'number') ctx.vars[key] = Date.now();
    const waitingSince = Number(ctx.vars[key]);

    const giveUpDays = Number(ctx.params.giveUpDays ?? 21);
    const waitedDays = (Date.now() - waitingSince) / 86_400_000;
    if (Number.isFinite(waitedDays) && waitedDays > giveUpDays) {
      return {
        status: 'skip',
        counted: false,
        exit: { state: 'excluded', reason: 'invite_never_accepted' },
      };
    }

    const recheck = Number(ctx.params.recheckHours ?? 24) * 3600;
    return { status: 'skip', advance: false, counted: false, waitSeconds: recheck };
  },
};

export const follow: ActionDef = {
  name: 'follow',
  description: "Follow the lead's profile without connecting. A low-cost warm-up touch.",
  ratedLimited: true,
  async run(ctx) {
    const { page, lead } = ctx;
    await page.goto(lead.profile_url, { waitUntil: 'domcontentloaded' });
    await readPage(page, 1);
    let ok = await clickIfPresent(page, SEL.followButton, 4_000);
    if (!ok && (await clickIfPresent(page, SEL.moreActionsButton, 2_500))) {
      await sleep(randInt(400, 1000));
      ok = await clickIfPresent(page, ['div[role="menu"] span:has-text("Follow")'], 2_500);
    }
    return ok
      ? { status: 'ok' }
      : { status: 'skip', counted: false, detail: { reason: 'no_follow_button' } };
  },
};

export const unfollow: ActionDef = {
  name: 'unfollow',
  description: 'Unfollow the lead. Useful for cleaning up a feed after a follow campaign.',
  ratedLimited: true,
  async run(ctx) {
    const { page, lead } = ctx;
    await page.goto(lead.profile_url, { waitUntil: 'domcontentloaded' });
    await readPage(page, 1);
    const ok = await clickIfPresent(page, SEL.unfollowButton, 4_000);
    return ok ? { status: 'ok' } : { status: 'skip', counted: false };
  },
};

/**
 * Housekeeping. LinkedIn counts pending invites against your weekly cap, so
 * withdrawing stale ones buys headroom.
 */
export const withdrawStaleInvites: ActionDef = {
  name: 'withdraw_stale_invites',
  description:
    'Account-level housekeeping (does not target a specific lead). Opens the sent-invitations ' +
    'manager and withdraws invitations older than `olderThanDays`. Pending invites count ' +
    "against LinkedIn's weekly cap, so this buys back headroom.",
  ratedLimited: true,
  paramsSchema: {
    olderThanDays: 'withdraw invites older than this, default 21',
    max: 'maximum to withdraw in one run, default 5',
  },
  async run(ctx) {
    const { page } = ctx;
    await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/sent/', {
      waitUntil: 'domcontentloaded',
    });
    await readPage(page, 2);

    const olderThanDays = Number(ctx.params.olderThanDays ?? 21);
    const max = Number(ctx.params.max ?? 5);
    let withdrawn = 0;

    for (let i = 0; i < max; i++) {
      const card = await firstVisible(page, SEL.pendingInviteCards, 3_000);
      if (!card) break;
      const text = (await card.innerText().catch(() => '')) ?? '';
      const weeks = /(\d+)\s*(w|week)/i.exec(text);
      const months = /(\d+)\s*(mo|month)/i.exec(text);
      const ageDays = months
        ? Number(months[1]) * 30
        : weeks
          ? Number(weeks[1]) * 7
          : 0;
      if (ageDays < olderThanDays) break; // list is newest-first; everything after is younger

      const btn = card.locator('button:has-text("Withdraw")').first();
      if (!(await btn.isVisible().catch(() => false))) break;
      await btn.click();
      await sleep(randInt(600, 1500));
      await clickIfPresent(page, SEL.confirmWithdraw, 3_000);
      await sleep(randInt(1200, 2600));
      withdrawn++;
    }

    ctx.log(`withdrew ${withdrawn} stale invitation(s)`);
    return { status: withdrawn > 0 ? 'ok' : 'skip', counted: withdrawn > 0, detail: { withdrawn } };
  },
};
