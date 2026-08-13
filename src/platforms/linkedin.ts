import type { PlatformAdapter, FeedItem } from './types.ts';
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
    const entry = (opts as { composerUrl?: string } | undefined)?.composerUrl ?? this.homeUrl;
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
  async deletePost(page, needle) {
    const listing = (this as unknown as { _postsUrl?: string })._postsUrl
      ?? 'https://www.linkedin.com/company/meetcrewapp/posts/';
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
};
