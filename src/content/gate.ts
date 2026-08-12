import { getPlatform, type PlatformId } from '../platforms/index.ts';
import { getTemplate, isApprovedTemplate, type Template } from './templates.ts';
import { splitThread } from '../platforms/x.ts';

/**
 * THE GATE.
 *
 * Ported from crew-hq's `checkContent`, and it exists for the reason recorded
 * there: prompting alone does not hold. A test post correctly declared its own
 * account type and then broke that exact rule in the body anyway, and the chief
 * model passed it. So every rule that CAN be checked by code is checked by code,
 * on every path, every time. Deterministic, free, and it cannot be talked out of
 * a violation by a persuasive model.
 *
 * Nothing publishes without passing this. Not the agent's "best judgement", not a
 * flag, not an override parameter. There is deliberately no bypass argument.
 */

/** Fails the read-aloud test. From content-pipeline/BRAND_VOICE.md. */
const BANNED_WORDS = [
  'leverage', 'ecosystem', 'streamline', 'empower', 'seamless', 'optimize',
  'unlock', 'game-changer', 'game changer', 'journey', 'passionate',
  'excited to announce', 'thrilled to announce', 'delve', "in today's world",
  'dive deep', 'circle back', 'move the needle', 'low-hanging fruit',
  'revolutionize', 'cutting-edge', 'best-in-class', 'synergy',
];

/** Raw database field names in prose are the clearest tell that a machine wrote it. */
const KPI_KEYS = [
  'total_users', 'paying_users', 'trialing_users', 'active_users_7d',
  'signups_last_7d', 'mrr_usd', 'judgments_7d', 'priorities_done_7d',
  'priorities_locked_7d', 'open_feedback', 'x_followers_latest',
  'hq_month_spend_usd', 'billing_checked_at',
];

const ENGAGEMENT_BAIT =
  /(thoughts\?|let me know in the comments|drop a comment|agree\?|who else|am i the only one|like if you|comment below)/i;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const HASHTAG_RUN = /(^|\s)#\w+(\s+#\w+){2,}/;
const AI_TELL =
  /(as an ai|i'm an ai|language model|i cannot browse|i don't have access to real-?time)/i;

/** Placeholders that survived generation — the single most embarrassing failure mode. */
const UNFILLED_SLOT = /\{\{[^}]+\}\}|\[(insert|your|company|name|number|x)\b[^\]]*\]|<[A-Z_]{3,}>/i;

/**
 * The outreach-mechanics rule from crew-hq's CONTENT_LAW. The audience for these
 * posts overlaps with the people being targeted, so acquisition machinery is never
 * public. Shipped product features are fine.
 */
const OUTREACH_MECHANICS =
  /\b(cold dm|dm script|outreach sequence|drip campaign|lead list|prospect (list|crm)|scraped|scraping|connection request (script|automation)|a\/b test(ed|ing)? (my|our) (dms?|messages?)|linked ?helper|phantombuster|automation tool for linkedin)\b/i;

export interface GateInput {
  platform: PlatformId;
  kind: 'post' | 'dm' | 'comment' | 'reply';
  body: string;
  templateId?: string | null;
  /** Bodies of the last N published items on this account, for a repetition check. */
  recentBodies?: string[];
  /**
   * Where this post's authority comes from.
   *
   * 'template' (the default) is the original rule: a post is only publishable
   * because it derives from a shape in templates/. That is the boundary on an
   * AGENT's autonomy, and it stays exactly as strict as it was.
   *
   * 'founder_approved' is the second, narrower source: Crew HQ wrote it, a
   * chief reviewed it, HQ's content law checked it in code, HQ's surface gate
   * ruled on it, and it only reached a queue because the founder's door opened
   * for that specific deliverable. A template match would add nothing to that
   * chain — it would just mean no HQ post could ever be published.
   *
   * This is a rule change, not a bypass: it is set by the rail, from the fact
   * that HQ queued the job, and NEVER by anything that writes copy. An agent
   * cannot reach it, which is the whole point. Every other rule below still
   * runs unchanged.
   */
  provenance?: 'template' | 'founder_approved';
}

