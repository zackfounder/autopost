import { suppress } from '../db/index.ts';
import { renderTemplate, type ActionDef } from './types.ts';

export const delay: ActionDef = {
  name: 'delay',
  description:
    'Hold the lead for a fixed time, then move on. Use between NON-messaging actions. ' +
    'Between two messages use `check_replies` instead — a delay cannot detect a reply.',
  ratedLimited: false,
  paramsSchema: { hours: 'hours to wait, default 24', jitterHours: 'random extra, default 6' },
  async run(ctx) {
    const hours = Number(ctx.params.hours ?? 24);
    const jitter = Number(ctx.params.jitterHours ?? 6);
    const waited = ctx.lead.state === 'waiting';
    if (waited) return { status: 'ok', counted: false };
    return {
      status: 'skip',
      advance: false,
      counted: false,
      waitSeconds: Math.round((hours + Math.random() * jitter) * 3600),
    };
  },
};

/**
 * IF-THEN-ELSE. Evaluates a small allow-listed expression against lead fields and
 * vars — deliberately not `eval`, because campaign JSON may be authored by an LLM.
 */
export const condition: ActionDef = {
  name: 'condition',
  description:
    'Branch. Evaluates `field` against `value` with `op` (eq, neq, contains, ' +
    'not_contains, gt, lt, exists, missing). On a match the lead continues to the next ' +
    'step; otherwise it takes `onFalse`: "exit" (default), "skip_next" (jump two steps), ' +
    'or "continue". Fields: any lead column, or vars.<name>.',
  ratedLimited: false,
  paramsSchema: {
    field: 'lead column (headline, company, degree, location...) or vars.<name>',
    op: 'eq | neq | contains | not_contains | gt | lt | exists | missing',
    value: 'comparison value',
    onFalse: 'exit | skip_next | continue',
  },
  async run(ctx) {
    const field = String(ctx.params.field ?? '');
    const op = String(ctx.params.op ?? 'exists');
    const want = ctx.params.value;

    const raw = field.startsWith('vars.')
      ? ctx.vars[field.slice(5)]
      : (ctx.lead as unknown as Record<string, unknown>)[field];

    const s = raw === null || raw === undefined ? '' : String(raw).toLowerCase();
    const w = want === null || want === undefined ? '' : String(want).toLowerCase();

    let pass: boolean;
    switch (op) {
      case 'eq':
        pass = s === w;
        break;
      case 'neq':
        pass = s !== w;
        break;
      case 'contains':
        pass = s.includes(w);
        break;
      case 'not_contains':
        pass = !s.includes(w);
        break;
      case 'gt':
        pass = Number(raw) > Number(want);
        break;
      case 'lt':
        pass = Number(raw) < Number(want);
        break;
      case 'missing':
        pass = s === '';
        break;
      case 'exists':
      default:
        pass = s !== '';
        break;
    }

    ctx.log(`condition ${field} ${op} ${String(want)} -> ${pass}`);
    if (pass) return { status: 'ok', counted: false, detail: { pass } };

    const onFalse = String(ctx.params.onFalse ?? 'exit');
    if (onFalse === 'continue') return { status: 'skip', counted: false, detail: { pass } };
    if (onFalse === 'skip_next') {
      return { status: 'skip', counted: false, detail: { pass, jumped: 2 }, waitSeconds: 0 };
    }
    return {
      status: 'skip',
      counted: false,
      exit: { state: 'excluded', reason: `condition_failed:${field}` },
    };
  },
};

export const tag: ActionDef = {
  name: 'tag',
  description: 'Write a value into the lead\'s campaign vars. Pure bookkeeping, no browser work.',
  ratedLimited: false,
  paramsSchema: { key: 'var name', value: 'template string' },
  async run(ctx) {
    const key = String(ctx.params.key ?? 'tag');
    ctx.vars[key] = renderTemplate(String(ctx.params.value ?? ''), ctx.lead, ctx.vars);
    return { status: 'ok', counted: false, detail: { [key]: ctx.vars[key] } };
  },
};

export const webhook: ActionDef = {
  name: 'webhook',
  description:
    'POST the lead plus an explicit `event` name to `url`. Unlike Linked Helper, the event ' +
    'name is part of the body, so the receiver never has to guess what happened from the ' +
    'query string. Fires for every lead that reaches this step.',
  ratedLimited: false,
  paramsSchema: {
    url: 'https endpoint',
    event: 'event name written into the body',
    include: 'array of lead fields to send; default a safe subset',
  },
  async run(ctx) {
    const url = String(ctx.params.url ?? '');
    if (!/^https:\/\//.test(url)) {
      return { status: 'fail', counted: false, detail: { reason: 'url_must_be_https' } };
    }

    const defaults = [
      'profile_url',
      'public_id',
      'full_name',
      'first_name',
      'last_name',
      'headline',
      'company',
      'location',
      'degree',
      'connected_at',
    ];
    const fields = Array.isArray(ctx.params.include)
      ? (ctx.params.include as string[])
      : defaults;

    const lead: Record<string, unknown> = {};
    for (const f of fields) lead[f] = (ctx.lead as unknown as Record<string, unknown>)[f] ?? null;

    const body = {
      event: String(ctx.params.event ?? 'step'),
      campaign: ctx.campaign.name,
      step: ctx.step.position,
      at: new Date().toISOString(),
      lead,
      vars: ctx.vars,
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      return {
        status: res.ok ? 'ok' : 'fail',
        counted: false,
        advance: res.ok,
        detail: { httpStatus: res.status },
      };
    } catch (err) {
      return {
        status: 'fail',
        counted: false,
        advance: false,
        waitSeconds: 900,
        detail: { error: String(err) },
      };
    }
  },
};

export const end: ActionDef = {
  name: 'end',
  description: 'Terminal step. Marks the lead done and removes them from the queue.',
  ratedLimited: false,
  paramsSchema: { suppress: 'boolean; also add to the global never-contact list' },
  async run(ctx) {
    if (ctx.params.suppress === true) {
      suppress(ctx.lead.profile_url, `campaign:${ctx.campaign.name}`);
    }
    return {
      status: 'ok',
      counted: false,
      exit: { state: 'done', reason: 'completed_workflow' },
    };
  },
};
