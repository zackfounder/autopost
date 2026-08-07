import type { ActionDef } from './types.ts';
import {
  visitProfile,
  invite,
  filterConnected,
  follow,
  unfollow,
  withdrawStaleInvites,
} from './network.ts';
import { message, checkReplies } from './messaging.ts';
import { delay, condition, tag, webhook, end } from './flow.ts';
import { aiMessage, aiQualify, aiClassifyReply } from './ai.ts';

const defs: ActionDef[] = [
  visitProfile,
  invite,
  filterConnected,
  follow,
  unfollow,
  withdrawStaleInvites,
  message,
  checkReplies,
  delay,
  condition,
  tag,
  webhook,
  end,
  aiMessage,
  aiQualify,
  aiClassifyReply,
];

export const registry = new Map<string, ActionDef>(defs.map((d) => [d.name, d]));

export const getAction = (name: string) => registry.get(name);

export const actionNames = () => [...registry.keys()];

/** The catalogue, in the shape an LLM needs to author a valid workflow. */
export function describeActions() {
  return [...registry.values()].map((a) => ({
    name: a.name,
    description: a.description,
    degrees: a.degrees ?? 'any',
    rateLimited: a.ratedLimited,
    params: a.paramsSchema ?? {},
  }));
}

export type { ActionDef, ActionContext, ActionResult } from './types.ts';
