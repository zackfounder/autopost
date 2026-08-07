import { z } from 'zod';
import { registry } from '../actions/index.ts';
import {
  createCampaign,
  getAccountByName,
  replaceSteps,
  setCampaignStatus,
  listSteps,
} from '../db/index.ts';
import type { Campaign } from '../db/types.ts';

/**
 * A campaign is a JSON document. This is the instruction surface — the thing a
 * human edits by hand, and the thing an LLM writes when you tell it what you want
 * the outreach to do.
 */
export const StepSchema = z.object({
  action: z.string(),
  params: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  /** Free-text note. Ignored by the engine; there so a workflow reads like a plan. */
  note: z.string().optional(),
});

export const WorkflowSchema = z.object({
  name: z.string().min(1),
  account: z.string().min(1),
  status: z.enum(['draft', 'running', 'paused']).optional(),
  config: z.record(z.unknown()).optional(),
  steps: z.array(StepSchema).min(1),
});

export type WorkflowDoc = z.infer<typeof WorkflowSchema>;

export interface ValidationIssue {
  level: 'error' | 'warning';
  step?: number;
  message: string;
}

/**
 * Structural validation *plus* the funnel rules that Linked Helper enforces in its
 * GUI and that are easy to get wrong when a workflow is authored as text. These
 * are the mistakes that quietly ruin a campaign rather than crash it.
 */
export function validateWorkflow(doc: WorkflowDoc): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  doc.steps.forEach((s, i) => {
    const n = i + 1;
    const def = registry.get(s.action);
    if (!def) {
      issues.push({
        level: 'error',
        step: n,
        message: `unknown action "${s.action}". Known actions: ${[...registry.keys()].join(', ')}`,
      });
      return;
    }
    if (s.action === 'invite') {
      const note = s.params?.note;
      if (typeof note === 'string' && note.length > 300) {
        issues.push({
          level: 'error',
          step: n,
          message: `invite note is ${note.length} chars; LinkedIn's hard cap is 300`,
        });
      }
    }
    if (s.action === 'message' || s.action === 'ai_message') {
      const body = s.params?.body ?? s.params?.brief;
      const variants = s.params?.bodyVariants;
      if (!body && !Array.isArray(variants) && s.action === 'message') {
        issues.push({
          level: 'error',
          step: n,
          message: 'message step needs either `body` or `bodyVariants`',
        });
      }
    }
    if (s.action === 'webhook' && !String(s.params?.url ?? '').startsWith('https://')) {
      issues.push({ level: 'error', step: n, message: 'webhook url must be https' });
    }
  });

  // Rule 1: an invite must be followed (eventually) by filter_connected before any
  // message, or every message step will sit there skipping 2nd-degree leads forever.
  const idxInvite = doc.steps.findIndex((s) => s.action === 'invite');
  const idxMessage = doc.steps.findIndex((s) => s.action === 'message');
  const idxFilter = doc.steps.findIndex((s) => s.action === 'filter_connected');
  if (idxInvite >= 0 && idxMessage > idxInvite && (idxFilter < idxInvite || idxFilter > idxMessage)) {
    issues.push({
      level: 'warning',
      step: idxMessage + 1,
      message:
        'there is an invite before this message but no filter_connected between them. ' +
        'Messages only process 1st-degree leads, so everyone will stall here until they accept. ' +
        'Insert a filter_connected step.',
    });
  }

  // Rule 2: two message steps separated by a plain `delay` instead of `check_replies`.
  // This is the classic Linked Helper mistake: a delay cannot detect a reply, so you
  // keep messaging someone who already answered.
  const messageIdx = doc.steps
    .map((s, i) => (s.action === 'message' ? i : -1))
    .filter((i) => i >= 0);
  for (let k = 1; k < messageIdx.length; k++) {
    const between = doc.steps.slice(messageIdx[k - 1]! + 1, messageIdx[k]!);
    if (!between.some((s) => s.action === 'check_replies')) {
      issues.push({
        level: 'error',
        step: messageIdx[k]! + 1,
        message:
          'two message steps with no check_replies between them. A `delay` waits but cannot ' +
          'see a reply, so this follows up on people who already answered. Use check_replies.',
      });
    }
  }

  // Rule 3: ai_message writes into a var; something later must actually use it.
  doc.steps.forEach((s, i) => {
    if (s.action !== 'ai_message') return;
    const into = String(s.params?.into ?? 'ai_message');
    const usedLater = doc.steps
      .slice(i + 1)
      .some((later) => JSON.stringify(later.params ?? {}).includes(`vars.${into}`));
    if (!usedLater) {
      issues.push({
        level: 'warning',
        step: i + 1,
        message: `ai_message writes vars.${into} but no later step references {{vars.${into}}}. The draft is discarded.`,
      });
    }
  });

  return issues;
}

export interface LoadResult {
  campaign: Campaign;
  issues: ValidationIssue[];
  steps: { position: number; action: string }[];
}

/** Parse, validate, and persist. Errors block the load; warnings do not. */
export function loadWorkflow(input: unknown): LoadResult {
  const doc = WorkflowSchema.parse(input);
  const issues = validateWorkflow(doc);
  if (issues.some((i) => i.level === 'error')) {
    const msg = issues
      .filter((i) => i.level === 'error')
      .map((i) => `step ${i.step ?? '?'}: ${i.message}`)
      .join('\n');
    throw new Error(`workflow has errors:\n${msg}`);
  }

  const account = getAccountByName(doc.account);
  if (!account) {
    throw new Error(
      `no account named "${doc.account}". Create it first: npm run login -- ${doc.account}`,
    );
  }

  const campaign = createCampaign(account.id, doc.name, doc.config ?? {});
  replaceSteps(
    campaign.id,
    doc.steps.map((s) => ({ action: s.action, params: s.params, enabled: s.enabled })),
  );
  setCampaignStatus(campaign.id, doc.status ?? 'paused');

  return {
    campaign,
    issues,
    steps: listSteps(campaign.id).map((s) => ({ position: s.position, action: s.action })),
  };
}
