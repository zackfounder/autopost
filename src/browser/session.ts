import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../config/env.ts';
import { setAccountStatus } from '../db/index.ts';
import type { Account } from '../db/types.ts';
import { getPlatform } from '../platforms/index.ts';

/**
 * One persistent Chromium profile per account — the same shape as Linked Helper's
 * embedded browser. The session cookies live in `profile_dir` on this machine and
 * are never read out, copied, or transmitted anywhere.
 *
 * We deliberately do NOT spoof fingerprints, patch navigator properties, or try to
 * look like a different browser. This is a real Chromium with a real profile; the
 * only thing that keeps the account healthy is pacing (see engine/limits.ts).
 */

export interface Session {
  account: Account;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

const open = new Map<number, Session>();

export function profileDirFor(accountName: string): string {
  const dir = join(env.profilesDir, accountName.replace(/[^a-zA-Z0-9._-]/g, '_'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function openSession(
  account: Account,
  opts: { headless?: boolean } = {},
): Promise<Session> {
  const existing = open.get(account.id);
  if (existing && !existing.page.isClosed()) return existing;

  const context = await chromium.launchPersistentContext(account.profile_dir, {
    // An account can veto headless. A site behind a bot check will serve a
    // headless browser a security page instead of the site, and LinkedIn is
    // markedly more suspicious of one even when it does let you in.
    headless: account.force_headed ? false : (opts.headless ?? env.headless),
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    args: ['--disable-blink-features=AutomationControlled'],
    proxy: account.proxy ? { server: account.proxy } : undefined,
  });

  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(20_000);

  const session: Session = {
    account,
    context,
    page,
    async close() {
      open.delete(account.id);
      await context.close().catch(() => {});
    },
  };
  open.set(account.id, session);
  return session;
}

export async function closeAllSessions(): Promise<void> {
  await Promise.all([...open.values()].map((s) => s.close()));
}

export type LoginState = 'ok' | 'logged_out' | 'checkpoint';

/**
 * Cheap health probe. Called before every scheduler tick — if this returns
 * anything but 'ok' the engine stops touching the account instead of hammering a
 * challenge page, which is exactly the behaviour that turns a soft check into a ban.
 */

/**
 * Read the login state WITHOUT navigating.
 *
 * checkLogin() calls page.goto() to find out where it lands, which is correct
 * when nobody is using the window. During an interactive login it is
 * destructive: polling every five seconds navigated the owner off LinkedIn's
 * two-step verification page mid-code, LinkedIn treated the challenge as
 * abandoned and bounced back to the login form, and the loop repeated forever.
 *
 * This looks at where the page already is and says nothing more.
 */
export function observeLogin(session: Session): LoginState {
  const adapter = getPlatform(session.account.platform ?? 'linkedin');
  const url = session.page.url();
  if (adapter.checkpointPatterns.test(url)) return 'checkpoint';
  if (adapter.loggedOutPatterns.test(url)) return 'logged_out';
  // A blank tab is not a logged-in session.
  if (!url || url === 'about:blank') return 'logged_out';
  return 'ok';
}

/**
 * The address bar after the page has stopped moving.
 *
 * These platforms decide whether you are signed in on the client, after
 * domcontentloaded, so the first URL you can read is the one you asked for
 * rather than the one you got. Poll until it holds still.
 */
async function settledUrl(page: import('playwright').Page, ms = 9_000): Promise<string> {
  let last = page.url();
  let stableFor = 0;
  const step = 500;
  for (let waited = 0; waited < ms; waited += step) {
    await page.waitForTimeout(step);
    const now = page.url();
    if (now === last) {
      stableFor += step;
      // Two seconds without a redirect is settled. A client-side bounce is
      // quicker than that; waiting the full budget on every healthy account
      // would make checking six of them needlessly slow.
      if (stableFor >= 2_000) break;
    } else {
      last = now;
      stableFor = 0;
    }
  }
  return last;
}

export async function checkLogin(session: Session): Promise<LoginState> {
  const { page, account } = session;

  // Each platform declares its own home page and its own "you are not logged in"
  // and "you are being challenged" URL shapes.
  const adapter = getPlatform(account.platform ?? 'linkedin');

  try {
    await page.goto(adapter.homeUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch {
    return 'logged_out';
  }

  // Both URL patterns test the very address we just navigated to — X's homeUrl
  // is /home and its logged-in pattern is /home. Read too early and the answer
  // is always yes, because the signed-out redirect has not happened yet. That
  // is exactly how a signed-out X account reported itself logged in.
  const url = await settledUrl(page);

  // A bot check is not a verdict on the session. An interstitial says nothing
  // about whether anyone is signed in, and reading it as 'logged out' tells the
  // owner to redo a login that was already fine.
  const title = await page.title().catch(() => '');
  if (/just a moment|checking your browser|security verification/i.test(title)) {
    return 'checkpoint';
  }

  let state: LoginState;
  if (adapter.checkpointPatterns.test(url)) {
    state = 'checkpoint';
  } else if (adapter.loggedOutPatterns.test(url)) {
    state = 'logged_out';
  } else if (adapter.loggedInPatterns) {
    // Both platforms redirect an authenticated session to a URL a stranger
    // never sees. That is the signal — the DOM selectors underneath were my
    // guesses and reported LinkedIn and X as logged out when both were fine.
    state = adapter.loggedInPatterns.test(url) ? 'ok' : 'logged_out';
  } else if (adapter.loggedInSelectors?.length) {
    // The URL is not enough for a platform whose login is a modal over the
    // homepage: the address bar reads the same signed in or out, which marks an
    // account 'ok' when nobody has logged in at all. Ask the page for something
    // only an authenticated session renders.
    let seen = false;
    for (const sel of adapter.loggedInSelectors) {
      try {
        if (await page.locator(sel).first().isVisible({ timeout: 2_000 })) { seen = true; break; }
      } catch { /* selector did not match; try the next */ }
    }
    state = seen ? 'ok' : 'logged_out';
  } else {
    state = 'ok';
  }

  setAccountStatus(account.id, state);
  return state;
}

/**
 * Read the logged-in member's own public id, so the app knows whose account it is.
 * Best-effort — returns null rather than throwing.
 */
export async function whoAmI(session: Session): Promise<string | null> {
  const platform = session.account.platform ?? 'linkedin';
  try {
    if (platform === 'linkedin') {
      await session.page.goto('https://www.linkedin.com/in/me/', { waitUntil: 'domcontentloaded' });
      return /linkedin\.com\/in\/([^/?#]+)/.exec(session.page.url())?.[1] ?? null;
    }
    if (platform === 'x') {
      await session.page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
      const href = await session.page
        .locator('a[data-testid="AppTabBar_Profile_Link"]')
        .first()
        .getAttribute('href')
        .catch(() => null);
      return href ? href.replace(/^\//, '') : null;
    }
    // Anywhere else the handle sits behind a profile menu, which is not worth a
    // fragile selector. The account name you chose is identity enough.
    return null;
  } catch {
    return null;
  }
}
