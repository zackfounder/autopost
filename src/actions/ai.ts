import { leadMessages } from '../db/index.ts';
import { renderTemplate, type ActionDef } from './types.ts';

const leadBrief = (lead: Record<string, unknown>) =>
  [
    `Full name: ${lead.full_name ?? 'unknown'}`,
    `First name: ${lead.first_name ?? 'unknown'}`,
    `Headline: ${lead.headline ?? 'unknown'}`,
    `Company: ${lead.company ?? 'unknown'}`,
    `Location: ${lead.location ?? 'unknown'}`,
    `Connection degree: ${lead.degree ?? 'unknown'}`,
  ].join('\n');

/**
 * Writes the message but does NOT send it — it stores the text in
 * `vars.<into>` so a later `message` or `invite` step uses it via
 * {{vars.<into>}}. Generation and sending stay separate steps so a bad
 * generation never becomes an unrecoverable send.
 */
export const aiMessage: ActionDef = {
  name: 'ai_message',
  description:
    'Have the model write a personalized message for this lead and store it in a variable. ' +
    'Does not send anything. Reference the result from a later step as {{vars.<into>}}. ' +
    'Keeping generation and sending as separate steps means a bad draft is a no-op, not a bad send.',
  ratedLimited: false,
  paramsSchema: {
    brief: 'what the message should accomplish, in your own words',
    into: 'variable name to store the text in, default "ai_message"',
    maxChars: 'hard cap; 300 for an invite note, ~800 for a DM. Default 300',
    tone: 'optional tone instruction',
    system: 'optional full system prompt override',
  },
  async run(ctx) {
    const into = String(ctx.params.into ?? 'ai_message');
    const maxChars = Number(ctx.params.maxChars ?? 300);
    const brief = renderTemplate(String(ctx.params.brief ?? ''), ctx.lead, ctx.vars);

    const system =
      typeof ctx.params.system === 'string'
        ? ctx.params.system
        : [
            'You write short LinkedIn outreach messages on behalf of a real person.',
            'Rules:',
            `- Hard limit ${maxChars} characters. Going over is a failure.`,
            '- Write plainly. No "I hope this finds you well", no "I came across your profile",',
            '  no flattery about their "impressive background", no em dashes.',
            '- Reference one concrete, specific thing from their profile. If the profile gives',
            '  you nothing specific, write a short generic message rather than inventing detail.',
            '- Never state a fact about them that is not in the profile data given to you.',
            '- Output ONLY the message body. No greeting line label, no signature, no quotes.',
            ctx.params.tone ? `- Tone: ${String(ctx.params.tone)}` : '',
          ]
            .filter(Boolean)
            .join('\n');

    const prompt = [
      'Lead profile data:',
      leadBrief(ctx.lead as unknown as Record<string, unknown>),
      '',
      'What this message needs to do:',
      brief,
    ].join('\n');

    try {
      const text = (await ctx.ai.text({ system, prompt, maxTokens: 1_000 }))
        .replace(/^["'`]|["'`]$/g, '')
        .trim()
        .slice(0, maxChars);

      if (!text) {
        return { status: 'fail', counted: false, advance: false, waitSeconds: 900 };
      }
      ctx.vars[into] = text;
      ctx.log(`drafted ${text.length} chars into vars.${into}`);
      return { status: 'ok', counted: false, detail: { into, chars: text.length } };
    } catch (err) {
      // Never let a model outage silently drop a lead — hold and retry.
      return {
        status: 'fail',
        counted: false,
        advance: false,
        waitSeconds: 1_800,
        detail: { error: String(err) },
      };
    }
  },
};

/** Score the lead against an ICP and drop the ones who do not fit. */
export const aiQualify: ActionDef = {
  name: 'ai_qualify',
  description:
    'Score the lead 0-100 against an ideal-customer description and store score plus ' +
    'reasoning in vars. Leads scoring below `minScore` exit the campaign. Put this ' +
    'immediately after visit_profile so you never spend an invite on someone who does not fit.',
  ratedLimited: false,
  paramsSchema: {
    icp: 'plain-English description of who you actually want',
    minScore: 'exit below this, default 60',
    into: 'variable prefix, default "icp"',
  },
  async run(ctx) {
    const icp = String(ctx.params.icp ?? '');
    const minScore = Number(ctx.params.minScore ?? 60);
    const into = String(ctx.params.into ?? 'icp');

    const schema = {
      type: 'object',
      properties: {
        score: { type: 'integer', description: '0-100 fit against the ICP' },
        reason: { type: 'string', description: 'one sentence, citing profile evidence' },
        disqualifier: {
          type: 'string',
          description: 'the single strongest reason against, or empty string',
        },
      },
      required: ['score', 'reason', 'disqualifier'],
      additionalProperties: false,
    };

    try {
      const out = await ctx.ai.json<{ score: number; reason: string; disqualifier: string }>({
        system:
          'You score sales leads against an ideal customer profile. Be strict: a 70+ means ' +
          'you would stake money on the fit. Judge only from the profile data given; if the ' +
          'data is too thin to judge, score low and say so. Do not invent facts.',
        prompt: [
          'Ideal customer profile:',
          icp,
          '',
          'Lead:',
          leadBrief(ctx.lead as unknown as Record<string, unknown>),
        ].join('\n'),
        schema,
      });

      ctx.vars[`${into}_score`] = out.score;
      ctx.vars[`${into}_reason`] = out.reason;
      ctx.log(`ICP ${out.score}: ${out.reason}`);

      if (out.score < minScore) {
        return {
          status: 'ok',
          counted: false,
          exit: { state: 'excluded', reason: `icp_score_${out.score}` },
          detail: out,
        };
      }
      return { status: 'ok', counted: false, detail: out };
    } catch (err) {
      return {
        status: 'fail',
        counted: false,
        advance: false,
        waitSeconds: 1_800,
        detail: { error: String(err) },
      };
    }
  },
};

/** Classify an existing reply so the dashboard can sort the inbox. */
export const aiClassifyReply: ActionDef = {
  name: 'ai_classify_reply',
  description:
    'Classify the most recent inbound reply as positive / neutral / negative / opt_out and ' +
    'store it in vars. Runs on stored message history — no browser work. Place it after ' +
    'check_replies with onReply set to "continue".',
  ratedLimited: false,
  paramsSchema: { into: 'variable prefix, default "reply"' },
  async run(ctx) {
    const into = String(ctx.params.into ?? 'reply');
    const inbound = leadMessages(ctx.lead.lead_id).filter((m) => m.direction === 'in');
    const latest = inbound.at(-1);
    if (!latest) return { status: 'skip', counted: false, detail: { reason: 'no_inbound' } };

    const schema = {
      type: 'object',
      properties: {
        sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'opt_out'] },
        wants_meeting: { type: 'boolean' },
        summary: { type: 'string' },
      },
      required: ['sentiment', 'wants_meeting', 'summary'],
      additionalProperties: false,
    };

    try {
      const out = await ctx.ai.json<{
        sentiment: string;
        wants_meeting: boolean;
        summary: string;
      }>({
        system:
          'Classify a reply to a cold LinkedIn message. "opt_out" means any request to stop ' +
          'being contacted, however politely phrased. Be conservative: only "positive" when ' +
          'they show real interest, not mere politeness.',
        prompt: `Reply text:\n${latest.body}`,
        schema,
      });

      ctx.vars[`${into}_sentiment`] = out.sentiment;
      ctx.vars[`${into}_wants_meeting`] = out.wants_meeting;
      ctx.vars[`${into}_summary`] = out.summary;
      ctx.log(`reply classified ${out.sentiment}`);

      if (out.sentiment === 'opt_out') {
        return {
          status: 'ok',
          counted: false,
          exit: { state: 'excluded', reason: 'opt_out' },
          detail: out,
        };
      }
      return { status: 'ok', counted: false, detail: out };
    } catch (err) {
      return { status: 'fail', counted: false, advance: false, waitSeconds: 1_800, detail: { error: String(err) } };
    }
  },
};
