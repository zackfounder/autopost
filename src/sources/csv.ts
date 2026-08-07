import { parse } from 'csv-parse/sync';
import { readFileSync } from 'node:fs';
import { normalizeProfileUrl, publicIdOf, splitName } from '../util/url.ts';
import { enrollLead, upsertLead, isSuppressed } from '../db/index.ts';

/**
 * CSV import, column-name agnostic. Exports from Apollo, Sales Navigator,
 * PhantomBuster, Waalaxy and hand-built sheets all name the same field differently,
 * so we match on a set of aliases rather than a fixed header.
 */
const ALIASES: Record<string, string[]> = {
  profile_url: ['linkedin', 'linkedin url', 'linkedinprofile', 'profile url', 'profileurl', 'url', 'person linkedin url'],
  full_name: ['name', 'full name', 'fullname'],
  first_name: ['first name', 'firstname', 'first'],
  last_name: ['last name', 'lastname', 'last'],
  headline: ['headline', 'title', 'job title', 'position'],
  company: ['company', 'company name', 'organization', 'employer', 'current company'],
  location: ['location', 'city', 'country', 'region'],
};

function buildMap(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  headers.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    for (const [field, aliases] of Object.entries(ALIASES)) {
      if (map[field] !== undefined) continue;
      if (aliases.includes(key)) map[field] = i;
    }
  });
  return map;
}

export interface CsvImportResult {
  rows: number;
  added: number;
  enrolled: number;
  skippedNoUrl: number;
  skippedSuppressed: number;
}

export function importCsv(
  filePath: string,
  opts: { campaignId?: number; source?: string } = {},
): CsvImportResult {
  const raw = readFileSync(filePath, 'utf8');
  const records = parse(raw, { skip_empty_lines: true, relax_column_count: true }) as string[][];
  if (records.length === 0) {
    return { rows: 0, added: 0, enrolled: 0, skippedNoUrl: 0, skippedSuppressed: 0 };
  }

  const map = buildMap(records[0]!);
  const result: CsvImportResult = {
    rows: 0,
    added: 0,
    enrolled: 0,
    skippedNoUrl: 0,
    skippedSuppressed: 0,
  };

  const at = (row: string[], field: string): string | undefined => {
    const i = map[field];
    if (i === undefined) return undefined;
    const v = row[i];
    return v && v.trim() ? v.trim() : undefined;
  };

  for (const row of records.slice(1)) {
    result.rows++;
    const url = normalizeProfileUrl(at(row, 'profile_url') ?? '');
    if (!url) {
      result.skippedNoUrl++;
      continue;
    }
    if (isSuppressed(url)) {
      result.skippedSuppressed++;
      continue;
    }

    const full = at(row, 'full_name');
    const split = splitName(full);

    const lead = upsertLead({
      profile_url: url,
      public_id: publicIdOf(url) ?? undefined,
      full_name: full,
      first_name: at(row, 'first_name') ?? split.first ?? undefined,
      last_name: at(row, 'last_name') ?? split.last ?? undefined,
      headline: at(row, 'headline'),
      company: at(row, 'company'),
      location: at(row, 'location'),
      source: opts.source ?? 'csv',
    });
    result.added++;

    if (opts.campaignId && enrollLead(opts.campaignId, lead.id)) result.enrolled++;
  }

  return result;
}
