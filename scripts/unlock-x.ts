/**
 * Unlock X's encrypted chat on an account's browser profile, once.
 *
 *   npm run unlock:x                 the personal account (main-x)
 *   npm run unlock:x -- crew-x       a different account
 *
 * X encrypts DMs behind a passcode. Until this browser profile has been
 * unlocked, every message route redirects to the passcode screen and there is
 * no composer to find — so a DM job fails in a way that looks like a selector
 * bug and is not one.
 *
 * This opens a real window and waits. YOU type the passcode; nothing here ever
 * sees it, stores it, or asks for it. When you press enter the script checks
 * that the gate is actually gone, then reports which composer selectors are
 * really on the page — the ones in the adapter were written blind, because the
 * lock meant nobody could ever look.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { initSchema, listAccounts } from '../src/db/index.ts';
import { openSession } from '../src/browser/session.ts';

const name = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'main-x';

initSchema();
const account = listAccounts().find((a) => a.name === name);
if (!account) {
  console.log(`\nNo account called "${name}". Run: npm run accounts\n`);
  process.exit(1);
}

const session = await openSession(account, { headless: false });
const { page } = session;

await page.goto('https://x.com/messages', { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(4_000);

const locked = async () =>
  /\/i\/chat\/pin/.test(page.url()) ||
  await page.locator('[data-testid="pin-code-input-container"], [data-testid="pin-title"]')
    .first().isVisible({ timeout: 2_000 }).catch(() => false);

if (!await locked()) {
  console.log(`\n${name} is already unlocked — X messages opened straight up.\n`);
} else {
  console.log(`
A window is open on X's passcode screen for ${name}.

  1. Type your X chat passcode in that window (not here — nothing in this
     project ever sees a passcode, and it is not stored anywhere).
  2. Wait until you can see your actual message list.
  3. Come back here and press enter.

If you have forgotten it, use "Forgot passcode" in that window. Resetting drops
the old encrypted history, which is X's behaviour, not something this changes.
`);
  const rl = createInterface({ input: stdin, output: stdout });
  await rl.question('Press enter once your messages are showing… ');
  rl.close();
}

await page.goto('https://x.com/messages', { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(4_000);

if (await locked()) {
  console.log('\nStill on the passcode screen. Nothing was changed — run this again when you have it.\n');
  await session.close();
  process.exit(1);
}

console.log('\nUnlocked. Checking which composer selectors are actually on the page.\n');

// Open the new-message composer and see what X really renders. These are the
// selectors a DM job depends on, and none of them have ever been verified.
await page.goto('https://x.com/messages/compose', { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(5_000);

const CANDIDATES: Record<string, string[]> = {
  'recipient box': [
    'input[data-testid="searchPeople"]',
    'input[placeholder*="people" i]',
    'input[role="combobox"]',
  ],
  'message editor': [
    'div[data-testid="dmComposerTextInput"]',
    'div[data-testid="dmComposerTextInputRichTextInputContainer"]',
    'div[role="textbox"][contenteditable="true"]',
  ],
  'send button': [
    'button[data-testid="dmComposerSendButton"]',
    'button[aria-label*="send" i]',
  ],
};

for (const [label, sels] of Object.entries(CANDIDATES)) {
  let hit = '';
  for (const sel of sels) {
    if (await page.locator(sel).first().isVisible({ timeout: 2_500 }).catch(() => false)) { hit = sel; break; }
  }
  console.log(`  ${label.padEnd(15)} ${hit ? `FOUND  ${hit}` : 'none of the candidates matched'}`);
}

// Anything message-shaped X renders, so a missing selector can be fixed from
// evidence rather than another guess.
const seen = await page.evaluate(() =>
  [...new Set(Array.from(document.querySelectorAll('[data-testid]'))
    .map((e) => e.getAttribute('data-testid')!)
    .filter((t) => /dm|chat|message|compose|send|search/i.test(t)))].slice(0, 20));
console.log(`\n  testids on this page: ${seen.join(', ') || 'none'}`);
console.log('\nPaste that line back to me if anything above says "none matched".\n');

await session.close();
