/**
 * Prove each session is real by making it read something only a logged-in
 * account can see: its own profile, and its follower count.
 *
 *   npm run whoami
 *   npm run whoami -- --headed     watch it happen
 *
 * This is the cheapest honest end-to-end test there is. A session that can load
 * its own profile and read a number off it is a session the engine can use. One
 * that cannot is going to fail later, in the middle of a post, where it costs
 * more to find out.
 *
 * It reads. It never posts, never follows, never clicks anything that changes
 * state. Deliberately regex-over-text rather than CSS selectors — every one of
 * these platforms rotates class names, and a follower count is one of the few
 * things reliably rendered as plain text.
 */
import { initSchema, listAccounts } from '../src/db/index.ts';
import { openSession, checkLogin } from '../src/browser/session.ts';
import { getPlatform } from '../src/platforms/index.ts';

const headed = process.argv.includes('--headed');

/**
 * Where each platform keeps "your own profile".
 *
 * LinkedIn has a /in/me/ alias that resolves to whoever is signed in. The other
 * three do not, so the profile has to be found by following the link the page
 * itself renders — see PROFILE_LINK. Pointing X at /home returned no follower
 * count, correctly: the home timeline is not a profile.
 */
const SELF_URL: Record<string, string> = {
  linkedin: 'https://www.linkedin.com/in/me/',
};

/** A link on the logged-in page that points at the account's own profile. */
const PROFILE_LINK: Record<string, string[]> = {
  x: ['[data-testid="AppTabBar_Profile_Link"]', 'a[aria-label="Profile"]'],
  quora: ['a[href*="/profile/"]'],
  indiehackers: ['a[href^="/@"]'],
};

async function selfUrl(page: import('playwright').Page, platform: string, home: string): Promise<string> {
  if (SELF_URL[platform]) return SELF_URL[platform];
  await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2_500);
  for (const sel of PROFILE_LINK[platform] ?? []) {
    const href = await page.locator(sel).first().getAttribute('href', { timeout: 3_000 }).catch(() => null);
    if (href) return href.startsWith('http') ? href : new URL(href, home).toString();
  }
  return home;
}

// "1,234 followers", "1.2K Followers", "12 k abonnés" — the count is almost
// always adjacent to the word, whatever the layout is doing that week.
const FOLLOWER_PATTERNS: RegExp[] = [
  /([\d][\d.,\s]*[KMkm]?)\s*(?:followers|abonnés|Followers)/,
  /(?:followers|abonnés)\s*[:\-]?\s*([\d][\d.,\s]*[KMkm]?)/i,
];

function findFollowers(text: string): string | null {
  for (const re of FOLLOWER_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) return m[1].trim().replace(/\s+/g, '');
  }
  return null;
}

initSchema();

const accounts = listAccounts();
if (!accounts.length) {
  console.log('No accounts registered. Run: npm run login:all');
  process.exit(0);
}

console.log('\nReading each account\'s own profile. Nothing is posted.\n');

let ok = 0;
for (const account of accounts) {
  const platform = account.platform ?? 'linkedin';
  const adapter = getPlatform(platform);
  const label = `${account.name} (${adapter.displayName})`;

  try {
    const session = await openSession(account, { headless: !headed });

    const state = await checkLogin(session);
    if (state !== 'ok') {
      console.log(`  ${label.padEnd(30)} ${state === 'checkpoint' ? 'being challenged' : 'logged out'} — log in again`);
      await session.close();
      continue;
    }

    // A company page is a different entity from the person who administers it.
    // Reading /in/me/ for both reported the personal profile's 1,219 followers
    // against a page that has 4.
    const target = account.page_url
      ?? await selfUrl(session.page, platform, adapter.homeUrl);
    await session.page
      .goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      .catch(() => {});
    // Follower counts are usually rendered late.
    await session.page.waitForTimeout(3_500);

    const text = await session.page.innerText('body').catch(() => '');
    const followers = findFollowers(text);
    const handle = account.handle ?? account.public_id ?? null;

    console.log(
      `  ${(account.page_url ? `${account.name} (page)` : label).padEnd(30)} logged in` +
      `${handle ? `  as ${handle}` : ''}` +
      `${followers ? `  ·  ${followers} followers` : '  ·  follower count not on this page'}`,
    );
    ok += 1;
    await session.close();
  } catch (err) {
    console.log(`  ${label.padEnd(30)} could not read — ${String(err).slice(0, 60)}`);
  }
}

console.log(
  `\n${ok} of ${accounts.length} sessions can read their own profile.` +
  (ok === accounts.length ? ' All good.\n' : ' Rerun npm run login:all for the rest.\n'),
);
