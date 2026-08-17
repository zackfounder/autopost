import type { Page } from 'playwright';
import type { Candidates } from '../browser/selectors.ts';

export type PlatformId = 'linkedin' | 'x' | 'bluesky';

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

/** LinkedIn's reaction set. `like` is the plain click; the rest need the flyout. */
export type ReactionType = 'like' | 'celebrate' | 'support' | 'love' | 'insightful' | 'funny';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** One comment under a post this account owns. */
export interface PostComment {
  /** Author + a slice of the text. LinkedIn exposes no stable comment id in the DOM. */
  ref: string;
  author: string | null;
  text: string;
  index: number;
  /** True when this account already replied somewhere in the thread below it. */
  answered: boolean;
}

/** A pending incoming connection request. */
export interface Invitation {
  ref: string;
  name: string | null;
  headline: string | null;
  index: number;
}

/** What a profile visit reads back. The visit itself is the point — the target is notified. */
export interface ProfileSnapshot {
  url: string;
  name: string | null;
  headline: string | null;
}

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
  /** Fallback for a platform with no such redirect: only the DOM can tell you. */
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
  deletePost?(
    page: Page,
    /** A permalink where the platform gives one, or the post's text where it does not. */
    ref: string,
    opts?: { listingUrl?: string },
  ): Promise<{ ok: boolean; error?: string }>;

  /** Read the feed and return candidate items to engage with. */
  readFeed?(page: Page, limit: number): Promise<FeedItem[]>;

  /** React to one feed item. `comment` requires a body. */
  engage?(
    page: Page,
    item: FeedItem,
    action: EngageAction,
    body?: string,
  ): Promise<{ ok: boolean; error?: string }>;

  /* ── Targeted actions ──────────────────────────────────────────────────────
   *
   * Everything above works on the feed, which means the platform chooses what
   * this account sees. These work on a URL you name, which is how you engage
   * deliberately — with a specific person's post, at a time you decided.
   *
   * All optional: an adapter implements what its platform actually supports,
   * and the job layer checks for the method before offering the action.
   */

  /** React to a post by permalink. `like` is a click; the rest need the flyout. */
  reactToPost?(page: Page, url: string, reaction: ReactionType): Promise<ActionResult>;

  /** Comment on a post by permalink. The body has already passed the gate. */
  commentOnPost?(page: Page, url: string, body: string): Promise<ActionResult>;

  /** Share a post to your own feed, optionally with your own line above it. */
  repost?(page: Page, url: string, thought?: string): Promise<ActionResult>;

  /** Follow a person or a company page without connecting. */
  follow?(page: Page, url: string): Promise<ActionResult>;

  /**
   * Open a profile and read it. The read is incidental — the visit is the
   * action, because the other person is told you looked.
   */
  visitProfile?(page: Page, url: string): Promise<ProfileSnapshot & { ok: boolean; error?: string }>;

  /** Pending incoming connection requests, newest first. */
  listInvitations?(page: Page, limit: number): Promise<Invitation[]>;

  /** Accept one pending request. */
  acceptInvitation?(page: Page, invitation: Invitation): Promise<ActionResult>;

  /**
   * Withdraw invitations you sent that were never answered. LinkedIn counts
   * outstanding invites against a weekly cap that no tool can raise, so old
   * ones nobody accepted are quota you are paying for and not using.
   */
  withdrawStaleInvitations?(
    page: Page,
    olderThanDays: number,
    max: number,
  ): Promise<{ ok: boolean; withdrawn: number; error?: string }>;

  /** Posts this account published, newest first, with permalinks where they exist. */
  myRecentPosts?(page: Page, limit: number): Promise<{ url: string; excerpt: string }[]>;

  /** Comments left under one of your posts. */
  readPostComments?(page: Page, postUrl: string, limit: number): Promise<PostComment[]>;

  /** Reply to one comment under your post. The body has already passed the gate. */
  replyToComment?(page: Page, postUrl: string, comment: PostComment, body: string): Promise<ActionResult>;
}
