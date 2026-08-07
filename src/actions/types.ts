import type { Page } from 'playwright';
import type { Account, Campaign, LeadWithState, Pacing, Step } from '../db/types.ts';
import type { AiClient } from '../ai/client.ts';

export interface ActionContext {
  page: Page;
  account: Account;
  campaign: Campaign;
  step: Step;
  params: Record<string, unknown>;
  lead: LeadWithState;
  /** Per-lead scratch space, merged from `campaign_leads.vars`. Persisted after each step. */
  vars: Record<string, unknown>;
  pacing: Pacing;
  ai: AiClient;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface ActionResult {
  status: 'ok' | 'skip' | 'fail' | 'blocked';
  /** false = stay on this step (re-run later). Default true. */
  advance?: boolean;
  /** Seconds before this lead is eligible again. */
  waitSeconds?: number;
  /** Set to leave the campaign entirely, with this reason. */
  exit?: { state: 'done' | 'excluded' | 'failed' | 'replied'; reason: string };
  /** Consumes a rate-limit slot for this action. Defaults to true on `ok`. */
  counted?: boolean;
  detail?: Record<string, unknown>;
}

export interface ActionDef {
  name: string;
  /** Human description — also fed to the LLM when it authors a workflow. */
  description: string;
  /**
   * Which connection degrees this action can process. A lead whose degree is not
   * in this list is skipped past the step (Linked Helper does the same thing —
   * "invite" cannot touch a 1st, "message" cannot touch a 3rd).
   * `undefined` means any degree.
   */
  degrees?: string[];
  /** Does a successful run consume a daily quota slot? */
  ratedLimited: boolean;
  paramsSchema?: Record<string, string>;
  run(ctx: ActionContext): Promise<ActionResult>;
}

/** {{first_name}} / {{company}} / {{vars.x}} interpolation for message bodies. */
export function renderTemplate(
  template: string,
  lead: LeadWithState,
  vars: Record<string, unknown>,
): string {
  const bag: Record<string, unknown> = {
    first_name: lead.first_name ?? '',
    last_name: lead.last_name ?? '',
    full_name: lead.full_name ?? '',
    headline: lead.headline ?? '',
    company: lead.company ?? '',
    location: lead.location ?? '',
    ...vars,
  };
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const path = key.startsWith('vars.') ? key.slice(5) : key;
    const v = key.startsWith('vars.') ? vars[path] : bag[path];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Pick one of several message variants deterministically per lead (stable A/B). */
export function pickVariant(variants: string[], leadId: number): string {
  if (variants.length === 0) return '';
  return variants[leadId % variants.length]!;
}
