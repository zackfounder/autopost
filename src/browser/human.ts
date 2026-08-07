import type { Page, Locator } from 'playwright';
import type { Pacing } from '../db/types.ts';

export const DEFAULT_PACING: Pacing = {
  minGapSeconds: 35,
  maxGapSeconds: 140,
  typeDelayMs: [45, 130],
};

export const randInt = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min + 1));

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The pause the scheduler takes between two actions. */
export const gapMs = (p: Pacing) => randInt(p.minGapSeconds, p.maxGapSeconds) * 1000;

/**
 * Type character by character with jittered delays and an occasional longer
 * "thinking" pause, instead of assigning the value in one shot. LinkedIn's client
 * telemetry sees keystroke events either way; the difference is whether 400
 * characters arrive in the same millisecond.
 */
export async function typeLikeHuman(
  locator: Locator,
  text: string,
  pacing: Pacing = DEFAULT_PACING,
): Promise<void> {
  await locator.click();
  const [lo, hi] = pacing.typeDelayMs;
  for (const ch of text) {
    await locator.press(ch === '\n' ? 'Shift+Enter' : ch, { delay: randInt(lo, hi) }).catch(
      async () => {
        // press() rejects on multi-byte glyphs and some punctuation; fall through to insertText.
        await locator.page().keyboard.insertText(ch);
        await sleep(randInt(lo, hi));
      },
    );
    if (Math.random() < 0.03) await sleep(randInt(300, 1200));
  }
}

/**
 * Scroll the way a person reads a page. Also load-bearing: LinkedIn lazy-loads most
 * of a profile, so a profile you never scrolled is a profile you only half-read.
 */
export async function readPage(page: Page, passes = 3): Promise<void> {
  for (let i = 0; i < passes; i++) {
    await page.mouse.wheel(0, randInt(300, 900));
    await sleep(randInt(600, 1900));
  }
  if (Math.random() < 0.4) {
    await page.mouse.wheel(0, -randInt(150, 500));
    await sleep(randInt(400, 1100));
  }
}

/** Small idle before acting on something you just looked at. */
export const dwell = () => sleep(randInt(900, 3200));
