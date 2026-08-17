import type { Page } from 'playwright';
import type { PlatformAdapter, FeedItem } from './types.ts';
import { firstVisible, clickIfPresent } from '../browser/selectors.ts';
import { typeLikeHuman, readPage, dwell, sleep, randInt } from '../browser/human.ts';
import { splitThread } from './x.ts';

/**
 * Bluesky.
 *
 * The easiest of the three to automate and the one least likely to break, for a
 * reason worth knowing: the client is open source and ships `data-testid` on
 * everything, because its own end-to-end tests depend on those attributes. They
 * are load-bearing for the Bluesky team too, which is the only kind of selector
 * that survives a redesign.
 *
 * It is also the friendliest of the three about automation — there is a real
 * public API and no adversarial relationship with tooling. This adapter still
 * goes through the browser because that is what the rest of the engine is: one
 * session, one set of rate limits, one audit trail. If you want the API, the
 * honest answer is that `@atproto/api` is a better fit than this file.
 *
 * 300 graphemes, not characters. An emoji is one grapheme and several chars, so
 * a body that measures 300 in JavaScript can still be under the real limit — the
 * gate uses the stricter of the two, which is the safe direction to be wrong in.
 */
export const bluesky: PlatformAdapter = {
  id: 'bluesky',
  displayName: 'Bluesky',
  homeUrl: 'https://bsky.app/',
  loginUrl: 'https://bsky.app/',
  loggedOutPatterns: /\/(login|signin)\b/,
  checkpointPatterns: /\/2fa|\/verify/,
  // bsky.app keeps you on / whether you are signed in or not, so the URL says
  // nothing. Only the DOM can answer, which is what loggedInSelectors is for.
  loggedInSelectors: [
    '[data-testid="homeScreenFeedTabs"]',
    '[data-testid="composeFAB"]',
    '[data-testid="bottomBarHomeBtn"]',
    '[data-testid="profileHeaderDisplayName"]',
  ],

  can: { post: true, dm: false, feed: true, engage: ['like', 'comment'] },

  rules: {
    post: { maxChars: 300, linksAllowed: true, threads: true },
    comment: { maxChars: 300, linksAllowed: true, threads: false },
  },

  defaultLimits: {
    post: { perDay: 6, perHour: 3 },
    engage_like: { perDay: 50, perHour: 15 },
    engage_comment: { perDay: 12, perHour: 4 },
    follow: { perDay: 30, perHour: 10 },
    react_post: { perDay: 50, perHour: 15 },
    comment_post: { perDay: 12, perHour: 4 },
    reply_comment: { perDay: 20, perHour: 8 },
  },

  sel: {
    composerTrigger: ['[data-testid="composeFAB"]', 'button[aria-label="New post"]'],
    composerEditor: [
      '[data-testid="composerTextInput"]',
      'div[role="textbox"][contenteditable="true"]',
    ],
    composerSubmit: ['[data-testid="composerPublishBtn"]', 'button[aria-label="Publish post"]'],
    addThreadItem: ['[data-testid="addQuoteBtn"]', 'button[aria-label="Add new post"]'],

    feedPosts: ['[data-testid^="feedItem-by-"]', 'div[role="link"][tabindex="0"]'],
    feedPostText: ['[data-testid="postText"]'],
    feedPostAuthor: ['[data-testid="postAuthorName"]', 'a[href^="/profile/"]'],
    likeButton: ['[data-testid="likeBtn"]'],
    commentButton: ['[data-testid="replyBtn"]'],
    commentEditor: ['[data-testid="composerTextInput"]'],
    commentSubmit: ['[data-testid="composerPublishBtn"]'],

    followButton: ['[data-testid="followBtn"]', 'button[aria-label^="Follow"]'],
    followingState: ['[data-testid="unfollowBtn"]', 'button[aria-label^="Unfollow"]'],
    profileName: ['[data-testid="profileHeaderDisplayName"]'],
    profileHeadline: ['[data-testid="profileHeaderDescription"]'],

    postDropdown: ['[data-testid="postDropdownBtn"]'],
    deleteMenuItem: ['[data-testid="postDropdownDeleteBtn"]', '[role="menuitem"]:has-text("Delete")'],
    confirmDelete: ['[data-testid="confirmBtn"]', 'button:has-text("Delete")'],
  },

  /**
   * Publish a post, or a thread when the body is numbered `1/`, `2/`.
   *
   * Threading reuses X's splitter deliberately: a numbered body means the same
   * thing on both, and two implementations of the same rule drift.
   */
  async post(page, body) {
    await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });
    await readPage(page, 2);

    if (!(await clickIfPresent(page, this.sel.composerTrigger!, 10_000))) {
      return { ok: false, error: 'could not open the composer' };
    }
    await sleep(randInt(1200, 2400));

    const editor = await firstVisible(page, this.sel.composerEditor!, 10_000);
    if (!editor) return { ok: false, error: 'the composer opened but no editor loaded' };

    const parts = splitThread(body);
    await editor.click();
    await typeLikeHuman(editor, parts[0]!);
    await dwell();

    for (let i = 1; i < parts.length; i++) {
      if (!(await clickIfPresent(page, this.sel.addThreadItem!, 5_000))) {
        return { ok: false, error: `could not add thread item ${i + 1}` };
      }
      await sleep(randInt(800, 1800));
      // Each added post gets its own editor; the newest is the last one rendered.
      const editors = page.locator(this.sel.composerEditor!.join(', '));
      const next = editors.nth(await editors.count() - 1);
      if (!(await next.isVisible({ timeout: 6_000 }).catch(() => false))) {
        return { ok: false, error: `thread editor ${i} not found` };
      }
      await typeLikeHuman(next, parts[i]!);
      await dwell();
    }

    if (!(await clickIfPresent(page, this.sel.composerSubmit!, 8_000))) {
      return { ok: false, error: 'the publish button never became clickable' };
    }

    // Bluesky closes the composer on success and leaves it open with an error
    // banner otherwise, so the composer disappearing IS the confirmation.
    for (let waited = 0; waited < 20_000; waited += 1_000) {
      await sleep(1_000);
      const stillOpen = await firstVisible(page, this.sel.composerEditor!, 500);
      if (!stillOpen) return { ok: true };
    }
    return { ok: false, error: 'Bluesky did not accept it — the composer never closed' };
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
        const excerpt = ((await node.locator(this.sel.feedPostText!.join(', ')).first()
          .innerText().catch(() => '')) ?? '').trim().slice(0, 600);
        if (!excerpt) continue;
        // The testid carries the author handle: feedItem-by-alice.bsky.social.
        const testid = (await node.getAttribute('data-testid').catch(() => null)) ?? '';
        const handle = testid.replace('feedItem-by-', '') || null;
        const permalink = await node.locator('a[href*="/post/"]').first()
          .getAttribute('href').catch(() => null);
        items.push({
          ref: permalink ?? `bsky-${i}-${excerpt.slice(0, 40)}`,
          author: handle,
          excerpt,
          permalink: permalink ? new URL(permalink, 'https://bsky.app').toString() : null,
          index: i,
        });
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
      if (!(await btn.isVisible().catch(() => false))) return { ok: false, error: 'no like button' };
      // Bluesky flips the testid to unlikeBtn once liked; a second click unlikes.
      const already = await node.locator('[data-testid="unlikeBtn"]').first()
        .isVisible({ timeout: 500 }).catch(() => false);
      if (already) return { ok: false, error: 'already liked' };
      await btn.click();
      await sleep(randInt(900, 2200));
      return { ok: true };
    }

    if (action === 'comment') {
      if (!body) return { ok: false, error: 'comment requires a body' };
      const btn = node.locator(this.sel.commentButton!.join(', ')).first();
      if (!(await btn.isVisible().catch(() => false))) return { ok: false, error: 'no reply button' };
      await btn.click();
      await sleep(randInt(1200, 2600));

      const editor = await firstVisible(page, this.sel.commentEditor!, 8_000);
      if (!editor) return { ok: false, error: 'reply editor not found' };
      await editor.click();
      await typeLikeHuman(editor, body);
      await dwell();
      if (!(await clickIfPresent(page, this.sel.commentSubmit!, 6_000))) {
        return { ok: false, error: 'reply submit not clickable' };
      }
      await sleep(randInt(1500, 3000));
      return { ok: true };
    }

    return { ok: false, error: `unsupported action ${action}` };
  },

  /* ── Targeted actions ──────────────────────────────────────────────────── */

  async reactToPost(page, url, reaction) {
    // Bluesky has exactly one reaction. Asking for a LinkedIn-only one is a
    // caller mistake worth naming rather than quietly downgrading to a like.
    if (reaction !== 'like') {
      return { ok: false, error: `Bluesky has only one reaction; "${reaction}" does not exist there` };
    }
    if (!(await openPost(page, url))) return { ok: false, error: 'could not open that post' };

    if (await page.locator('[data-testid="unlikeBtn"]').first().isVisible({ timeout: 1_500 }).catch(() => false)) {
      return { ok: false, error: 'this account has already liked that post' };
    }
    const btn = await firstVisible(page, this.sel.likeButton!, 8_000);
    if (!btn) return { ok: false, error: 'no like button on that post' };
    await btn.click();
    await sleep(randInt(1200, 2400));

    const confirmed = await page.locator('[data-testid="unlikeBtn"]').first()
      .isVisible({ timeout: 5_000 }).catch(() => false);
    return confirmed ? { ok: true } : { ok: false, error: 'clicked, but the like never registered' };
  },

  async commentOnPost(page, url, body) {
    if (!(await openPost(page, url))) return { ok: false, error: 'could not open that post' };

    if (!(await clickIfPresent(page, this.sel.commentButton!, 8_000))) {
      return { ok: false, error: 'no reply button on that post' };
    }
    await sleep(randInt(1200, 2400));

    const editor = await firstVisible(page, this.sel.commentEditor!, 8_000);
    if (!editor) return { ok: false, error: 'reply editor never loaded' };
    await editor.click();
    await typeLikeHuman(editor, body);
    await dwell();

    if (!(await clickIfPresent(page, this.sel.commentSubmit!, 6_000))) {
      return { ok: false, error: 'reply submit not clickable' };
    }
    await sleep(randInt(2000, 3500));

    const landed = (await page.innerText('body').catch(() => '')).includes(body.slice(0, 40));
    return landed ? { ok: true } : { ok: false, error: 'submitted, but the reply is not on the page' };
  },

  async follow(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await readPage(page, 2);

    if (await firstVisible(page, this.sel.followingState!, 2_000)) {
      return { ok: false, error: 'already following' };
    }
    const btn = await firstVisible(page, this.sel.followButton!, 8_000);
    if (!btn) return { ok: false, error: 'no follow button' };
    await btn.click();
    await sleep(randInt(1500, 2800));

    return (await firstVisible(page, this.sel.followingState!, 5_000))
      ? { ok: true }
      : { ok: false, error: 'clicked Follow but the button never changed state' };
  },

  /**
   * Delete a post of yours, found by its text.
   *
   * Bluesky deletion is immediate and there is no trash, so this confirms the
   * post is actually gone before reporting success.
   */
  async deletePost(page, needle, opts) {
    const listing = opts?.listingUrl ?? this.homeUrl;
    await page.goto(listing, { waitUntil: 'domcontentloaded' });
    await readPage(page, 2);

    const post = page.locator(this.sel.feedPosts!.join(', ')).filter({ hasText: needle }).first();
    if (!(await post.isVisible({ timeout: 8_000 }).catch(() => false))) {
      return { ok: false, error: 'could not find that post' };
    }

    const menu = post.locator(this.sel.postDropdown!.join(', ')).first();
    if (!(await menu.isVisible({ timeout: 5_000 }).catch(() => false))) {
      return { ok: false, error: 'no post menu — is this post ours?' };
    }
    await menu.click();
    await sleep(randInt(700, 1400));

    if (!(await clickIfPresent(page, this.sel.deleteMenuItem!, 5_000))) {
      return { ok: false, error: 'no Delete in the menu — this post is not ours' };
    }
    await sleep(randInt(600, 1200));
    if (!(await clickIfPresent(page, this.sel.confirmDelete!, 5_000))) {
      return { ok: false, error: 'delete confirmation never appeared' };
    }
    await sleep(randInt(2000, 3500));

    await page.goto(listing, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await readPage(page, 2);
    const body = await page.innerText('body').catch(() => '');
    return body.includes(needle)
      ? { ok: false, error: 'the post is still there' }
      : { ok: true };
  },
};

/** Open a post permalink and confirm a post actually rendered. */
async function openPost(page: Page, url: string): Promise<boolean> {
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await readPage(page, 2);
  if (/\/login|\/signin/.test(page.url())) return false;
  return (await firstVisible(page, ['[data-testid="postText"]', '[data-testid^="feedItem-by-"]'], 8_000)) !== null;
}