export interface GateResult {
  pass: boolean;
  violations: string[];
  /** Normalized body — trailing whitespace trimmed, nothing else altered. */
  body: string;
}

export function gate(input: GateInput): GateResult {
  const v: string[] = [];
  const body = (input.body ?? '').trim();
  const platform = getPlatform(input.platform);

  if (!body) {
    return { pass: false, violations: ['Body is empty.'], body };
  }

  /* ── 1. Template binding. The boundary on autonomy. ─────────────────────── */
  let template: Template | null = null;
  const founderApproved = input.provenance === 'founder_approved';
  if (input.kind === 'post' && !founderApproved) {
    if (!input.templateId) {
      v.push('No template id. Every post must derive from an approved template in templates/.');
    } else if (!isApprovedTemplate(input.templateId)) {
      v.push(`Template "${input.templateId}" is not in the approved bank. Nothing outside templates/ can be published.`);
    } else {
      template = getTemplate(input.templateId);
      if (template.platform !== input.platform) {
        v.push(`Template "${input.templateId}" belongs to ${template.platform}, not ${input.platform}.`);
      }
    }
  }

  /* ── 2. Unfilled placeholders. ──────────────────────────────────────────── */
  const slotMatch = UNFILLED_SLOT.exec(body);
  if (slotMatch) {
    v.push(`Unfilled placeholder left in the copy: "${slotMatch[0]}". Fill every slot with real content or drop the beat.`);
  }

  /* ── 3. Voice rules (BRAND_VOICE.md, enforced in code). ─────────────────── */
  for (const w of BANNED_WORDS) {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(body)) v.push(`Banned word: "${w}". It fails the read-aloud test.`);
  }
  for (const k of KPI_KEYS) {
    if (body.toLowerCase().includes(k)) {
      v.push(`The raw database field "${k}" is in the copy. Write the number in plain English or drop it.`);
    }
  }
  if (body.includes('—')) v.push('Em-dashes are banned in this brand. Use a full stop or a comma.');
  if (EMOJI.test(body)) v.push('No emoji.');
  if (ENGAGEMENT_BAIT.test(body)) {
    v.push('Ends on engagement bait. End on a real stance or an unresolved bet instead.');
  }
  if (HASHTAG_RUN.test(body)) v.push('Hashtag stuffing. At most one hashtag, and only if it is load-bearing.');
  if (AI_TELL.test(body)) v.push('The copy admits it was written by a model. Rewrite it in the founder\'s voice.');

  /* ── 4. Never publish acquisition machinery. ────────────────────────────── */
  if (OUTREACH_MECHANICS.test(body)) {
    v.push(
      'This describes outreach or growth mechanics (DM scripts, lead lists, automation tooling). ' +
        'The audience overlaps with the targets, so acquisition machinery is never public. Shipped product features are fine.',
    );
  }

  /* ── 5. Platform shape. ─────────────────────────────────────────────────── */
  const rules =
    input.kind === 'dm' ? platform.rules.dm
    : input.kind === 'comment' || input.kind === 'reply' ? platform.rules.comment
    : platform.rules.post;

  if (rules) {
    if (!rules.linksAllowed && /https?:\/\//i.test(body)) {
      v.push(`Links are not allowed in a ${input.platform} ${input.kind}.`);
    }
    if (input.platform === 'x' && input.kind === 'post') {
      // A thread is allowed; an over-length single tweet is not, and neither is an
      // over-length tweet inside a thread.
      const parts = splitThread(body);
      parts.forEach((p, i) => {
        if (p.length > rules.maxChars) {
          v.push(
            parts.length > 1
              ? `Tweet ${i + 1} of the thread is ${p.length} characters. The cap is ${rules.maxChars}.`
              : `This is ${p.length} characters. A single tweet is capped at ${rules.maxChars}. Cut it, or restructure it as a numbered thread.`,
          );
        }
      });
    } else if (body.length > rules.maxChars) {
      v.push(`This is ${body.length} characters. The cap for a ${input.platform} ${input.kind} is ${rules.maxChars}.`);
    }
    if (rules.maxLines) {
      const lines = body.split('\n').filter((l) => l.trim()).length;
      if (lines > rules.maxLines) {
        v.push(`Body is ${lines} lines. The cap is ${rules.maxLines} short lines — you have not found the point yet.`);
      }
    }
  }

  /* ── 6. Template-specific constraints. ──────────────────────────────────── */
  if (template) {
    const c = template.constraints;
    if (c.minChars && body.length < c.minChars) {
      v.push(`Template ${template.id} requires at least ${c.minChars} characters; this is ${body.length}.`);
    }
    if (c.maxChars && !c.perTweet && body.length > c.maxChars) {
      v.push(`Template ${template.id} caps at ${c.maxChars} characters; this is ${body.length}.`);
    }
    if (c.maxLines) {
      const lines = body.split('\n').filter((l) => l.trim()).length;
      if (lines > c.maxLines) v.push(`Template ${template.id} caps at ${c.maxLines} lines; this is ${lines}.`);
    }
    if (c.requiresNumber && !/\d/.test(body)) {
      v.push(`Template ${template.id} requires a real number in the copy. There is no digit anywhere in this draft.`);
    }
    if (c.requiresTitle) {
      const [title, ...rest] = body.split('\n');
      if (!title?.trim() || rest.join('\n').trim().length < 100) {
        v.push(`Template ${template.id} requires "Title\\n\\nBody" with a substantial body. Got ${rest.join('\n').trim().length} body characters.`);
      }
    }
    if (c.isThread) {
      const parts = splitThread(body);
      if (parts.length < 2) {
        v.push(`Template ${template.id} is a thread template but the body is not numbered ("1/ ", "2/ ").`);
      }
    }
  }

  /* ── 7. Repetition against what this account already published. ─────────── */
  for (const prev of input.recentBodies ?? []) {
    const sim = similarity(body, prev);
    if (sim > 0.7) {
      v.push(`This is ${Math.round(sim * 100)}% similar to something this account already published. Write something new.`);
      break;
    }
  }

  return { pass: v.length === 0, violations: v, body };
}

