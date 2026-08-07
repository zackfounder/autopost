import type { Page } from 'playwright';

/**
 * Reads via LinkedIn's own internal /voyager/ API — but issued from *inside* the
 * logged-in page context, so the request carries the real session cookies, the real
 * CSRF token, the real Origin, and sits inside the normal request stream for that
 * page. That is the whole point: an out-of-band HTTP client with a copied cookie
 * produces a request map no human browser produces.
 *
 * Voyager response shapes are undocumented and change without notice. Everything
 * here is defensive and every function degrades to null rather than throwing — the
 * DOM path in actions/ is the source of truth for anything load-bearing.
 */

export interface VoyagerProfile {
  publicId?: string;
  memberUrn?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  locationName?: string;
  company?: string;
  raw?: unknown;
}

async function voyagerGet(page: Page, path: string): Promise<unknown | null> {
  return page.evaluate(async (p: string) => {
    const csrf = document.cookie
      .split('; ')
      .find((c) => c.startsWith('JSESSIONID='))
      ?.split('=')[1]
      ?.replace(/"/g, '');
    if (!csrf) return null;
    try {
      const res = await fetch(`https://www.linkedin.com${p}`, {
        credentials: 'include',
        headers: {
          accept: 'application/vnd.linkedin.normalized+json+2.1',
          'csrf-token': csrf,
          'x-restli-protocol-version': '2.0.0',
        },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }, path);
}

function pick(obj: unknown, ...keys: string[]): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.length) return v;
  }
  return undefined;
}

/**
 * Fetch the identity record for a public id (the `xyz` in linkedin.com/in/xyz).
 * Returns null on any failure — callers must have a DOM fallback.
 */
export async function fetchProfile(
  page: Page,
  publicId: string,
): Promise<VoyagerProfile | null> {
  const data = await voyagerGet(
    page,
    `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(
      publicId,
    )}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-96`,
  );
  if (!data || typeof data !== 'object') return null;

  const included = (data as { included?: unknown[] }).included ?? [];
  const profileNode = included.find(
    (n) =>
      n &&
      typeof n === 'object' &&
      String((n as Record<string, unknown>).$type ?? '').includes('identity.profile.Profile'),
  );
  if (!profileNode) return { raw: data };

  const p = profileNode as Record<string, unknown>;
  return {
    publicId: pick(p, 'publicIdentifier'),
    memberUrn: pick(p, 'entityUrn'),
    firstName: pick(p, 'firstName'),
    lastName: pick(p, 'lastName'),
    headline: pick(p, 'headline'),
    locationName:
      pick(p, 'geoLocationName', 'locationName') ??
      pick(p['location'] as Record<string, unknown> | undefined, 'preferredGeoPlace'),
    raw: profileNode,
  };
}

/**
 * The conversations list, newest first. Used by `check_replies` as a fast path so
 * the engine does not have to open one thread per lead just to learn nothing
 * changed.
 */
export async function fetchConversations(page: Page, limit = 40): Promise<unknown[] | null> {
  const data = await voyagerGet(
    page,
    `/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&count=${limit}`,
  );
  if (!data || typeof data !== 'object') return null;
  const elements = (data as { elements?: unknown[] }).elements;
  return Array.isArray(elements) ? elements : [];
}
