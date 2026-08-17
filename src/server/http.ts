import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.ts';
import { engine } from '../engine/scheduler.ts';
import { loadWorkflow, validateWorkflow, WorkflowSchema } from '../engine/workflow.ts';
import { describeActions } from '../actions/index.ts';
import {
  campaignFunnel,
  getCampaign,
  listAccounts,
  listCampaigns,
  listSteps,
  listSuppressed,
  recentLog,
  setCampaignStatus,
  suppress,
  upsertLead,
  enrollLead,
  getAccountByName,
} from '../db/index.ts';
import {
  loadLimits,
  loadPacing,
  loadWorkingHours,
  quotaSnapshot,
  saveLimits,
  savePacing,
  saveWorkingHours,
  setGloballyPaused,
  isGloballyPaused,
} from '../engine/limits.ts';
import { importCsv } from '../sources/csv.ts';
import { harvestSearch } from '../sources/search.ts';
import { openSession } from '../browser/session.ts';
import { normalizeProfileUrl, publicIdOf } from '../util/url.ts';
import { dashboardHtml } from './dashboard.ts';
import { describePlatforms, isPlatformId } from '../platforms/index.ts';
import { loadTemplates } from '../content/templates.ts';
import { gate } from '../content/gate.ts';
import { generate, loadInstructions } from '../content/generate.ts';
import { buildAiClient } from '../ai/client.ts';
import {
  createContent, getContent, listContent, setContentState, recentPublishedBodies,
  templateUsage, listJobs, createJob, setJobState, deleteJob, recentFeedActions,
} from '../db/content.ts';

type Handler = (
  body: Record<string, unknown>,
  query: URLSearchParams,
) => Promise<unknown> | unknown;

const routes = new Map<string, Handler>();
const get = (path: string, h: Handler) => routes.set(`GET ${path}`, h);
const post = (path: string, h: Handler) => routes.set(`POST ${path}`, h);

/* ------------------------------------------------------------------ routes */

get('/api/health', () => ({
  ok: true,
  engine: engine.status(),
  // Ask the client what it is. Guessing from a key name reported 'mock' while
  // Groq was really generating.
  ai: buildAiClient().kind,
}));

get('/api/actions', () => describeActions());

get('/api/accounts', () => listAccounts());

get('/api/campaigns', () =>
  listCampaigns().map((c) => ({
    ...c,
    steps: listSteps(c.id).map((s) => ({ position: s.position, action: s.action })),
    funnel: campaignFunnel(c.id),
  })),
);

get('/api/campaign', (_b, q) => {
  const id = Number(q.get('id'));
  const campaign = getCampaign(id);
  if (!campaign) throw new HttpError(404, 'no such campaign');
  return { campaign, steps: listSteps(id), funnel: campaignFunnel(id) };
});

post('/api/campaign/validate', (body) => {
  const doc = WorkflowSchema.parse(body.workflow ?? body);
  return { issues: validateWorkflow(doc) };
});

post('/api/campaign/load', (body) => loadWorkflow(body.workflow ?? body));

post('/api/campaign/status', (body) => {
  const id = Number(body.id);
  const status = String(body.status) as 'running' | 'paused' | 'draft' | 'done';
  if (!getCampaign(id)) throw new HttpError(404, 'no such campaign');
  if (!['running', 'paused', 'draft', 'done'].includes(status)) {
    throw new HttpError(400, 'status must be running | paused | draft | done');
  }
  setCampaignStatus(id, status);
  return { id, status };
});

post('/api/leads/add', (body) => {
  const campaignId = body.campaignId ? Number(body.campaignId) : undefined;
  const urls = Array.isArray(body.urls) ? (body.urls as string[]) : [];
  let added = 0;
  let enrolled = 0;
  const rejected: string[] = [];
  for (const raw of urls) {
    const url = normalizeProfileUrl(raw);
    if (!url) {
      rejected.push(raw);
      continue;
    }
    const lead = upsertLead({
      profile_url: url,
      public_id: publicIdOf(url) ?? undefined,
      source: String(body.source ?? 'manual'),
    });
    added++;
    if (campaignId && enrollLead(campaignId, lead.id)) enrolled++;
  }
  return { added, enrolled, rejected };
});

post('/api/leads/import-csv', (body) =>
  importCsv(String(body.path), {
    campaignId: body.campaignId ? Number(body.campaignId) : undefined,
    source: body.source ? String(body.source) : undefined,
  }),
);

