import type { Page } from 'playwright';
import type { PlatformAdapter, FeedItem, Invitation, PostComment } from './types.ts';
import { firstVisible, clickIfPresent } from '../browser/selectors.ts';
import { typeLikeHuman, readPage, dwell, sleep, randInt } from '../browser/human.ts';

/**
 * LinkedIn: posting, DMs, and feed engagement. The outreach funnel (invite /
 * filter_connected / message) lives in src/actions/ and shares this account's browser.
 */
export const linkedin: PlatformAdapter = {
  id: 'linkedin',
  displayName: 'LinkedIn',
  homeUrl: 'https://www.linkedin.com/feed/',
  loginUrl: 'https://www.linkedin.com/login',
  loggedOutPatterns: /\/login|\/uas\/login|\/authwall/,
  checkpointPatterns: /\/checkpoint\//,
  loggedInPatterns: /\/feed/,
  loggedInSelectors: [
    'img.global-nav__me-photo',
    "[data-control-name='nav.settings']",
    "button[aria-label*='profile' i]",
    '.global-nav__me',
  ],

  can: { post: true, dm: true, feed: true, engage: ['like', 'comment'] },

  rules: {
    // 3000 is LinkedIn's hard limit. The 6-line cap in BRAND_VOICE.md is a much
    // tighter house rule and is enforced separately by the content gate.
    post: { maxChars: 3000, linksAllowed: true, threads: false, maxLines: 6 },
    dm: { maxChars: 1900, linksAllowed: true, threads: false },
    comment: { maxChars: 1200, linksAllowed: false, threads: false },
  },

  defaultLimits: {
    post: { perDay: 1, perHour: 1 },
    dm: { perDay: 20, perHour: 5 },
    engage_like: { perDay: 30, perHour: 8 },
    engage_comment: { perDay: 8, perHour: 3 },
    // Targeted actions. Deliberately tighter than the feed equivalents: choosing
    // a specific person's post to react to, over and over, is a far more legible
    // pattern than drifting down a feed.
    react_post: { perDay: 20, perHour: 6 },
    comment_post: { perDay: 8, perHour: 3 },
    repost: { perDay: 3, perHour: 1 },
    follow: { perDay: 15, perHour: 5 },
    visit_profile: { perDay: 40, perHour: 10 },
    accept_invite: { perDay: 25, perHour: 10 },
    withdraw_invite: { perDay: 20, perHour: 20 },
    reply_comment: { perDay: 20, perHour: 8 },
  },

  sel: {
    startPost: [
      'button.share-box-feed-entry__trigger',
      'button:has-text("Start a post")',
      'div.share-box-feed-entry__top-bar button',
    ],
    postEditor: [
      'div.ql-editor[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[data-placeholder][contenteditable="true"]',
    ],
    postSubmit: [
      'div.share-box_actions button.share-actions__primary-action',
      'button:has-text("Post"):not([disabled])',
    ],
    postedToast: ['div[role="alert"]:has-text("Post successful")', 'a:has-text("View post")'],

    feedPosts: ['div.feed-shared-update-v2', 'div[data-id^="urn:li:activity"]'],
    feedPostText: ['div.update-components-text', 'span.break-words'],
    feedPostAuthor: ['span.update-components-actor__title', 'a.update-components-actor__meta-link'],
    likeButton: ['button[aria-label^="React Like"]', 'button.react-button__trigger'],
    commentButton: ['button[aria-label^="Comment"]'],
    commentEditor: ['div.comments-comment-box div[role="textbox"]', 'div.ql-editor[contenteditable="true"]'],
    commentSubmit: ['button.comments-comment-box__submit-button', 'button:has-text("Post"):not([disabled])'],

    /* Targeted actions, on a post or profile you name. */
    // The reactions flyout only exists after hovering Like. Its buttons are
    // labelled with the reaction name, which is the one stable handle here.
    reactionsFlyout: ['div.reactions-menu', 'div[role="menu"]:has(button[aria-label*="Celebrate" i])'],
    repostButton: ['button[aria-label^="Repost" i]', 'button:has-text("Repost")', 'button[aria-label^="Share" i]'],
    repostNow: ['div[role="menu"] :text-is("Repost")', 'div[role="menu"] span:has-text("Repost")'],
    repostWithThoughts: [
      'div[role="menu"] :text-is("Repost with your thoughts")',
      'div[role="menu"] span:has-text("Repost with your thoughts")',
    ],
    followButton: ['main button[aria-label^="Follow" i]', 'main button:has-text("Follow")'],
    followingState: ['main button[aria-label^="Following" i]', 'main button[aria-label^="Unfollow" i]'],
    profileName: ['main h1'],
    profileHeadline: ['main div.text-body-medium'],

    invitationCard: [
      'div[data-view-name="invitation-card"]',
      'li.invitation-card',
      'div.invitation-card',
      'li:has(button[aria-label^="Accept" i])',
    ],
    acceptInvite: ['button[aria-label^="Accept" i]'],
    withdrawInvite: ['button[aria-label*="Withdraw" i]', 'button:has-text("Withdraw")'],
    sentInviteCard: ['li:has(button[aria-label*="Withdraw" i])', 'div.invitation-card'],

    myPostLinks: ['a[href*="/feed/update/urn:li:activity"]'],
    commentItem: ['article.comments-comment-entity', 'article.comments-comment-item', 'div.comments-comment-item'],
    commentAuthor: ['span.comments-comment-meta__description-title', '.comments-post-meta__name-text'],
    commentText: ['div.comments-comment-item__main-content', 'span.comments-comment-item__main-content'],
    commentReplyButton: ['button[aria-label*="Reply" i]', 'button:has-text("Reply")'],
    loadMoreComments: ['button:has-text("Load more comments")', 'button[aria-label*="more comments" i]'],
  },

  /**
   * Publish a post.
   *
   * `opts.composerUrl` is where the composer actually opens for this account.
   * The feed's own "Start a post" opens a modal whose contents never load for
   * an automated browser — the dialog renders as "This is a modal window" with
   * no editor inside it, headed or headless. A company page's admin view opens
   * a real one, already authored as the page, which also removes the need to
   * drive the author picker at all.
   *
   * LinkedIn has moved to hashed class names, so every handle here is text or
   * an aria-label. Expect this to need re-checking, not to hold forever.
   */
  async post(page, body, opts) {
    const o = opts as { composerUrl?: string; postAs?: string } | undefined;

    // FAIL CLOSED. A page post with no page composer must never fall back to
    // the feed, because the feed composer posts as the PERSON.
    //
    // This exact fallback published a company post on the founder's own profile
    // on 2026-08-14: the rail asked for a page post by passing postAs, this
    // ignored it, opened the feed, and posted as him. The gate had done its job
    // — the deliverable was correctly ruled 'linkedin_company' — and the browser
    // layer undid it silently. His own profile is the one surface that always
    // needs his approval, so getting here by accident is the worst bug this
    // system can have.
    if (o?.postAs && !o?.composerUrl) {
      return {
        ok: false,
        error: `refusing to post: this is meant to go out as "${o.postAs}" but no page composer URL was given, `
          + 'and the fallback would publish it on the personal profile',
      };
    }

    const entry = o?.composerUrl ?? this.homeUrl;
    await page.goto(entry, { waitUntil: 'domcontentloaded' });
    await readPage(page, 2);

    // Exact text first. `has-text` matches any ancestor containing the phrase,
    // so on the admin page it selected an outer container whose click opened a
    // different, empty modal — the composer looked broken when the wrong thing
    // had been opened.
    const trigger = await firstVisible(page, [
      ':text-is("Start a post")',
      'div[role="button"]:has-text("Start a post")',
      'button:has-text("Start a post")',
    ], 10_000);
    if (!trigger) return { ok: false, error: 'could not find "Start a post"' };
    await trigger.click();
    await sleep(randInt(4000, 6000));

    // Several editors match; only one is on screen.
    const editor = await firstVisible(page, [
      '[role="dialog"] [contenteditable="true"][aria-label*="Text editor" i]',
      '[contenteditable="true"][aria-label*="Text editor" i]',
      '[role="dialog"] [contenteditable="true"]',
    ], 12_000);
    if (!editor) {
      return { ok: false, error: 'the composer opened but no editor loaded inside it' };
    }

    await editor.click();
    await typeLikeHuman(editor, body);
    await dwell();

    // The button's label is exactly "Post". Matching on `has-text` would also
    // catch "Post to Anyone" (the audience picker) and post nothing; matching
    // too narrowly missed it entirely. Filter the dialog's buttons on the exact
    // trimmed label, and take the last, which is the primary action.
    const submit = page.locator('[role="dialog"] button')
      // The anchors matter and so does the whitespace: hasText does not trim,
      // and the button's raw text is "\n  Post\n", so /^Post$/ matched nothing
      // while the button sat there enabled. Without the anchors this would also
      // match "Post to Anyone", the audience picker, and publish nothing.
      .filter({ hasText: /^\s*Post\s*$/ }).last();
    if (!(await submit.isVisible({ timeout: 10_000 }).catch(() => false))) {
      return { ok: false, error: 'no Post button in the composer' };
    }
    await submit.click();

    // LinkedIn closes the composer when it accepts. Unlike X, it does not leave
    // it open on success — verified against a real post.
    for (let waited = 0; waited < 20_000; waited += 1_000) {
      await sleep(1_000);
      const open = await page.locator('[role="dialog"]').first().isVisible({ timeout: 500 }).catch(() => false);
      if (!open) return { ok: true };
    }
    return { ok: false, error: 'LinkedIn did not accept it — the composer never closed' };
  },

  /**
   * Delete one of this page's posts, found by its text.
   *
   * LinkedIn permalinks are opaque urn ids that the composer never hands back,
   * so there is no id to keep. Matching on the text of a post we just published
   * is the honest way in — and the control menu only offers Delete on a post
   * this account owns, which is the ownership check.
   */
  async deletePost(page, needle, opts) {
    // Where this account's own posts are listed. A page has a posts tab; a
    // person has their activity feed. There is no permalink to go to because
    // LinkedIn never hands one back.
    const listing = opts?.listingUrl
      ?? 'https://www.linkedin.com/in/me/recent-activity/all/';
    await page.goto(listing, { waitUntil: 'domcontentloaded' });
    await readPage(page, 2);

    const post = page.locator('div').filter({ hasText: needle }).last();
    if (!(await post.isVisible({ timeout: 8_000 }).catch(() => false))) {
      return { ok: false, error: 'could not find that post on the page' };
    }

    const menu = await firstVisible(page, [
      'button[aria-label*="Open control menu" i]',
      'button[aria-label*="More" i]',
    ], 8_000);
    if (!menu) return { ok: false, error: 'no control menu on the post' };
    await menu.click();
    await sleep(randInt(800, 1500));

    const del = await firstVisible(page, [
      'div[role="menuitem"]:has-text("Delete")',
      'span:text-is("Delete post")',
      ':text-is("Delete post")',
    ], 5_000);
    if (!del) return { ok: false, error: 'no Delete in the menu — this post is not ours' };
    await del.click();
    await sleep(randInt(700, 1300));

    const confirm = page.locator('button').filter({ hasText: /^\s*Delete\s*$/ }).last();
    if (!(await confirm.isVisible({ timeout: 5_000 }).catch(() => false))) {
      return { ok: false, error: 'delete confirmation never appeared' };
    }
    await confirm.click();
    await sleep(randInt(3000, 5000));

    // Proof: reload the listing and look again.
    await page.goto(listing, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(6_000);
    const body = await page.innerText('body').catch(() => '');
    return body.includes(needle)
      ? { ok: false, error: 'the post is still on the page' }
      : { ok: true };
  },

  async dm(page, target, body) {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await readPage(page, 1);

    if (!(await clickIfPresent(page, ['main button[aria-label^="Message"]'], 6_000))) {
      return { ok: false, error: 'no Message button (not a 1st-degree connection?)' };
    }
    await sleep(randInt(1200, 2600));

    const composer = await firstVisible(
      page,
      ['div.msg-form__contenteditable[contenteditable="true"]', 'div[role="textbox"][contenteditable="true"]'],
      8_000,
    );
    if (!composer) return { ok: false, error: 'message composer not found' };

    await typeLikeHuman(composer, body);
    await dwell();

    if (!(await clickIfPresent(page, ['button.msg-form__send-button'], 5_000))) {
      return { ok: false, error: 'Send button not clickable' };
    }
    await sleep(randInt(1500, 3200));
    return { ok: true };
  },

  async readFeed(page, limit) {
    await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });
    const items: FeedItem[] = [];
    const posts = page.locator(this.sel.feedPosts!.join(', '));

    for (let scroll = 0; scroll < 6 && items.length < limit; scroll++) {
      await readPage(page, 2);
      const count = Math.min(await posts.count().catch(() => 0), limit * 2);

      for (let i = items.length; i < count && items.length < limit; i++) {
        const node = posts.nth(i);
        const excerpt = ((await node.innerText().catch(() => '')) ?? '').trim().slice(0, 600);
        if (!excerpt) continue;
        const ref = (await node.getAttribute('data-id').catch(() => null)) ?? `li-feed-${i}-${excerpt.slice(0, 40)}`;
        const author = await node
          .locator(this.sel.feedPostAuthor!.join(', '))
          .first()
          .innerText()
          .catch(() => null);
        items.push({ ref, author: author?.trim() ?? null, excerpt, permalink: null, index: i });
      }
    }
    return items;
  },

  async engage(page, item, action, body) {
    const node = page.locator(this.sel.feedPosts!.join(', ')).nth(item.index);
    if (!(await node.isVisible().catch(() => false))) {
      return { ok: false, error: 'feed item no longer on screen — the feed reflowed' };
    }
    await node.scrollIntoViewIfNeeded().catch(() => {});
    await dwell();

    if (action === 'like') {
      const btn = node.locator(this.sel.likeButton!.join(', ')).first();
      if (!(await btn.isVisible().catch(() => false))) return { ok: false, error: 'no Like button' };
      if ((await btn.getAttribute('aria-pressed')) === 'true') {
        return { ok: false, error: 'already liked' };
      }
      await btn.click();
      await sleep(randInt(900, 2200));
      return { ok: true };
    }

    if (action === 'comment') {
      if (!body) return { ok: false, error: 'comment requires a body' };
      const btn = node.locator(this.sel.commentButton!.join(', ')).first();
      if (!(await btn.isVisible().catch(() => false))) return { ok: false, error: 'no Comment button' };
      await btn.click();
      await sleep(randInt(1200, 2600));

      const editor = await firstVisible(page, this.sel.commentEditor!, 6_000);
      if (!editor) return { ok: false, error: 'comment editor not found' };
      await typeLikeHuman(editor, body);
      await dwell();
      if (!(await clickIfPresent(page, this.sel.commentSubmit!, 5_000))) {
        return { ok: false, error: 'comment submit not clickable' };
      }
      await sleep(randInt(1500, 3000));
      return { ok: true };
    }

    return { ok: false, error: `unsupported action ${action}` };
  },

  /* ── Targeted actions ─────────────────────────────────────────────────────
   *
   * Everything above is feed work, which means LinkedIn picks what this account
   * sees. Everything below acts on a URL you named.
   */

  /**
   * React to a post. `like` is one click; the other five live in a flyout that
   * only renders on hover, so they need the hover first and a real pause after
   * it — the menu animates in and a click sent too early lands on the Like
   * button underneath, which is a like, not the reaction that was asked for.
   */
  async reactToPost(page, url, reaction) {
    if (!(await openPost(page, url))) return { ok: false, error: 'could not open that post' };

    const like = await firstVisible(page, [
      'main button[aria-label^="React Like" i]',
      'main button.react-button__trigger',
      'button[aria-label^="React Like" i]',
    ], 10_000);
    if (!like) return { ok: false, error: 'no reaction button on that post' };

    // Reacting twice removes the reaction. Refuse rather than silently undo one.
    if ((await like.getAttribute('aria-pressed').catch(() => null)) === 'true') {
      return { ok: false, error: 'this account has already reacted to that post' };
    }

    if (reaction === 'like') {
      await like.click();
    } else {
      await like.hover();
      await sleep(randInt(1200, 2000));
      const choice = await firstVisible(page, [
        `button[aria-label*="${reaction}" i]`,
        `div.reactions-menu button[aria-label*="${reaction}" i]`,
      ], 5_000);
      if (!choice) return { ok: false, error: `the reactions flyout never offered "${reaction}"` };
      await choice.click();
    }

    await sleep(randInt(1500, 2800));
    const pressed = await like.getAttribute('aria-pressed').catch(() => null);
    return pressed === 'true'
      ? { ok: true }
      : { ok: false, error: 'clicked, but LinkedIn never marked the post as reacted to' };
  },

  /** Comment on a post by permalink. The body has already passed the gate. */
  async commentOnPost(page, url, body) {
    if (!(await openPost(page, url))) return { ok: false, error: 'could not open that post' };

    // The comment box is sometimes already open on a permalink page, in which
    // case clicking Comment collapses it again.
    let editor = await firstVisible(page, this.sel.commentEditor!, 2_000);
    if (!editor) {
      if (!(await clickIfPresent(page, ['main ' + this.sel.commentButton![0], ...this.sel.commentButton!], 8_000))) {
        return { ok: false, error: 'no Comment button on that post' };
      }
      await sleep(randInt(1200, 2400));
      editor = await firstVisible(page, this.sel.commentEditor!, 8_000);
    }
    if (!editor) return { ok: false, error: 'comment editor never loaded' };

    await editor.click();
    await typeLikeHuman(editor, body);
    await dwell();

    if (!(await clickIfPresent(page, this.sel.commentSubmit!, 6_000))) {
      return { ok: false, error: 'comment submit not clickable' };
    }
    await sleep(randInt(2500, 4000));

    // Proof: the comment's own words are on the page now.
    const needle = body.slice(0, 40);
    const landed = (await page.innerText('body').catch(() => '')).includes(needle);
    return landed ? { ok: true } : { ok: false, error: 'submitted, but the comment is not on the page' };
  },

  /**
   * Share a post to your own feed. With `thought` this opens the composer and
   * publishes an edited share; without it, it is the one-click repost.
   */
  async repost(page, url, thought) {
    if (!(await openPost(page, url))) return { ok: false, error: 'could not open that post' };

    if (!(await clickIfPresent(page, this.sel.repostButton!, 8_000))) {
      return { ok: false, error: 'no Repost button on that post' };
    }
    await sleep(randInt(1000, 2000));

    const which = thought ? this.sel.repostWithThoughts! : this.sel.repostNow!;
    const option = await firstVisible(page, which, 6_000);
    if (!option) {
      return { ok: false, error: `the repost menu never offered "${thought ? 'with your thoughts' : 'Repost'}"` };
    }
    await option.click();

    if (!thought) {
      await sleep(randInt(2500, 4000));
      return { ok: true };
    }

    const editor = await firstVisible(page, [
      '[role="dialog"] [contenteditable="true"][aria-label*="Text editor" i]',
      '[role="dialog"] [contenteditable="true"]',
    ], 12_000);
    if (!editor) return { ok: false, error: 'the repost composer opened with no editor in it' };

    await editor.click();
    await typeLikeHuman(editor, thought);
    await dwell();

    // Same exact-label rule as post(): `has-text` also matches "Post to Anyone".
    const submit = page.locator('[role="dialog"] button').filter({ hasText: /^\s*Post\s*$/ }).last();
    if (!(await submit.isVisible({ timeout: 8_000 }).catch(() => false))) {
      return { ok: false, error: 'no Post button in the repost composer' };
    }
    await submit.click();

    for (let waited = 0; waited < 20_000; waited += 1_000) {
      await sleep(1_000);
      const open = await page.locator('[role="dialog"]').first().isVisible({ timeout: 500 }).catch(() => false);
      if (!open) return { ok: true };
    }
    return { ok: false, error: 'LinkedIn did not accept the repost — the composer never closed' };
  },

  /** Follow a person or company page without sending a connection request. */
  async follow(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await readPage(page, 2);

    const already = await firstVisible(page, this.sel.followingState!, 2_000);
    if (already) return { ok: false, error: 'already following' };

    const btn = await firstVisible(page, this.sel.followButton!, 8_000);
    if (!btn) return { ok: false, error: 'no Follow button (it can sit under "More")' };
    await btn.click();
    await sleep(randInt(1800, 3200));

    const confirmed = await firstVisible(page, this.sel.followingState!, 6_000);
    return confirmed ? { ok: true } : { ok: false, error: 'clicked Follow but the button never changed state' };
  },

  /**
   * Open a profile and read it.
   *
   * The read is incidental. The visit IS the action: LinkedIn tells the other
   * person you looked, which is why Linked Helper has it as a campaign step at
   * all. So this dwells like a person reading rather than loading and leaving.
   */
  async visitProfile(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await readPage(page, 3);
    await dwell();

    const name = await page.locator(this.sel.profileName!.join(', ')).first().innerText().catch(() => null);
    const headline = await page.locator(this.sel.profileHeadline!.join(', ')).first().innerText().catch(() => null);

    // An authwall renders a page with no name on it, and reporting that as a
    // successful visit hides a logged-out session behind a green tick.
    if (!name) return { ok: false, url, name: null, headline: null, error: 'no profile rendered — logged out, or the profile is gone' };
    return { ok: true, url, name: name.trim(), headline: headline?.trim() ?? null };
  },

  /** Pending incoming connection requests. */
  async listInvitations(page, limit) {
    await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/', { waitUntil: 'domcontentloaded' });
    await readPage(page, 2);

    const cards = page.locator(this.sel.invitationCard!.join(', '));
    const count = Math.min(await cards.count().catch(() => 0), limit);
    const out: Invitation[] = [];

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const raw = ((await card.innerText().catch(() => '')) ?? '').trim();
      if (!raw) continue;
      const [first = '', second = ''] = raw.split('\n').map((l) => l.trim()).filter(Boolean);
      out.push({ ref: `${first}|${raw.slice(0, 40)}`, name: first || null, headline: second || null, index: i });
    }
    return out;
  },

  /**
   * Accept one pending request.
   *
   * Matched by name, never by index: accepting removes the card, so every index
   * below it shifts, and a loop over indices accepts strangers.
   */
  async acceptInvitation(page, invitation) {
    if (!page.url().includes('invitation-manager')) {
      await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/', { waitUntil: 'domcontentloaded' });
      await readPage(page, 2);
    }

    const card = invitation.name
      ? page.locator(this.sel.invitationCard!.join(', ')).filter({ hasText: invitation.name }).first()
      : page.locator(this.sel.invitationCard!.join(', ')).nth(invitation.index);

    if (!(await card.isVisible({ timeout: 6_000 }).catch(() => false))) {
      return { ok: false, error: 'that invitation is no longer listed' };
    }

    const accept = card.locator(this.sel.acceptInvite!.join(', ')).first();
    if (!(await accept.isVisible({ timeout: 4_000 }).catch(() => false))) {
      return { ok: false, error: 'no Accept button on that invitation' };
    }
    await accept.click();
    await sleep(randInt(1500, 3000));
    return { ok: true };
  },

  /**
   * Withdraw invitations that were never answered.
   *
   * LinkedIn counts outstanding invites against a weekly cap no tool can raise,
   * so an invite sent three months ago to someone who never replied is quota
   * being paid for and not used. Age comes from the card's own "Sent 2 months
   * ago" text — there is no timestamp attribute to read.
   */
  async withdrawStaleInvitations(page, olderThanDays, max) {
    await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/sent/', { waitUntil: 'domcontentloaded' });
    await readPage(page, 2);

    let withdrawn = 0;
    for (let round = 0; round < max; round++) {
      const cards = page.locator(this.sel.sentInviteCard!.join(', '));
      const count = await cards.count().catch(() => 0);
      if (count === 0) break;

      let target: number | null = null;
      for (let i = 0; i < count; i++) {
        const raw = ((await cards.nth(i).innerText().catch(() => '')) ?? '');
        if (ageInDays(raw) >= olderThanDays) { target = i; break; }
      }
      // The list is newest first, so once nothing is old enough, nothing below is.
      if (target === null) break;

      const card = cards.nth(target);
      const button = card.locator(this.sel.withdrawInvite!.join(', ')).first();
      if (!(await button.isVisible({ timeout: 4_000 }).catch(() => false))) break;
      await button.click();
      await sleep(randInt(800, 1600));

      // LinkedIn asks again in a dialog whose confirm button is also "Withdraw".
      const confirm = page.locator('[role="dialog"] button').filter({ hasText: /^\s*Withdraw\s*$/ }).last();
      if (await confirm.isVisible({ timeout: 4_000 }).catch(() => false)) {
        await confirm.click();
      }
      withdrawn++;
      await sleep(randInt(2000, 3500));
    }
    return { ok: true, withdrawn };
  },

  /** Posts this account published, newest first. */
  async myRecentPosts(page, limit) {
    await page.goto('https://www.linkedin.com/in/me/recent-activity/all/', { waitUntil: 'domcontentloaded' });
    await readPage(page, 3);

    const links = page.locator(this.sel.myPostLinks!.join(', '));
    const count = Math.min(await links.count().catch(() => 0), limit * 3);
    const seen = new Set<string>();
    const out: { url: string; excerpt: string }[] = [];

    for (let i = 0; i < count && out.length < limit; i++) {
      const href = await links.nth(i).getAttribute('href').catch(() => null);
      if (!href) continue;
      const url = href.startsWith('http') ? href : `https://www.linkedin.com${href}`;
      // The same activity is linked several times per card (author, timestamp, image).
      const id = /urn:li:activity:(\d+)/.exec(url)?.[1] ?? url;
      if (seen.has(id)) continue;
      seen.add(id);
      const excerpt = ((await links.nth(i).locator('xpath=ancestor::div[3]').first().innerText().catch(() => '')) ?? '')
        .trim().slice(0, 300);
      out.push({ url, excerpt });
    }
    return out;
  },

  /** Comments under one of your posts. */
  async readPostComments(page, postUrl, limit) {
    if (!(await openPost(page, postUrl))) return [];

    // Comments load behind "Load more", and the newest are not always shown first.
    for (let i = 0; i < 2; i++) {
      if (!(await clickIfPresent(page, this.sel.loadMoreComments!, 3_000))) break;
      await sleep(randInt(1500, 2500));
    }

    const nodes = page.locator(this.sel.commentItem!.join(', '));
    const count = Math.min(await nodes.count().catch(() => 0), limit);
    const out: PostComment[] = [];

    for (let i = 0; i < count; i++) {
      const node = nodes.nth(i);
      const author = await node.locator(this.sel.commentAuthor!.join(', ')).first().innerText().catch(() => null);
      const body = await node.locator(this.sel.commentText!.join(', ')).first().innerText().catch(() => null);
      const raw = (body ?? (await node.innerText().catch(() => '')) ?? '').trim();
      if (!raw) continue;
      out.push({
        ref: `${(author ?? 'unknown').trim()}|${raw.slice(0, 60)}`,
        author: author?.trim() ?? null,
        text: raw.slice(0, 800),
        index: i,
        // A reply nests inside the same article, so the author's own name
        // appearing again below the comment means it was already answered.
        answered: false,
      });
    }
    return out;
  },

  /** Reply to one comment under your post. */
  async replyToComment(page, postUrl, comment, body) {
    if (!page.url().includes(postUrl.slice(-20))) {
      if (!(await openPost(page, postUrl))) return { ok: false, error: 'could not open that post' };
    }

    // Matched on the comment's own text, not its index: comments load lazily and
    // reorder, and replying to the wrong person in public is not recoverable.
    const node = page.locator(this.sel.commentItem!.join(', '))
      .filter({ hasText: comment.text.slice(0, 40) })
      .first();
    if (!(await node.isVisible({ timeout: 6_000 }).catch(() => false))) {
      return { ok: false, error: 'that comment is no longer on the page' };
    }

    const replyBtn = node.locator(this.sel.commentReplyButton!.join(', ')).first();
    if (!(await replyBtn.isVisible({ timeout: 4_000 }).catch(() => false))) {
      return { ok: false, error: 'no Reply button on that comment' };
    }
    await replyBtn.click();
    await sleep(randInt(1200, 2400));

    const editor = await firstVisible(page, this.sel.commentEditor!, 8_000);
    if (!editor) return { ok: false, error: 'reply editor never loaded' };
    await editor.click();
    await typeLikeHuman(editor, body);
    await dwell();

    if (!(await clickIfPresent(page, this.sel.commentSubmit!, 6_000))) {
      return { ok: false, error: 'reply submit not clickable' };
    }
    await sleep(randInt(2500, 4000));

    const landed = (await page.innerText('body').catch(() => '')).includes(body.slice(0, 40));
    return landed ? { ok: true } : { ok: false, error: 'submitted, but the reply is not on the page' };
  },
};

/**
 * Open a post permalink and confirm something rendered.
 *
 * LinkedIn answers a logged-out or expired session with an authwall that still
 * returns 200, so "the page loaded" proves nothing. A post body on screen does.
 */
async function openPost(page: Page, url: string): Promise<boolean> {
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await readPage(page, 2);
  if (/\/authwall|\/login/.test(page.url())) return false;
  const body = await firstVisible(page, [
    'div.feed-shared-update-v2',
    'div[data-id^="urn:li:activity"]',
    'main article',
  ], 8_000);
  return body !== null;
}

/**
 * Days since an invitation was sent, from the card's own wording.
 *
 * Returns 0 when it cannot tell — an unparsed card must never look old enough
 * to withdraw, because withdrawing a fresh invite wastes the weekly quota it
 * was meant to protect.
 */
export function ageInDays(cardText: string): number {
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i.exec(cardText);
  if (!m) return 0;
  const n = Number(m[1]);
  switch (m[2]!.toLowerCase()) {
    case 'second':
    case 'minute':
    case 'hour': return 0;
    case 'day': return n;
    case 'week': return n * 7;
    case 'month': return n * 30;
    case 'year': return n * 365;
    default: return 0;
  }
}
