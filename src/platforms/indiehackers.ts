import type { PlatformAdapter, FeedItem } from './types.ts';
import { firstVisible, clickIfPresent } from '../browser/selectors.ts';
import { typeLikeHuman, readPage, dwell, sleep, randInt } from '../browser/human.ts';

/**
 * Indie Hackers. Posts to a group, upvotes, and comments.
 *
 * Two things about IH that shape this adapter:
 *  1. It is a small, high-context community where the same few hundred people read
 *     everything. Templated self-promo is spotted instantly and burns the account
 *     permanently. The per-day caps here are the tightest of the four on purpose,
 *     and instructions/indiehackers.md leans on comments over posts.
 *  2. Posting requires choosing a group. `target_ref` on the content row is the
 *     group URL (e.g. .../groups/growth); without one the post goes nowhere useful.
 *
 * IH is a Next.js app with mostly semantic markup, so role/text selectors hold up
 * reasonably well.
 */
export const indiehackers: PlatformAdapter = {
  id: 'indiehackers',
  displayName: 'Indie Hackers',
  homeUrl: 'https://www.indiehackers.com/',
  loginUrl: 'https://www.indiehackers.com/sign-in',
  loggedOutPatterns: /\/sign-in|\/sign-up/,
  checkpointPatterns: /\/challenge|captcha/,
  loggedInSelectors: [
    "a[href*='/@']",
    "img[alt*='avatar' i]",
    "[class*='avatar']",
    "a[href='/new-post']",
  ],

  can: { post: true, dm: false, feed: true, engage: ['upvote', 'comment'] },

  rules: {
    post: { maxChars: 6000, linksAllowed: true, threads: false },
    comment: { maxChars: 1500, linksAllowed: true, threads: false },
  },

  // The tightest caps of the four. IH is small enough that volume reads as spam.
  defaultLimits: {
    post: { perDay: 1, perHour: 1 },
    engage_upvote: { perDay: 15, perHour: 5 },
    engage_comment: { perDay: 4, perHour: 2 },
  },

  sel: {
    newPostButton: [
      'a[href*="/new-post"]',
      'a:has-text("New post")',
      'button:has-text("New post")',
    ],
    postTitleInput: [
      'input[name="title"]',
      'input[placeholder*="title" i]',
      'textarea[placeholder*="title" i]',
    ],
    postBodyEditor: [
      'div[role="textbox"][contenteditable="true"]',
      'textarea[name="body"]',
      'div.ProseMirror',
    ],
    postSubmit: ['button:has-text("Post")', 'button[type="submit"]:not([disabled])'],

    feedPosts: ['article', 'div[class*="feed-item"]', 'li[class*="post"]'],
    feedAuthor: ['a[href^="/"][class*="user"]', 'a[class*="author"]'],
    feedTitle: ['h2 a', 'h3 a', 'a[class*="title"]'],
    upvoteButton: [
      'button[aria-label*="upvote" i]',
      'button[class*="upvote"]',
      'button:has-text("▲")',
    ],
    commentButton: ['a[href*="#comments"]', 'button:has-text("Comment")'],
    commentEditor: ['div[role="textbox"][contenteditable="true"]', 'textarea[placeholder*="comment" i]'],
    commentSubmit: ['button:has-text("Comment")', 'button[type="submit"]:not([disabled])'],
    permalinkAnchor: ['h2 a', 'h3 a', 'a[href*="/post/"]'],
  },

  /**
   * `body` is "Title\n\nBody" — the first line is the post title, the rest is the
   * body. The caller must have navigated to the target group first.
   */
  async post(page, body) {
    const [rawTitle, ...rest] = body.split('\n');
    const title = (rawTitle ?? '').trim();
    const text = rest.join('\n').trim();
    if (!title || !text) {
      return {
        ok: false,
        error: 'Indie Hackers posts need "Title\\n\\nBody" — the first line is the title.',
      };
    }

    if (!(await clickIfPresent(page, this.sel.newPostButton!, 6_000))) {
      await page.goto('https://www.indiehackers.com/new-post', { waitUntil: 'domcontentloaded' });
    }
    await sleep(randInt(1500, 3000));

    const titleInput = await firstVisible(page, this.sel.postTitleInput!, 8_000);
    if (!titleInput) return { ok: false, error: 'post title field not found' };
    await typeLikeHuman(titleInput, title);
    await dwell();

    const editor = await firstVisible(page, this.sel.postBodyEditor!, 8_000);
    if (!editor) return { ok: false, error: 'post body editor not found' };
    await typeLikeHuman(editor, text);
    await dwell();

    if (!(await clickIfPresent(page, this.sel.postSubmit!, 6_000))) {
      return { ok: false, error: 'Post button not clickable (a group may still need to be selected)' };
    }
    await sleep(randInt(2500, 5000));
    return { ok: true, permalink: page.url() };
  },

  async readFeed(page, limit) {
    await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });
    const items: FeedItem[] = [];
    const posts = page.locator(this.sel.feedPosts!.join(', '));

    for (let scroll = 0; scroll < 6 && items.length < limit; scroll++) {
      await readPage(page, 2);
      const count = Math.min(await posts.count().catch(() => 0), limit * 3);

      for (let i = items.length; i < count && items.length < limit; i++) {
        const node = posts.nth(i);
        const excerpt = ((await node.innerText().catch(() => '')) ?? '').trim().slice(0, 700);
        if (!excerpt) continue;
        const href = await node
          .locator(this.sel.permalinkAnchor!.join(', '))
          .first()
          .getAttribute('href')
          .catch(() => null);
        const permalink = href
          ? href.startsWith('http')
            ? href
            : `https://www.indiehackers.com${href}`
          : null;
        const author = await node.locator(this.sel.feedAuthor!.join(', ')).first().innerText().catch(() => null);
        items.push({
          ref: permalink ?? `ih-feed-${excerpt.slice(0, 60)}`,
          author: author?.trim() ?? null,
          excerpt,
          permalink,
          index: i,
        });
      }
    }
    return items;
  },

  async engage(page, item, action, body) {
    const node = page.locator(this.sel.feedPosts!.join(', ')).nth(item.index);
    if (!(await node.isVisible().catch(() => false))) {
      return { ok: false, error: 'feed item no longer on screen' };
    }
    await node.scrollIntoViewIfNeeded().catch(() => {});
    await dwell();

    if (action === 'upvote') {
      const btn = node.locator(this.sel.upvoteButton!.join(', ')).first();
      if (!(await btn.isVisible().catch(() => false))) return { ok: false, error: 'no upvote button' };
      if ((await btn.getAttribute('aria-pressed')) === 'true') return { ok: false, error: 'already upvoted' };
      await btn.click();
      await sleep(randInt(900, 2200));
      return { ok: true };
    }

    if (action === 'comment') {
      if (!body) return { ok: false, error: 'comment requires a body' };
      // On IH a comment happens on the post page, not inline in the feed.
      if (!item.permalink) return { ok: false, error: 'no permalink to open for commenting' };
      await page.goto(item.permalink, { waitUntil: 'domcontentloaded' });
      await readPage(page, 2);

      const editor = await firstVisible(page, this.sel.commentEditor!, 8_000);
      if (!editor) return { ok: false, error: 'comment editor not found on the post page' };
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
