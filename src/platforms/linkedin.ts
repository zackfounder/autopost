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

  async post(page, body, opts) {
    await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });
    await readPage(page, 2);

    if (!(await clickIfPresent(page, this.sel.startPost!, 6_000))) {
      return { ok: false, error: 'could not open the composer' };
    }
    await sleep(randInt(1200, 2600));

    // Same account, different author. The composer opens as the person; a page
    // post means switching the author first, and the page here is "Crew".
    if (opts?.postAs) {
      const picker = await firstVisible(page, [
        'button[aria-label*="Post as"]',
        'button[aria-label*="Select who can see"]',
        '.share-box__actor-selector button',
        'button:has(.share-box-feed-entry__actor-name)',
      ], 5_000);
      if (!picker) {
        return { ok: false, error: 'could not find the author selector — cannot post as a page' };
      }
      await picker.click();
      await sleep(randInt(700, 1400));

      const option = await firstVisible(page, [
        `[role="radio"]:has-text("${opts.postAs}")`,
        `[role="option"]:has-text("${opts.postAs}")`,
        `li:has-text("${opts.postAs}") input[type="radio"]`,
        `label:has-text("${opts.postAs}")`,
      ], 5_000);
      if (!option) {
        return { ok: false, error: `no page named "${opts.postAs}" in the author list — check the exact page name` };
      }
      await option.click();
      await sleep(randInt(500, 1100));
      await clickIfPresent(page, ['button:has-text("Done")', 'button:has-text("Save")'], 3_000);
      await sleep(randInt(600, 1200));
    }

    const editor = await firstVisible(page, this.sel.postEditor!, 8_000);
    if (!editor) return { ok: false, error: 'composer editor not found' };

    await typeLikeHuman(editor, body);
    await dwell();

    if (!(await clickIfPresent(page, this.sel.postSubmit!, 6_000))) {
      return { ok: false, error: 'Post button not clickable (LinkedIn often disables it until the editor registers input)' };
    }
    await sleep(randInt(2500, 5000));

    const link = await firstVisible(page, this.sel.postedToast!, 6_000);
    const permalink = link ? ((await link.getAttribute('href')) ?? undefined) : undefined;
    return { ok: true, permalink: permalink ?? undefined };
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
