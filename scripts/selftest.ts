/**
 * Drive the real LinkedIn adapter against a fake LinkedIn.
 *
 *   npm run selftest
 *
 * A real headless Chromium, the real `src/platforms/linkedin.ts`, and every
 * linkedin.com request answered from `scripts/fixtures/linkedin.ts`. No account,
 * no session, no network, nothing published anywhere.
 *
 * `npm run smoke` proves the engine — queues, limits, the gate. This proves the
 * part smoke deliberately stubs: the browser layer. Between them the only thing
 * left unproven is whether the real LinkedIn still looks like the fixtures, and
 * nothing but a supervised live run can answer that.
 *
 * Every check asserts an OUTCOME the page recorded — the text that arrived in
 * the editor, which card was removed, which reaction fired — never just that a
 * call returned ok. A click that lands on nothing returns ok too.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { linkedin } from '../src/platforms/linkedin.ts';
import { bluesky } from '../src/platforms/bluesky.ts';
import * as fx from './fixtures/linkedin.ts';
import * as bfx from './fixtures/bluesky.ts';

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail !== undefined && !ok ? ` -> ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

/** What the fake site should serve next. Mutable, because some flows change it. */
const state = {
  page: 'feed' as string,
  reacted: false,
  following: false,
  deleted: false,
};

function html(url: string): string {
  if (state.page === 'authwall') return fx.authwall();
  if (url.includes('/mynetwork/invitation-manager/sent')) return fx.sentInvitations();
  if (url.includes('/mynetwork/invitation-manager')) return fx.invitations();
  if (url.includes('/recent-activity')) return fx.activity({ deleted: state.deleted });
  if (url.includes('/in/')) return fx.profile({ following: state.following });
  if (url.includes('/feed/update/')) {
    return state.page === 'comments' ? fx.postWithComments() : fx.post({ reacted: state.reacted });
  }
  if (url.includes('/company/')) return fx.pageComposer();
  return fx.feed();
}

async function openPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    // The delete fixture pings this to record that the confirm button fired.
    if (url.includes('/selftest/deleted')) {
      state.deleted = true;
      return route.fulfill({ status: 200, body: 'ok' });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html(url) });
  });
  return page;
}

const read = <T>(page: Page, key: string) =>
  page.evaluate((k) => (window as unknown as Record<string, T>)[k], key).catch(() => undefined);

const browser = await chromium.launch({ headless: true });
console.log('\nsocial-media-automation-agent selftest — real browser, fake LinkedIn\n──────────────────────────────────────────────');

/* ─────────────────────────────────────────────────────────────── posting */

console.log('\n1. Posting');
{
  const page = await openPage(browser);
  const out = await linkedin.post!(page, 'Two steps instead of six.');
  const landed = await read<string>(page, '__posted');
  const audience = await read<boolean>(page, '__audienceClicked');

  check('a personal post reports ok', out.ok, out);
  check('the body actually reached the editor', (landed ?? '').includes('Two steps instead of six'), landed);
  // "Post to Anyone" contains the word Post. Matching loosely publishes nothing
  // and reports success — the bug the exact-label filter exists to prevent.
  check('the audience picker was NOT clicked instead of Post', audience !== true);
  await page.close();
}

{
  // The one that matters most: a company post must never fall back to the feed
  // composer, which posts as the person.
  const page = await openPage(browser);
  const out = await linkedin.post!(page, 'From the company.', { postAs: 'Acme' } as never);
  check('a page post with no composer URL REFUSES', !out.ok, out);
  check('...and says why', (out.error ?? '').includes('personal profile'), out.error);
  check('nothing was published', (await read<string>(page, '__posted')) === undefined);
  await page.close();
}

/* ─────────────────────────────────────────────────────────── reactions */

console.log('\n2. Reactions');
{
  const page = await openPage(browser);
  const out = await linkedin.reactToPost!(page, 'https://www.linkedin.com/feed/update/urn:li:activity:2000', 'like');
  check('a plain like reports ok', out.ok, out);
  check('the page recorded a like', (await read<string>(page, '__reaction')) === 'like');
  await page.close();
}