post('/api/leads/harvest', async (body) => {
  const accountName = String(body.account);
  const account = getAccountByName(accountName);
  if (!account) throw new HttpError(404, `no account named "${accountName}"`);
  const session = await openSession(account);
  return harvestSearch(session.page, {
    url: String(body.url),
    maxPages: body.maxPages ? Number(body.maxPages) : undefined,
    maxLeads: body.maxLeads ? Number(body.maxLeads) : undefined,
    campaignId: body.campaignId ? Number(body.campaignId) : undefined,
    source: body.source ? String(body.source) : 'search',
    onLog: (l) => engine.log(l),
  });
});

get('/api/log', (_b, q) => recentLog(Number(q.get('limit') ?? 100)));
get('/api/engine/tail', (_b, q) => engine.tail(Number(q.get('n') ?? 80)));

post('/api/engine/start', () => {
  engine.start();
  return engine.status();
});
post('/api/engine/stop', async () => {
  await engine.stop();
  return engine.status();
});
post('/api/engine/pause', (body) => {
  setGloballyPaused(body.paused !== false);
  return { paused: isGloballyPaused() };
});

get('/api/limits', (_b, q) => {
  const accounts = listAccounts();
  const wanted = q.get('account');
  const selected = wanted ? accounts.filter((a) => a.name === wanted) : accounts;
  return {
    limits: loadLimits(),
    workingHours: loadWorkingHours(),
    pacing: loadPacing(),
    // One budget block per connected account, since caps differ by platform.
    usage: selected.map((a) => ({
      account: a.name,
      platform: a.platform,
      status: a.status,
      quota: quotaSnapshot(a.id, a.platform),
    })),
  };
});

post('/api/limits', (body) => {
  if (body.limits) saveLimits(body.limits as never);
  if (body.workingHours) saveWorkingHours(body.workingHours as never);
  if (body.pacing) savePacing(body.pacing as never);
  return { limits: loadLimits(), workingHours: loadWorkingHours(), pacing: loadPacing() };
});

/* ── multi-platform: templates, content, jobs ───────────────────────────── */

get('/api/platforms', () => describePlatforms());

get('/api/templates', (_b, q) => {
  const platform = q.get('platform');
  const all = [...loadTemplates(true).values()];
  return platform ? all.filter((t) => t.platform === platform) : all;
});

get('/api/instructions', (_b, q) => {
  const platform = q.get('platform') ?? 'linkedin';
  if (!isPlatformId(platform)) throw new HttpError(400, `unknown platform "${platform}"`);
  return { platform, text: loadInstructions(platform) };
});

/** Gate an arbitrary body without generating or publishing anything. */
post('/api/content/check', (body) => {
  const platform = String(body.platform ?? '');
  if (!isPlatformId(platform)) throw new HttpError(400, `unknown platform "${platform}"`);
  return gate({
    platform,
    kind: (String(body.kind ?? 'post') as 'post' | 'dm' | 'comment' | 'reply'),
    body: String(body.body ?? ''),
    templateId: body.templateId ? String(body.templateId) : null,
  });
});

/** Generate + gate a draft. Saves it as `drafted`; does NOT queue or publish. */
post('/api/content/draft', async (body) => {
  const platform = String(body.platform ?? '');
  if (!isPlatformId(platform)) throw new HttpError(400, `unknown platform "${platform}"`);
  const account = getAccountByName(String(body.account));
  if (!account) throw new HttpError(404, `no account "${String(body.account)}"`);

  const result = await generate({
    ai: buildAiClient(),
    platform,
    kind: (String(body.kind ?? 'post') as 'post' | 'dm' | 'comment' | 'reply'),
    brief: String(body.brief ?? ''),
    facts: body.facts ? String(body.facts) : undefined,
    templateId: body.templateId ? String(body.templateId) : undefined,
    usage: templateUsage(account.id),
    recentBodies: recentPublishedBodies(account.id),
    onLog: (l) => engine.log(l),
  });

  const row = createContent({
    accountId: account.id,
    platform,
    kind: String(body.kind ?? 'post'),
    templateId: result.templateId,
    targetRef: body.targetRef ? String(body.targetRef) : null,
    body: result.body,
    state: result.ok ? 'drafted' : 'blocked',
    violations: result.violations,
    meta: { brief: String(body.brief ?? '') },
  });
  return { content: row, gate: { pass: result.ok, violations: result.violations } };
});

get('/api/content', (_b, q) => listContent(Number(q.get('limit') ?? 60)));

