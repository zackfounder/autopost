import type { Page, Locator } from 'playwright';

/**
 * EVERY LinkedIn selector lives in this file. When LinkedIn ships a redesign,
 * this is the only file you edit.
 *
 * Rules that keep these alive longer than most scrapers:
 *  - Match on `aria-label`, `role`, and stable ids. Never on generated class names
 *    (`.artdeco-xy9z`) — LinkedIn obfuscates those and rotates them.
 *  - Every target is a LIST of candidates, tried in order, because LinkedIn
 *    A/B-tests two or three variants of the same control at any given time.
 */

export type Candidates = string[];

export const SEL = {
  connectButton: [
    'main button[aria-label^="Invite"][aria-label*="connect"]',
    'main button:has-text("Connect")',
    'div.pvs-profile-actions button[aria-label*="Connect"]',
  ],
  moreActionsButton: [
    'main button[aria-label="More actions"]',
    'main button[aria-label^="More"]',
  ],
  connectInMoreMenu: [
    'div[role="menu"] div[aria-label^="Invite"][aria-label*="connect"]',
    'div[role="menu"] span:has-text("Connect")',
  ],
  addNoteButton: [
    'button[aria-label="Add a note"]',
    'div[role="dialog"] button:has-text("Add a note")',
  ],
  noteTextarea: ['textarea#custom-message', 'div[role="dialog"] textarea[name="message"]'],
  sendInviteButton: [
    'button[aria-label="Send invitation"]',
    'button[aria-label="Send now"]',
    'div[role="dialog"] button:has-text("Send")',
  ],
  dialogDismiss: ['div[role="dialog"] button[aria-label="Dismiss"]'],

  messageButton: [
    'main button[aria-label^="Message"]',
    'main a[href^="/messaging/thread"]',
  ],
  messageComposer: [
    'div.msg-form__contenteditable[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
  ],
  messageSendButton: [
    'button.msg-form__send-button',
    'button[type="submit"]:has-text("Send")',
  ],
  /** Rendered messages inside the open thread, oldest first. */
  messageBubbles: ['li.msg-s-message-list__event', 'div.msg-s-event-listitem'],
  /** A bubble that LinkedIn marks as sent by the *other* party. */
  incomingBubbleMarker: ['.msg-s-event-listitem--other'],

  followButton: ['main button[aria-label^="Follow"]', 'main button:has-text("Follow")'],
  unfollowButton: ['main button[aria-label^="Unfollow"]'],

  degreeBadge: [
    'main span.dist-value',
    'main span.distance-badge span.dist-value',
    'main .pv-text-details__left-panel span:has-text("degree connection")',
  ],
  profileName: ['main h1'],
  profileHeadline: ['main div.text-body-medium'],
  profileLocation: ['main span.text-body-small.inline'],

  /** Search-results page: anchors to member profiles. */
  searchResultLinks: [
    'a[href*="/in/"][data-test-app-aware-link]',
    'ul li a[href*="linkedin.com/in/"]',
    'a.app-aware-link[href*="/in/"]',
  ],
  searchNextPage: ['button[aria-label="Next"]', 'button.artdeco-pagination__button--next'],

  /** Sent-invitations manager. */
  pendingInviteCards: ['li.invitation-card', 'div[componentkey*="pending"] li'],
  withdrawButton: ['button:has-text("Withdraw")'],
  confirmWithdraw: ['div[role="dialog"] button:has-text("Withdraw")'],

  postLikeButton: ['button[aria-label^="React Like"]', 'button.react-button__trigger'],
} satisfies Record<string, Candidates>;

/** First candidate that is actually attached and visible, or null. */
export async function firstVisible(
  page: Page,
  candidates: Candidates,
  timeoutMs = 6_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      try {
        if (await loc.isVisible({ timeout: 250 })) return loc;
      } catch {
        /* candidate not present in this variant */
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

export async function clickIfPresent(
  page: Page,
  candidates: Candidates,
  timeoutMs = 4_000,
): Promise<boolean> {
  const loc = await firstVisible(page, candidates, timeoutMs);
  if (!loc) return false;
  await loc.click({ timeout: 5_000 });
  return true;
}

export async function textOf(
  page: Page,
  candidates: Candidates,
  timeoutMs = 3_000,
): Promise<string | null> {
  const loc = await firstVisible(page, candidates, timeoutMs);
  if (!loc) return null;
  const t = await loc.innerText().catch(() => null);
  return t ? t.trim() : null;
}
