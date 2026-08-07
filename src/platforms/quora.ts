import type { PlatformAdapter, FeedItem } from './types.ts';
import { firstVisible, clickIfPresent } from '../browser/selectors.ts';
import { typeLikeHuman, readPage, dwell, sleep, randInt } from '../browser/human.ts';

/**
 * Quora. Two distinct things live under "post" here, and conflating them is the
 * usual mistake:
 *   - answering an existing question (what actually gets distribution)
 *   - writing a Space/profile post (almost nobody sees it)
 * This adapter treats "post" as ANSWER A QUESTION, and the target_ref on the
 * content row is the question URL. Feed engagement is upvote + comment.
 *
 * Quora has no stable data-testid convention, so these selectors lean on visible
 * text and roles. Expect this adapter to need the most calibration of the four.
 */
export const quora: PlatformAdapter = {
  id: 'quora',
  displayName: 'Quora',
  homeUrl: 'https://www.quora.com/',
  loginUrl: 'https://www.quora.com/login',
  loggedOutPatterns: /\/login|\/signup/,
  checkpointPatterns: /\/challenge|captcha/,

  can: { post: true, dm: false, feed: true, engage: ['upvote', 'comment'] },

  rules: {
    // Quora rewards long, structured answers; the floor matters more than the cap.
    post: { maxChars: 5000, linksAllowed: true, threads: false },
    comment: { maxChars: 1200, linksAllowed: false, threads: false },
  },

  defaultLimits: {
    post: { perDay: 2, perHour: 1 },
    engage_upvote: { perDay: 25, perHour: 8 },
    engage_comment: { perDay: 6, perHour: 2 },
  },

  sel: {
    // Answer composer on a question page.
    answerButton: [
      'div[role="button"]:has-text("Answer")',
      'button:has-text("Answer")',
      'div.q-click-wrapper:has-text("Answer")',
    ],
    answerEditor: [
      'div.doc[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'div.q-text[contenteditable="true"]',
    ],
    answerSubmit: [
      'div[role="button"]:has-text("Post")',
      'button:has-text("Post")',
      'div.q-click-wrapper:has-text("Submit")',
    ],

    feedPosts: ['div.q-box.dom_annotate_question_answer_item_0', 'div[class*="AnswerListItem"]', 'div.puppeteer_test_answer'],
    feedAuthor: ['a.q-box.qu-cursor--pointer span', 'div[class*="AnswerHeader"] a'],
    feedText: ['div.q-text.qu-wordBreak--break-word', 'span.q-box'],
    upvoteButton: [
      'div[role="button"][aria-label^="Upvote"]',
      'button[aria-label^="Upvote"]',
      'div.q-click-wrapper:has-text("Upvote")',
    ],
    commentButton: ['div[role="button"]:has-text("Comment")', 'button:has-text("Comment")'],
    commentEditor: ['div[role="textbox"][contenteditable="true"]'],
    commentSubmit: ['div[role="button"]:has-text("Add Comment")', 'button:has-text("Post")'],
    permalinkAnchor: ['a[href*="/answer/"]', 'a[href^="https://www.quora.com/"]'],
  },

  /**
   * `body` is the answer. The question URL must be supplied by the caller and is
   * navigated to first — there is no "just post" on Quora that anyone reads.
   */
  async post(page, body) {
    // The caller is responsible for having navigated to the question. If we are
    // still on the home feed, refuse rather than answering a random question.
    if (!/\/[^/]+\?|quora\.com\/[A-Z]/.test(page.url())) {
      return {
        ok: false,
        error:
          'not on a question page. A Quora post is an ANSWER — set target_ref on the content row to the question URL.',
      };
    }
    await readPage(page, 2);

    if (!(await clickIfPresent(page, this.sel.answerButton!, 6_000))) {
      return { ok: false, error: 'no Answer button (already answered, or the question is closed)' };
    }
    await sleep(randInt(1500, 3000));

    const editor = await firstVisible(page, this.sel.answerEditor!, 8_000);
    if (!editor) return { ok: false, error: 'answer editor not found' };

    await typeLikeHuman(editor, body);
    await dwell();

    if (!(await clickIfPresent(page, this.sel.answerSubmit!, 6_000))) {
      return { ok: false, error: 'Post button not clickable' };
    }
    await sleep(randInt(2500, 5000));
    return { ok: true, permalink: page.url() };
  },

  async readFeed(page, limit) {
    await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });
    const items: FeedItem[] = [];
    const posts = page.locator(this.sel.feedPosts!.join(', '));

    for (let scroll = 0; scroll < 8 && items.length < limit; scroll++) {
      await readPage(page, 2);
      const count = Math.min(await posts.count().catch(() => 0), limit * 3);

      for (let i = items.length; i < count && items.length < limit; i++) {
        const node = posts.nth(i);
        const excerpt = ((await node.innerText().catch(() => '')) ?? '').trim().slice(0, 800);
        if (!excerpt) continue;
        const permalink = await node
          .locator(this.sel.permalinkAnchor!.join(', '))
          .first()
          .getAttribute('href')
          .catch(() => null);
        const author = await node.locator(this.sel.feedAuthor!.join(', ')).first().innerText().catch(() => null);
        items.push({
          ref: permalink ?? `quora-feed-${excerpt.slice(0, 60)}`,
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
      if (!(await btn.isVisible().catch(() => false))) return { ok: false, error: 'no Upvote button' };
      if ((await btn.getAttribute('aria-pressed')) === 'true') return { ok: false, error: 'already upvoted' };
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