/** Move a draft into the publish queue, or block it. Re-gated at publish time too. */
post('/api/content/state', (body) => {
  const id = Number(body.id);
  const item = getContent(id);
  if (!item) throw new HttpError(404, 'no such content');
  const state = String(body.state);
  if (!['queued', 'blocked', 'skipped', 'drafted'].includes(state)) {
    throw new HttpError(400, 'state must be queued | blocked | skipped | drafted');
  }
  if (state === 'queued') {
    const check = gate({
      platform: item.platform as never,
      kind: item.kind as 'post' | 'dm' | 'comment' | 'reply',
      body: item.body,
      templateId: item.template_id,
    });
    if (!check.pass) {
      setContentState(id, 'blocked', { violations: check.violations });
      throw new HttpError(400, `cannot queue: ${check.violations.join(' | ')}`);
    }
  }
  setContentState(id, state as never);
  return getContent(id);
});

get('/api/jobs', () => listJobs());

post('/api/jobs', (body) => {
  const account = getAccountByName(String(body.account));
  if (!account) throw new HttpError(404, `no account "${String(body.account)}"`);
  return createJob({
    accountId: account.id,
    kind: String(body.kind),
    payload: body.payload ?? {},
    recurrence: body.recurrence ? String(body.recurrence) : null,
    runAt: body.runAt ? String(body.runAt) : undefined,
  });
});

post('/api/jobs/state', (body) => {
  const id = Number(body.id);
  if (body.remove === true) {
    deleteJob(id);
    return { id, deleted: true };
  }
  setJobState(id, String(body.state) as never);
  return { id, state: body.state };
});

get('/api/feed', (_b, q) => recentFeedActions(Number(q.get('limit') ?? 40)));

get('/api/suppression', () => listSuppressed());
post('/api/suppression', (body) => {
  const url = normalizeProfileUrl(String(body.url));
  if (!url) throw new HttpError(400, 'not a LinkedIn profile URL');
  suppress(url, String(body.reason ?? 'manual'));
  return { url, suppressed: true };
});

/* ------------------------------------------------------------------ server */

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Bearer check, in constant time.
 *
 * `===` on strings returns as soon as two bytes differ, which leaks the token a
 * character at a time to anyone who can measure the difference. timingSafeEqual
 * needs equal lengths, so length is compared first and separately — that much is
 * public anyway.
 */
function authorized(req: IncomingMessage): boolean {
  // No token set is only survivable because the server is bound to loopback;
  // startServer() refuses to start otherwise.
  if (!env.apiToken) return true;
  const header = req.headers.authorization ?? '';
  const expected = `Bearer ${env.apiToken}`;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/** Is this address reachable only from this machine? */
function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

function send(res: ServerResponse, status: number, payload: unknown, contentType = 'application/json') {
  const body = contentType === 'application/json' ? JSON.stringify(payload, null, 2) : String(payload);
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

export function startServer(): void {
  // Fail closed. The dashboard route below serves the API token to anyone who
  // loads it, and the API it unlocks can publish to a real LinkedIn account —
  // so an unauthenticated server that anything but this machine can reach is
  // not a warning, it is a refusal.
  if (!isLoopback(env.bindHost) && !env.apiToken) {
    console.error(
      `refusing to start: BIND_HOST is ${env.bindHost}, which other machines can reach, ` +
      'and API_TOKEN is empty.\nSet API_TOKEN (npm run setup generates one) or bind to 127.0.0.1.',
    );
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${env.port}`);

    // The dashboard page carries the API token so the browser can call the API.
    // That is only safe because the socket is loopback-only; if it ever is not,
    // the page must be earned like every other route.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!isLoopback(env.bindHost) && !authorized(req)) {
        return send(res, 401, { error: 'set Authorization: Bearer <API_TOKEN>' });
      }
      return send(res, 200, dashboardHtml(env.apiToken), 'text/html; charset=utf-8');
    }

    if (!authorized(req)) {
      return send(res, 401, { error: 'set Authorization: Bearer <API_TOKEN>' });
    }

    const key = `${req.method} ${url.pathname}`;
    const handler = routes.get(key);
    if (!handler) return send(res, 404, { error: `no route ${key}` });

    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = await handler(body, url.searchParams);
      send(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(env.port, env.bindHost, () => {
    console.log(`social-media-automation-agent dashboard  http://localhost:${env.port}`);
    console.log(`bound to                  ${env.bindHost}${isLoopback(env.bindHost) ? ' (this machine only)' : '  ← REACHABLE FROM THE NETWORK'}`);
    // Ask the client what it actually is. This line used to guess from
    // ANTHROPIC_API_KEY alone, so adding Groq made it report 'mock' while
    // generation was really running on Groq — the one line whose whole job is
    // to tell you which provider you are on, quietly lying about it.
    console.log(`AI provider               ${buildAiClient().kind}`);
    if (!env.apiToken) {
      console.log('WARNING: API_TOKEN is empty. Nothing but this machine can reach the');
      console.log('         server, but anything running on it can. `npm run setup` fixes this.');
    }
  });
}
