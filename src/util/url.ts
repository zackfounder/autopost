/**
 * Canonical form: https://www.linkedin.com/in/<public-id>
 * This string is the dedup key across every table, forever — so normalization has
 * to be total and stable. Locale prefixes, tracking params, trailing slashes and
 * Sales-Navigator wrappers all collapse to the same key.
 */
export function normalizeProfileUrl(input: string): string | null {
  if (!input) return null;
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;

  // Strip a locale prefix like /fr-fr/in/... and match the /in/<id> segment.
  const path = url.pathname.replace(/^\/[a-z]{2}-[a-z]{2}\//i, '/');
  const m = /\/in\/([^/?#]+)/i.exec(path);
  if (!m || !m[1]) return null;

  const publicId = decodeURIComponent(m[1]).replace(/\/+$/, '');
  if (!publicId || publicId === 'me') return null;

  return `https://www.linkedin.com/in/${publicId}`;
}

export function publicIdOf(profileUrl: string): string | null {
  const m = /\/in\/([^/?#]+)/.exec(profileUrl);
  return m?.[1] ?? null;
}

/** "Dana Okonkwo" -> { first: "Dana", last: "Okonkwo" } */
export function splitName(full: string | null | undefined): {
  first: string | null;
  last: string | null;
} {
  if (!full) return { first: null, last: null };
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0]!, last: null };
  return { first: parts[0]!, last: parts.slice(1).join(' ') };
}

/** "1st", "2nd", "3rd+" from LinkedIn's degree badge text. */
export function parseDegree(badge: string | null): string {
  if (!badge) return 'unknown';
  const t = badge.toLowerCase();
  if (t.includes('1st')) return '1st';
  if (t.includes('2nd')) return '2nd';
  if (t.includes('3rd')) return '3rd';
  if (t.includes('out of network')) return 'out';
  return 'unknown';
}
