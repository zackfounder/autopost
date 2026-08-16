import type { PlatformAdapter, PlatformId } from './types.ts';
import { linkedin } from './linkedin.ts';
import { x } from './x.ts';

export const PLATFORMS: Record<PlatformId, PlatformAdapter> = {
  linkedin,
  x,
};

export const PLATFORM_IDS = Object.keys(PLATFORMS) as PlatformId[];

export function getPlatform(id: string): PlatformAdapter {
  const p = PLATFORMS[id as PlatformId];
  if (!p) {
    throw new Error(`unknown platform "${id}". Supported: ${PLATFORM_IDS.join(', ')}`);
  }
  return p;
}

export function isPlatformId(id: string): id is PlatformId {
  return id in PLATFORMS;
}

/**
 * Targeted actions, named by the adapter method that implements them.
 *
 * Derived from what exists rather than declared in a flag, so the capability
 * matrix an agent reads can never claim something the adapter cannot do.
 */
const TARGETED = [
  'reactToPost',
  'commentOnPost',
  'repost',
  'follow',
  'visitProfile',
  'listInvitations',
  'acceptInvitation',
  'withdrawStaleInvitations',
  'myRecentPosts',
  'readPostComments',
  'replyToComment',
  'deletePost',
] as const;

export function targetedActions(p: PlatformAdapter): string[] {
  return TARGETED.filter((m) => typeof p[m] === 'function');
}

/** The capability matrix, for the dashboard and for the agent to read. */
export function describePlatforms() {
  return PLATFORM_IDS.map((id) => {
    const p = PLATFORMS[id];
    return {
      id: p.id,
      displayName: p.displayName,
      can: { ...p.can, targeted: targetedActions(p) },
      rules: p.rules,
      defaultLimits: p.defaultLimits,
      loginUrl: p.loginUrl,
    };
  });
}

export type { PlatformAdapter, PlatformId, FeedItem, EngageAction } from './types.ts';