/** Jaccard over lowercased word sets. Cheap, deterministic, good enough to catch a reword. */
function similarity(a: string, b: string): number {
  const wordsOf = (s: string) =>
    new Set(s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
  const A = wordsOf(a);
  const B = wordsOf(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

/** Everything the gate enforces, as prose, for the generation prompt. */
export function gateRulesForPrompt(platform: PlatformId, kind: string): string {
  const p = getPlatform(platform);
  const rules =
    kind === 'dm' ? p.rules.dm : kind === 'comment' ? p.rules.comment : p.rules.post;
  return [
    'HARD RULES — a draft breaking any of these is rejected by code before it can publish:',
    `- Hard cap ${rules?.maxChars ?? '?'} characters${rules?.maxLines ? `, and at most ${rules.maxLines} non-empty lines` : ''}.`,
    '- No em-dashes. No emoji. At most one hashtag.',
    `- Never these words: ${BANNED_WORDS.slice(0, 12).join(', ')}, and the rest of the banned list.`,
    '- Never end on engagement bait ("thoughts?", "let me know in the comments").',
    '- Never mention outreach or growth mechanics: DM scripts, lead lists, prospect CRMs, automation tooling. Shipped product features are fine.',
    '- Never leave a placeholder like {{slot}} or [your company] in the copy.',
    '- Never write a raw database field name. Say the number in plain English.',
    rules && !rules.linksAllowed ? '- No links in the body.' : '',
    '- Output ONLY the finished copy. No preamble, no explanation, no surrounding quotes.',
  ]
    .filter(Boolean)
    .join('\n');
}
