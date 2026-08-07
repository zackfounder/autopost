import type { PlatformAdapter, PlatformId } from './types.ts';
import { linkedin } from './linkedin.ts';
import { x } from './x.ts';
import { quora } from './quora.ts';
import { indiehackers } from './indiehackers.ts';

export const PLATFORMS: Record<PlatformId, PlatformAdapter> = {
  linkedin,
  x,
  quora,
  indiehackers,
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

/** The capability matrix, for the dashboard and for the agent to read. */
export function describePlatforms() {
  return PLATFORM_IDS.map((id) => {
    const p = PLATFORMS[id];
    return {
      id: p.id,
      displayName: p.displayName,
      can: p.can,
      rules: p.rules,
      defaultLimits: p.defaultLimits,
      loginUrl: p.loginUrl,
    };
  });
}

export type { PlatformAdapter, PlatformId, FeedItem, EngageAction } from './types.ts';
