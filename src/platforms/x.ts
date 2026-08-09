import type { PlatformAdapter, FeedItem } from './types.ts';
import { firstVisible, clickIfPresent } from '../browser/selectors.ts';
import { typeLikeHuman, readPage, dwell, sleep, randInt } from '../browser/human.ts';

/**
 * X (Twitter). Posts, DMs, and timeline engagement.
 *
 * X is the most aggressive of the four about automation, and its DM surface is
 * gated: you can only DM someone who follows you or who has open DMs. The adapter
 * reports that as a clean failure rather than retrying into a wall.
 *
 * Selectors here use `data-testid`, which X uses consistently across its React
 * tree and which survives redesigns far better than class names.
 */
export const x: PlatformAdapter = {
  id: 'x',
  displayName: 'X',
  homeUrl: 'https://x.com/home',
  loginUrl: 'https://x.com/i/flow/login',
  loggedOutPatterns: /\/i\/flow\/login|\/login|^https:\/\/x\.com\/?$/,
  checkpointPatterns: /\/account\/access|\/i\/flow\/consent|arkose/,
  loggedInPatterns: /\/home/,
  loggedInSelectors: [
    "[data-testid='SideNav_AccountSwitcher_Button']",
    "[data-testid='AppTabBar_Profile_Link']",
    "[data-testid='SideNav_NewTweet_Button']",
  ],

  can: { post: true, dm: true, feed: true, engage: ['like'] },

  rules: {
    // 280 unless the account has Premium. BRAND_VOICE.md is explicit that we do
    // not assume Premium, so 280 is the working ceiling and threads are the
    // escape hatch for anything longer.
    post: { maxChars: 280, linksAllowed: true, threads: true },
    dm: { maxChars: 900, linksAllowed: true, threads: false },
  },

  defaultLimits: {
    post: { perDay: 4, perHour: 2 },
    dm: { perDay: 12, perHour: 4 },
    engage_like: { perDay: 40, perHour: 10 },
  },

  sel: {
    composerTrigger: [
      'a[data-testid="SideNav_NewTweet_Button"]',
      'a[href="/compose/post"]',
      'a[href="/compose/tweet"]',
    ],
    composerEditor: [
      'div[data-testid="tweetTextarea_0"]',
      'div[role="textbox"][contenteditable="true"]',
    ],
    composerSubmit: [
      'button[data-testid="tweetButton"]',
      'button[data-testid="tweetButtonInline"]',
    ],
    addThreadItem: ['button[data-testid="addButton"]'],

    timelinePosts: ['article[data-testid="tweet"]'],
    postAuthor: ['div[data-testid="User-Name"]'],
    postText: ['div[data-testid="tweetText"]'],
    likeButton: ['button[data-testid="like"]'],
    permalinkAnchor: ['a[href*="/status/"]'],

    dmComposeButton: ['button[data-testid="sendDMFromProfile"]', 'a[data-testid="DMDrawer"]'],
    dmEditor: ['div[data-testid="dmComposerTextInput"]', 'div[role="textbox"][contenteditable="true"]'],
    dmSend: ['button[data-testid="dmComposerSendButton"]'],
  },

  /**
   * Publishes a single post, or a numbered thread. Thread detection matches the
   * brand-voice convention: a body whose lines start "1/" and "2/".
   */
  async post(page, body) {
    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded' });
    await sleep(randInt(1500, 3000));

    let editor = await firstVisible(page, this.sel.composerEditor!, 8_000);
    if (!editor) {
      await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });
      await clickIfPresent(page, this.sel.composerTrigger!, 6_000);
      await sleep(randInt(1200, 2600));
      editor = await firstVisible(page, this.sel.composerEditor!, 8_000);
    }
    if (!editor) return { ok: false, error: 'composer not found' };

    const parts = splitThread(body);
    await typeLikeHuman(editor, parts[0]!);
    await dwell();

    for (let i = 1; i < parts.length; i++) {
      if (!(await clickIfPresent(page, this.sel.addThreadItem!, 5_000))) {
        return { ok: false, error: `could not add thread item ${i + 1}` };
      }
      await sleep(randInt(800, 1800));
      const next = await firstVisible(page, [`div[data-testid="tweetTextarea_${i}"]`], 6_000);
      if (!next) return { ok: false, error: `thread editor ${i} not found` };
      await typeLikeHuman(next, parts[i]!);
      await dwell();
    }

    if (!(await clickIfPresent(page, this.sel.composerSubmit!, 6_000))) {
      return { ok: false, error: 'post button not clickable' };
    }
    await sleep(randInt(2500, 5000));
    return { ok: true };
  },

  /**
   * `target` is a handle ("@name") or a profile URL. DMs only reach people who
   * follow you or have open DMs — anything else is reported, not retried.
   */
  async dm(page, target, body) {
    const handle = target.replace(/^@/, '').replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').split(/[/?#]/)[0];
    if (!handle) return { ok: false, error: 'could not parse an X handle from the target' };

    await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded' });
    await readPage(page, 1);

    if (!(await clickIfPresent(page, this.sel.dmComposeButton!, 6_000))) {
      return {
        ok: false,
        error: 'no DM button — this account does not accept DMs from you (X requires they follow you or have open DMs)',
      };
    }
    await sleep(randInt(1200, 2600));

    const editor = await firstVisible(page, this.sel.dmEditor!, 8_000);
    if (!editor) return { ok: false, error: 'DM editor not found' };

    await typeLikeHuman(editor, body);
    await dwell();
    if (!(await clickIfPresent(page, this.sel.dmSend!, 5_000))) {
      return { ok: false, error: 'DM send button not clickable' };
    }
    await sleep(randInt(1500, 3200));
    return { ok: true };
  },

  async readFeed(page, limit) {
    await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });
    const items: FeedItem[] = [];
    const posts = page.locator(this.sel.timelinePosts!.join(', '));

    for (let scroll = 0; scroll < 8 && items.length < limit; scroll++) {
      await readPage(page, 2);
      const count = Math.min(await posts.count().catch(() => 0), limit * 3);

      for (let i = items.length; i < count && items.length < limit; i++) {
        const node = posts.nth(i);
        const excerpt = ((await node.locator(this.sel.postText!.join(', ')).first().innerText().catch(() => '')) ?? '')
          .trim()
          .slice(0, 600);
        if (!excerpt) continue;
        const permalink = await node
          .locator(this.sel.permalinkAnchor!.join(', '))
          .first()
          .getAttribute('href')
          .catch(() => null);
        const author = await node.locator(this.sel.postAuthor!.join(', ')).first().innerText().catch(() => null);
        items.push({
          ref: permalink ? `https://x.com${permalink}` : `x-feed-${excerpt.slice(0, 60)}`,
          author: author?.split('\n')[0]?.trim() ?? null,
          excerpt,
          permalink: permalink ? `https://x.com${permalink}` : null,
          index: i,
        });
      }
    }
    return items;
  },

  async engage(page, item, action) {
    if (action !== 'like') return { ok: false, error: `unsupported action ${action} on X` };

    const node = page.locator(this.sel.timelinePosts!.join(', ')).nth(item.index);
    if (!(await node.isVisible().catch(() => false))) {
      return { ok: false, error: 'timeline item no longer on screen' };
    }
    await node.scrollIntoViewIfNeeded().catch(() => {});
    await dwell();

    const btn = node.locator(this.sel.likeButton!.join(', ')).first();
    if (!(await btn.isVisible().catch(() => false))) return { ok: false, error: 'no Like button' };
    await btn.click();
    await sleep(randInt(900, 2200));
    return { ok: true };
  },
};

/** "1/ ...\n2/ ..." becomes separate tweets; anything else stays one. */
export function splitThread(body: string): string[] {
  const lines = body.split('\n');
  const starts = lines
    .map((l, i) => (/^\s*\d+\s*[/.]\s+/.test(l) ? i : -1))
    .filter((i) => i >= 0);
  if (starts.length < 2) return [body.trim()];

  const parts: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!;
    const to = i + 1 < starts.length ? starts[i + 1]! : lines.length;
    parts.push(lines.slice(from, to).join('\n').trim());
  }
  return parts.filter(Boolean);
}
