import type { Page } from 'playwright';
import { SEL, clickIfPresent } from '../browser/selectors.ts';
import { readPage, sleep, randInt } from '../browser/human.ts';
import { normalizeProfileUrl, publicIdOf } from '../util/url.ts';
import { enrollLead, upsertLead, isSuppressed } from '../db/index.ts';

/**
 * Lead collection the way Linked Helper does it: by *browsing* a results page and
 * harvesting the profile links, not by calling an API. Works on regular search,
 * Sales Navigator lists, group member lists, event attendee lists, alumni pages,
 * "who viewed your profile", and your own connections list — anything that renders
 * /in/ links.
 *
 * Collection is itself paced. A tool that rips 30 pages in 20 seconds is the single
 * most obvious bot signal there is.
 */
export interface HarvestOptions {
  /** A LinkedIn results URL you already pasted from the browser. */
  url: string;
  maxPages?: number;
  maxLeads?: number;
  source?: string;
  /** Enroll every collected lead into this campaign. */
  campaignId?: number;
  onLog?: (line: string) => void;
}

export interface HarvestResult {
  seen: number;
  added: number;
  enrolled: number;
  skippedSuppressed: number;
  pages: number;
}

export async function harvestSearch(
  page: Page,
  opts: HarvestOptions,
): Promise<HarvestResult> {
  const log = opts.onLog ?? (() => {});
  const maxPages = opts.maxPages ?? 5;
  const maxLeads = opts.maxLeads ?? 100;

  const result: HarvestResult = {
    seen: 0,
    added: 0,
    enrolled: 0,
    skippedSuppressed: 0,
    pages: 0,
  };
  const seenUrls = new Set<string>();

  await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
  if (/\/checkpoint\/|\/authwall|\/login/.test(page.url())) {
    throw new Error('LinkedIn showed a login/checkpoint page — cannot harvest');
  }

  for (let p = 0; p < maxPages && result.added < maxLeads; p++) {
    result.pages++;

    // Results are virtualised: without scrolling you only get the first handful.
    for (let s = 0; s < 5; s++) {
      await readPage(page, 2);
      await sleep(randInt(700, 1800));
    }

    const hrefs = await page
      .locator(SEL.searchResultLinks.join(', '))
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLAnchorElement).href))
      .catch(() => [] as string[]);

    for (const href of hrefs) {
      const url = normalizeProfileUrl(href);
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      result.seen++;

      if (isSuppressed(url)) {
        result.skippedSuppressed++;
        continue;
      }

      const lead = upsertLead({
        profile_url: url,
        public_id: publicIdOf(url) ?? undefined,
        source: opts.source ?? 'search',
      });
      result.added++;

      if (opts.campaignId && enrollLead(opts.campaignId, lead.id)) {
        result.enrolled++;
      }
      if (result.added >= maxLeads) break;
    }

    log(`page ${p + 1}: ${result.added} collected so far`);
    if (result.added >= maxLeads) break;

    const next = await clickIfPresent(page, SEL.searchNextPage, 4_000);
    if (!next) {
      log('no further pages');
      break;
    }
    await sleep(randInt(2_500, 6_500));
  }

  return result;
}
