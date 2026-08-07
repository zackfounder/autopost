import { getAction } from '../actions/index.ts';
import type { ActionContext, ActionResult } from '../actions/types.ts';
import {
  advanceLead,
  bumpAttempts,
  exitLead,
  holdLead,
  listSteps,
  logAction,
  setLeadVars,
} from '../db/index.ts';
import type { Account, Campaign, LeadWithState, Pacing, Step } from '../db/types.ts';
import type { AiClient } from '../ai/client.ts';
import type { Page } from 'playwright';

const MAX_ATTEMPTS = 3;

export interface RunnerDeps {
  page: Page;
  account: Account;
  ai: AiClient;
  pacing: Pacing;
  onLog?: (line: string) => void;
}

export interface RunOutcome {
  result: ActionResult;
  /** True if this consumed a rate-limit slot. */
  counted: boolean;
}

/**
 * Execute exactly one step for exactly one lead, then persist the consequences.
 * All queue-state transitions live here so the actions themselves stay pure-ish
 * and can be reasoned about one at a time.
 */
export async function runStep(
  deps: RunnerDeps,
  campaign: Campaign,
  step: Step,
  lead: LeadWithState,
): Promise<RunOutcome> {
  const def = getAction(step.action);
  const log = (msg: string, extra?: Record<string, unknown>) => {
    const line = `[${campaign.name} #${step.position} ${step.action}] ${msg}`;
    deps.onLog?.(extra ? `${line} ${JSON.stringify(extra)}` : line);
  };

  if (!def) {
    log(`unknown action "${step.action}" — parking this lead`);
    exitLead(lead.cl_id, 'failed', `unknown_action:${step.action}`);
    logAction({
      accountId: deps.account.id,
      campaignId: campaign.id,
      leadId: lead.lead_id,
      stepPosition: step.position,
      action: step.action,
      status: 'fail',
      counted: false,
      detail: { reason: 'unknown_action' },
    });
    return { result: { status: 'fail' }, counted: false };
  }

  const steps = listSteps(campaign.id);
  const lastPosition = steps.at(-1)?.position ?? step.position;

  // Degree gate — the same rule Linked Helper enforces: an action that cannot
  // process this connection degree skips the lead forward rather than failing.
  if (def.degrees && !def.degrees.includes(lead.degree ?? 'unknown')) {
    log(`degree ${lead.degree} not processable, skipping step`);
    advanceStepOrFinish(lead, step, lastPosition, 0);
    logAction({
      accountId: deps.account.id,
      campaignId: campaign.id,
      leadId: lead.lead_id,
      stepPosition: step.position,
      action: step.action,
      status: 'skip',
      counted: false,
      detail: { reason: 'degree_mismatch', degree: lead.degree },
    });
    return { result: { status: 'skip' }, counted: false };
  }

  let vars: Record<string, unknown> = {};
  try {
    vars = JSON.parse(lead.vars || '{}') as Record<string, unknown>;
  } catch {
    vars = {};
  }

  const ctx: ActionContext = {
    page: deps.page,
    account: deps.account,
    campaign,
    step,
    params: safeParams(step.params),
    lead,
    vars,
    pacing: deps.pacing,
    ai: deps.ai,
    log,
  };

  let result: ActionResult;
  try {
    result = await def.run(ctx);
  } catch (err) {
    log(`threw: ${String(err)}`);
    result = {
      status: 'fail',
      advance: false,
      counted: false,
      waitSeconds: 600,
      detail: { error: String(err) },
    };
  }

  setLeadVars(lead.cl_id, ctx.vars);

  const counted = result.counted ?? (result.status === 'ok' && def.ratedLimited);

  logAction({
    accountId: deps.account.id,
    campaignId: campaign.id,
    leadId: lead.lead_id,
    stepPosition: step.position,
    action: step.action,
    status: result.status,
    counted,
    detail: result.detail ?? {},
  });

  applyResult(lead, step, lastPosition, result, log);
  return { result, counted };
}

function safeParams(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function applyResult(
  lead: LeadWithState,
  step: Step,
  lastPosition: number,
  result: ActionResult,
  log: (m: string) => void,
): void {
  if (result.exit) {
    exitLead(lead.cl_id, result.exit.state, result.exit.reason);
    log(`exited: ${result.exit.state} (${result.exit.reason})`);
    return;
  }

  // A `blocked` result means LinkedIn pushed back (checkpoint, weekly cap). Hold,
  // never burn an attempt, and never advance.
  if (result.status === 'blocked') {
    holdLead(lead.cl_id, result.waitSeconds ?? 3_600);
    log('blocked by LinkedIn — holding this lead');
    return;
  }

  if (result.status === 'fail') {
    const attempts = bumpAttempts(lead.cl_id);
    if (attempts >= MAX_ATTEMPTS) {
      exitLead(lead.cl_id, 'failed', `max_attempts_at_step_${step.position}`);
      log(`failed ${attempts}x — giving up on this lead`);
      return;
    }
    holdLead(lead.cl_id, result.waitSeconds ?? 900);
    log(`failed (attempt ${attempts}/${MAX_ATTEMPTS}) — retrying later`);
    return;
  }

  if (result.advance === false) {
    holdLead(lead.cl_id, result.waitSeconds ?? 3_600);
    return;
  }

  // `condition` with onFalse=skip_next jumps two steps instead of one.
  const jump = Number((result.detail as { jumped?: number } | undefined)?.jumped ?? 1);
  advanceStepOrFinish(lead, step, lastPosition, result.waitSeconds ?? 0, jump);
}

function advanceStepOrFinish(
  lead: LeadWithState,
  step: Step,
  lastPosition: number,
  waitSeconds: number,
  jump = 1,
): void {
  const next = step.position + jump;
  if (next > lastPosition) {
    exitLead(lead.cl_id, 'done', 'reached_end_of_workflow');
    return;
  }
  advanceLead(lead.cl_id, next, waitSeconds);
}