{
  // The five non-like reactions only exist after hovering. This is the sequence
  // most likely to break: hover, wait for the flyout, then pick.
  const page = await openPage(browser);
  const out = await linkedin.reactToPost!(page, 'https://www.linkedin.com/feed/update/urn:li:activity:2000', 'insightful');
  check('"insightful" comes from the hover flyout', out.ok, out);
  check('the page recorded insightful, not like', (await read<string>(page, '__reaction')) === 'insightful');
  await page.close();
}

{
  state.reacted = true;
  const page = await openPage(browser);
  const out = await linkedin.reactToPost!(page, 'https://www.linkedin.com/feed/update/urn:li:activity:2000', 'like');
  // Clicking again on LinkedIn REMOVES the reaction. Silently un-reacting while
  // reporting success is worse than doing nothing.
  check('an already-reacted post is refused, not un-reacted', !out.ok && (out.error ?? '').includes('already'), out);
  state.reacted = false;
  await page.close();
}

/* ──────────────────────────────────────────────────────────── comments */

console.log('\n3. Comments and replies');
{
  const page = await openPage(browser);
  const out = await linkedin.commentOnPost!(
    page,
    'https://www.linkedin.com/feed/update/urn:li:activity:2000',
    'We measured the same thing at 14%.',
  );
  check('a comment reports ok', out.ok, out);
  check('the comment text reached the box', ((await read<string>(page, '__comment')) ?? '').includes('14%'));
  await page.close();
}

{
  state.page = 'comments';
  const page = await openPage(browser);
  const comments = await linkedin.readPostComments!(page, 'https://www.linkedin.com/feed/update/urn:li:activity:3000', 20);
  check('both comments are read', comments.length === 2, comments.map((c) => c.author));
  check('the author is attached to each', comments[0]?.author === 'Marco Silva', comments[0]);
  check('the ref carries author and text, for dedup',
    (comments[0]?.ref ?? '').startsWith('Marco Silva|'), comments[0]?.ref);

  const target = comments.find((c) => c.author === 'Marco Silva')!;
  const out = await linkedin.replyToComment!(
    page,
    'https://www.linkedin.com/feed/update/urn:li:activity:3000',
    target,
    'About three weeks, most of it backfill.',
  );
  check('the reply reports ok', out.ok, out);
  check('it replied under the right comment', (await read<string>(page, '__replyingTo')) === 'c1');
  check('the reply text arrived', ((await read<string>(page, '__reply')) ?? '').includes('three weeks'));
  state.page = 'post';
  await page.close();
}

/* ─────────────────────────────────────────────────────────── reposting */

console.log('\n4. Reposting');
{
  const page = await openPage(browser);
  const out = await linkedin.repost!(page, 'https://www.linkedin.com/feed/update/urn:li:activity:2000');
  check('a plain repost reports ok', out.ok, out);
  check('it took the plain path, not the composer', (await read<string>(page, '__repost')) === 'plain');
  await page.close();
}

{
  const page = await openPage(browser);
  const out = await linkedin.repost!(page, 'https://www.linkedin.com/feed/update/urn:li:activity:2000', 'Worth reading.');
  check('a repost with a thought reports ok', out.ok, out);
  check('the thought went through the composer', ((await read<string>(page, '__repost')) ?? '').includes('Worth reading'));
  await page.close();
}

/* ──────────────────────────────────────────────── profiles and follows */

console.log('\n5. Profiles and follows');
{
  const page = await openPage(browser);
  const out = await linkedin.visitProfile!(page, 'https://www.linkedin.com/in/dana');
  check('a visit reports ok', out.ok, out);
  check('it read the name', out.name === 'Dana Okonkwo', out.name);
  check('it read the headline', (out.headline ?? '').includes('Northwind'), out.headline);
  await page.close();
}

{
  // An authwall is HTTP 200 with a real-looking page. Reporting that as a
  // successful visit hides a dead session behind a green tick.
  state.page = 'authwall';
  const page = await openPage(browser);
  const out = await linkedin.visitProfile!(page, 'https://www.linkedin.com/in/dana');
  check('a signed-out authwall is NOT a successful visit', !out.ok, out);
  state.page = 'post';
  await page.close();
}

