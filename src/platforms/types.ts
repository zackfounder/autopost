import type { Page } from 'playwright';
import type { Candidates } from '../browser/selectors.ts';

export type PlatformId = 'linkedin' | 'x' | 'quora' | 'indiehackers';

export interface FeedItem {
  /** Stable identifier for dedup — permalink where possible, else author+hash. */
  ref: string;
  author: string | null;
  excerpt: string;
  permalink: string | null;
  /** Index of the item in the rendered feed, for clicking it again. */
  index: number;
}

export type EngageAction = 'like' | 'upvote' | 'comment';

export interface ContentRules {
  /** Hard character ceiling for a single unit of content. */
  maxChars: number;
  /** Some platforms punish outbound links in the post body. */
  linksAllowed: boolean;
  /** Can a long post be split into a numbered thread? */
  threads: boolean;
  /** Max lines before a post reads as a wall of text on this platform. */
  maxLines?: number;
}

export interface PlatformAdapter {
  id: PlatformId;
  displayName: string;
  homeUrl: string;
  loginUrl: string;
  /** URL patterns that mean "not logged in" or "challenged". */
  loggedOutPatterns: RegExp;
  checkpointPatterns: RegExp;
  /**
   * A URL only an authenticated session is redirected to. LinkedIn sends you to
   * /feed and X to /home once you are in, and bounce you elsewhere if you are
   * not — far more reliable than a DOM selector, which both platforms rotate.
   */
  loggedInPatterns?: RegExp;
  /**
   * Fallback for platforms with no such redirect. Quora and Indie Hackers put
   * their login in a modal over the homepage, so the address bar reads the same
   * either way and only the DOM can tell you.
   */
  loggedInSelectors?: string[];

  /** Which of the capabilities below are actually implemented for this platform. */
  can: {
    post: boolean;
    dm: boolean;
    feed: boolean;
    engage: EngageAction[];
  };

  rules: {
    post: ContentRules;
    dm?: ContentRules;
    comment?: ContentRules;
  };

  /** Conservative per-action daily/hourly caps for this platform. */
  defaultLimits: Record<string, { perDay?: number; perHour?: number }>;

  /** All selectors for this platform, in one place. */
  sel: Record<string, Candidates>;

  /** Publish a post. Returns the permalink when the platform exposes one. */
  post?(
    page: Page,
    body: string,
    /** Post as a page the owner administers, by its exact name, instead of as themselves. */
    opts?: { postAs?: string | null },
  ): Promise<{ ok: boolean; permalink?: string; error?: string }>;

  /** Send a direct message to a profile URL or handle. */
  dm?(page: Page, target: string, body: string): Promise<{ ok: boolean; error?: string }>;

  /**
   * Remove something this account published.
   *
   * `url` is the permalink. Deleting is irreversible on every one of these
   * platforms — there is no trash — so an adapter must confirm the post is
   * actually gone rather than reporting success off a click, and must refuse
   * outright if it cannot confirm whose post it is.
   */
  deletePost?(page: Page, url: string): Promise<{ ok: boolean; error?: string }>;

  /** Read the feed and return candidate items to engage with. */
  readFeed?(page: Page, limit: number): Promise<FeedItem[]>;

  /** React to one feed item. `comment` requires a body. */
  engage?(
    page: Page,
    item: FeedItem,
    action: EngageAction,
    body?: string,
  ): Promise<{ ok: boolean; error?: string }>;
}