{
  const page = await openPage(browser);
  const out = await linkedin.follow!(page, 'https://www.linkedin.com/in/dana');
  check('follow reports ok', out.ok, out);
  check('the button really flipped', (await read<boolean>(page, '__followed')) === true);
  await page.close();
}

{
  state.following = true;
  const page = await openPage(browser);
  const out = await linkedin.follow!(page, 'https://www.linkedin.com/in/dana');
  check('an already-followed profile is refused', !out.ok && (out.error ?? '').includes('already'), out);
  state.following = false;
  await page.close();
}

/* ─────────────────────────────────────────────────────── invitations */

console.log('\n6. Invitations');
{
  const page = await openPage(browser);
  const pending = await linkedin.listInvitations!(page, 20);
  check('both pending invitations are read', pending.length === 2, pending.map((p) => p.name));
  check('the name is the first line', pending[0]?.name === 'Aisha Bello', pending[0]);
  check('the headline is the second', (pending[0]?.headline ?? '').includes('logistics'), pending[0]);

  // Accepting the SECOND one. If the adapter walked indices instead of matching
  // the name, the first card would be accepted after the list shifted.
  const out = await linkedin.acceptInvitation!(page, pending[1]!);
  check('accepting reports ok', out.ok, out);
  check('the right person was accepted', JSON.stringify(await read<string[]>(page, '__accepted')) === '["i2"]',
    await read<string[]>(page, '__accepted'));
  await page.close();
}

{
  const page = await openPage(browser);
  const out = await linkedin.withdrawStaleInvitations!(page, 30, 10);
  const withdrawn = (await read<string[]>(page, '__withdrawn')) ?? [];
  check('withdrawal reports ok', out.ok, out);
  check('it withdrew the two old ones', out.withdrawn === 2, out);
  // The 3-hour-old invite must survive: withdrawing a fresh one spends the very
  // weekly quota this job exists to protect.
  check('the 3-hour-old invitation was left alone', !withdrawn.includes('s1'), withdrawn);
  check('the 2- and 5-month-old ones went', withdrawn.includes('s2') && withdrawn.includes('s3'), withdrawn);
  await page.close();
}

/* ────────────────────────────────────────────── own posts and deleting */

console.log('\n7. Your own posts');
{
  const page = await openPage(browser);
  const mine = await linkedin.myRecentPosts!(page, 10);
  check('own posts are listed', mine.length === 2, mine.map((m) => m.url));
  // The same activity is linked several times per card — author, timestamp, image.
  check('the same activity is not counted twice',
    new Set(mine.map((m) => m.url)).size === mine.length, mine.map((m) => m.url));
  check('the URL is absolute', (mine[0]?.url ?? '').startsWith('https://www.linkedin.com/feed/update/'), mine[0]?.url);
  await page.close();
}

{
  const page = await openPage(browser);
  const out = await linkedin.deletePost!(page, 'Churn is a distribution problem');
  check('deleting reports ok only after the post is gone', out.ok, out);
  check('the confirm dialog was the thing that fired', state.deleted === true);
  await page.close();
}

/* ══════════════════════════════════════════════════════════════ bluesky ══ */

// A second site on the same harness. The route table keys off the host, so both
// adapters run against their own fixtures in the same browser.
const bstate = { page: 'home' as string, liked: false, following: false, deleted: false };

function bhtml(url: string): string {
  if (bstate.page === 'signedOut') return bfx.signedOut();
  if (url.includes('/post/')) return bfx.post({ liked: bstate.liked });
  if (url.includes('/profile/')) return bfx.profile({ following: bstate.following });
  return bfx.home({ deleted: bstate.deleted });
}

async function openBsky(): Promise<Page> {
  const page = await browser.newPage();
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.includes('/selftest/bsky-deleted')) {
      bstate.deleted = true;
      return route.fulfill({ status: 200, body: 'ok' });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: bhtml(url) });
  });
  return page;
}

console.log('\n8. Bluesky');
{
  const page = await openBsky();
  const out = await bluesky.post!(page, 'the timeout was the whole bug');
  check('a bluesky post reports ok', out.ok, out);
  check('the body reached the editor',
    ((await read<string>(page, '__posted')) ?? '').includes('the timeout was the whole bug'));
  await page.close();
}

{
  // Threads are the path most likely to break: each added post creates ANOTHER
  // editor with the same testid, and typing into the first one silently
  // concatenates the whole thread into part 1.
  const page = await openBsky();
  const out = await bluesky.post!(page, '1/ what I changed\n2/ what happened\n3/ what I would do again');
  const parts = (await read<string[]>(page, '__thread')) ?? [];
  check('a numbered body posts as a thread', out.ok, out);
  check('it split into three separate editors', parts.length === 3, parts);
  check('part 2 went into the second editor, not appended to the first',
    (parts[1] ?? '').startsWith('2/'), parts);
  await page.close();
}

{
  const page = await openBsky();
  const items = await bluesky.readFeed!(page, 10);
  check('the feed reads both posts', items.length === 2, items.map((i) => i.author));
  check('the author handle comes off the testid', items[0]?.author === 'dana.bsky.social', items[0]);
  check('the permalink is absolute',
    (items[0]?.permalink ?? '').startsWith('https://bsky.app/profile/'), items[0]?.permalink);

  const liked = await bluesky.engage!(page, items[0]!, 'like');
  check('liking a feed item reports ok', liked.ok, liked);
  check('it liked the post it was given',
    (await read<string>(page, '__liked')) === 'feedItem-by-dana.bsky.social');
  await page.close();
}

{
  const page = await openBsky();
  const out = await bluesky.reactToPost!(page, 'https://bsky.app/profile/dana/post/abc', 'like');
  check('liking by URL reports ok', out.ok, out);
  check('the like registered', (await read<boolean>(page, '__liked')) === true);
  await page.close();
}

{
  // LinkedIn has six reactions and Bluesky has one. Quietly downgrading
  // "celebrate" to a like would be a lie about what the account did.
  const page = await openBsky();
  const out = await bluesky.reactToPost!(page, 'https://bsky.app/profile/dana/post/abc', 'celebrate');
  check('a LinkedIn-only reaction is refused, not downgraded to a like',
    !out.ok && (out.error ?? '').includes('only one reaction'), out);
  check('nothing was liked', (await read<boolean>(page, '__liked')) === undefined);
  await page.close();
}

{
  bstate.liked = true;
  const page = await openBsky();
  const out = await bluesky.reactToPost!(page, 'https://bsky.app/profile/dana/post/abc', 'like');
  check('an already-liked post is refused, not un-liked', !out.ok && (out.error ?? '').includes('already'), out);
  bstate.liked = false;
  await page.close();
}

{
  const page = await openBsky();
  const out = await bluesky.commentOnPost!(page, 'https://bsky.app/profile/dana/post/abc', 'we saw the same thing');
  check('replying by URL reports ok', out.ok, out);
  check('the reply text arrived', ((await read<string>(page, '__reply')) ?? '').includes('same thing'));
  await page.close();
}

{
  const page = await openBsky();
  const out = await bluesky.follow!(page, 'https://bsky.app/profile/dana.bsky.social');
  check('following reports ok', out.ok, out);
  check('the button flipped', (await read<boolean>(page, '__followed')) === true);
  bstate.following = true;
  const page2 = await openBsky();
  const again = await bluesky.follow!(page2, 'https://bsky.app/profile/dana.bsky.social');
  check('an already-followed profile is refused', !again.ok && (again.error ?? '').includes('already'), again);
  bstate.following = false;
  await page.close(); await page2.close();
}

{
  const page = await openBsky();
  const out = await bluesky.deletePost!(page, 'shipped the retry loop');
  check('deleting confirms the post is gone', out.ok, out);
  check('the confirm dialog fired', bstate.deleted === true);
  await page.close();
}

await browser.close();
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — real browser, fixture DOM, nothing published\n`);
process.exit(failures === 0 ? 0 : 1);
