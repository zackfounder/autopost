import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.ts';
import type {
  Account,
  Campaign,
  Step,
  Lead,
  CampaignLead,
  LeadWithState,
} from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));

let handle: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (handle) return handle;
  mkdirSync(dirname(env.dbPath), { recursive: true });
  handle = new DatabaseSync(env.dbPath);
  handle.exec('PRAGMA foreign_keys = ON');
  return handle;
}

export function initSchema(): void {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  db().exec(sql);
  migrate();
}

/**
 * Additive-only migrations for databases created before a column existed. Each is
 * guarded so re-running is free — `initSchema()` runs on every boot.
 */
function migrate(): void {
  const cols = db()
    .prepare('PRAGMA table_info(accounts)')
    .all() as { name: string }[];
  const has = (c: string) => cols.some((col) => col.name === c);

  // Added when the engine grew beyond LinkedIn. Existing rows are LinkedIn.
  if (!has('platform')) {
    db().exec("ALTER TABLE accounts ADD COLUMN platform TEXT NOT NULL DEFAULT 'linkedin'");
  }
  if (!has('handle')) {
    db().exec('ALTER TABLE accounts ADD COLUMN handle TEXT');
  }
  // A LinkedIn company page is not a separate login. It is the same person,
  // the same session, choosing a different author in the composer. Modelling
  // it as a second account was wrong; this names the page to post as.
  if (!has('post_as')) {
    db().exec('ALTER TABLE accounts ADD COLUMN post_as TEXT');
  }
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

/* ------------------------------------------------------------------ helpers */

function all<T>(sql: string, ...params: unknown[]): T[] {
  return db().prepare(sql).all(...(params as never[])) as T[];
}

function one<T>(sql: string, ...params: unknown[]): T | undefined {
  return db().prepare(sql).get(...(params as never[])) as T | undefined;
}

function run(sql: string, ...params: unknown[]): { lastInsertRowid: number } {
  const r = db().prepare(sql).run(...(params as never[]));
  return { lastInsertRowid: Number(r.lastInsertRowid) };
}

export const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/* ----------------------------------------------------------------- settings */

export function getSetting<T>(key: string, fallback: T): T {
  const row = one<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}

/* ----------------------------------------------------------------- accounts */

export function upsertAccount(
  name: string,
  profileDir: string,
  proxy?: string,
  platform: string = 'linkedin',
): Account {
  run(
    `INSERT INTO accounts (name, profile_dir, proxy, platform) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       profile_dir = excluded.profile_dir,
       proxy       = excluded.proxy,
       platform    = excluded.platform`,
    name,
    profileDir,
    proxy ?? null,
    platform,
  );
  return getAccountByName(name)!;
}

export const listAccountsByPlatform = (platform: string) =>
  all<Account>('SELECT * FROM accounts WHERE platform = ? ORDER BY id', platform);

export const getAccount = (id: number) =>
  one<Account>('SELECT * FROM accounts WHERE id = ?', id);

export const getAccountByName = (name: string) =>
  one<Account>('SELECT * FROM accounts WHERE name = ?', name);

export const listAccounts = () => all<Account>('SELECT * FROM accounts ORDER BY id');

export function setAccountStatus(id: number, status: Account['status'], publicId?: string) {
  run(
    `UPDATE accounts SET status = ?, last_seen_at = datetime('now'),
       public_id = COALESCE(?, public_id) WHERE id = ?`,
    status,
    publicId ?? null,
    id,
  );
}

/* ---------------------------------------------------------------- campaigns */

export function createCampaign(accountId: number, name: string, config: unknown): Campaign {
  run(
    `INSERT INTO campaigns (account_id, name, config) VALUES (?, ?, ?)
     ON CONFLICT(account_id, name) DO UPDATE
       SET config = excluded.config, updated_at = datetime('now')`,
    accountId,
    name,
    JSON.stringify(config ?? {}),
  );
  return one<Campaign>(
    'SELECT * FROM campaigns WHERE account_id = ? AND name = ?',
    accountId,
    name,
  )!;
}

export const getCampaign = (id: number) =>
  one<Campaign>('SELECT * FROM campaigns WHERE id = ?', id);

export const listCampaigns = () => all<Campaign>('SELECT * FROM campaigns ORDER BY id');

export const listRunningCampaigns = () =>
  all<Campaign>("SELECT * FROM campaigns WHERE status = 'running' ORDER BY id");

export function setCampaignStatus(id: number, status: Campaign['status']) {
  run("UPDATE campaigns SET status = ?, updated_at = datetime('now') WHERE id = ?", status, id);
}

/* -------------------------------------------------------------------- steps */

export function replaceSteps(
  campaignId: number,
  steps: { action: string; params?: unknown; enabled?: boolean }[],
): Step[] {
  run('DELETE FROM steps WHERE campaign_id = ?', campaignId);
  steps.forEach((s, i) => {
    run(
      'INSERT INTO steps (campaign_id, position, action, params, enabled) VALUES (?, ?, ?, ?, ?)',
      campaignId,
      i + 1,
      s.action,
      JSON.stringify(s.params ?? {}),
      s.enabled === false ? 0 : 1,
    );
  });
  return listSteps(campaignId);
}

export const listSteps = (campaignId: number) =>
  all<Step>('SELECT * FROM steps WHERE campaign_id = ? ORDER BY position', campaignId);

export const getStep = (campaignId: number, position: number) =>
  one<Step>('SELECT * FROM steps WHERE campaign_id = ? AND position = ?', campaignId, position);

/* -------------------------------------------------------------------- leads */

export function upsertLead(lead: Partial<Lead> & { profile_url: string }): Lead {
  const existing = one<Lead>('SELECT * FROM leads WHERE profile_url = ?', lead.profile_url);
  if (existing) {
    run(
      `UPDATE leads SET
         public_id    = COALESCE(?, public_id),
         member_urn   = COALESCE(?, member_urn),
         full_name    = COALESCE(?, full_name),
         first_name   = COALESCE(?, first_name),
         last_name    = COALESCE(?, last_name),
         headline     = COALESCE(?, headline),
         company      = COALESCE(?, company),
         location     = COALESCE(?, location),
         degree       = COALESCE(?, degree),
         connected_at = COALESCE(?, connected_at),
         profile_json = COALESCE(?, profile_json),
         updated_at   = datetime('now')
       WHERE id = ?`,
      lead.public_id ?? null,
      lead.member_urn ?? null,
      lead.full_name ?? null,
      lead.first_name ?? null,
      lead.last_name ?? null,
      lead.headline ?? null,
      lead.company ?? null,
      lead.location ?? null,
      lead.degree ?? null,
      lead.connected_at ?? null,
      lead.profile_json ?? null,
      existing.id,
    );
    return one<Lead>('SELECT * FROM leads WHERE id = ?', existing.id)!;
  }
  run(
    `INSERT INTO leads
       (profile_url, public_id, member_urn, full_name, first_name, last_name,
        headline, company, location, degree, connected_at, profile_json, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    lead.profile_url,
    lead.public_id ?? null,
    lead.member_urn ?? null,
    lead.full_name ?? null,
    lead.first_name ?? null,
    lead.last_name ?? null,
    lead.headline ?? null,
    lead.company ?? null,
    lead.location ?? null,
    lead.degree ?? 'unknown',
    lead.connected_at ?? null,
    lead.profile_json ?? '{}',
    lead.source ?? null,
  );
  return one<Lead>('SELECT * FROM leads WHERE profile_url = ?', lead.profile_url)!;
}

export const getLead = (id: number) => one<Lead>('SELECT * FROM leads WHERE id = ?', id);

export const findLeadByUrl = (url: string) =>
  one<Lead>('SELECT * FROM leads WHERE profile_url = ?', url);

/* ----------------------------------------------------------- campaign leads */

/** Returns true if the lead was newly enrolled, false if already in the campaign. */
export function enrollLead(campaignId: number, leadId: number, vars?: unknown): boolean {
  const existing = one<CampaignLead>(
    'SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?',
    campaignId,
    leadId,
  );
  if (existing) return false;
  run(
    'INSERT INTO campaign_leads (campaign_id, lead_id, vars) VALUES (?, ?, ?)',
    campaignId,
    leadId,
    JSON.stringify(vars ?? {}),
  );
  return true;
}

/**
 * The scheduler's pick. Returns the single most-advanced lead that is due at
 * `position`, or undefined. Bottom-to-top scanning is the caller's job.
 */
export function nextDueLead(campaignId: number, position: number): LeadWithState | undefined {
  return one<LeadWithState>(
    `SELECT cl.id AS cl_id, cl.campaign_id, cl.lead_id, cl.step_position, cl.state,
            cl.eligible_at, cl.entered_at, cl.last_action_at, cl.attempts, cl.vars, l.*
       FROM campaign_leads cl
       JOIN leads l ON l.id = cl.lead_id
      WHERE cl.campaign_id = ?
        AND cl.step_position = ?
        AND cl.state IN ('ready', 'waiting')
        AND cl.eligible_at <= datetime('now')
        AND l.profile_url NOT IN (SELECT profile_url FROM suppression)
      ORDER BY cl.eligible_at ASC, cl.id ASC
      LIMIT 1`,
    campaignId,
    position,
  );
}

export function advanceLead(clId: number, toPosition: number, waitSeconds = 0): void {
  run(
    `UPDATE campaign_leads
        SET step_position = ?, state = 'ready', attempts = 0,
            eligible_at = datetime('now', ? || ' seconds'),
            last_action_at = datetime('now')
      WHERE id = ?`,
    toPosition,
    `+${Math.max(0, Math.round(waitSeconds))}`,
    clId,
  );
}

export function holdLead(clId: number, waitSeconds: number): void {
  run(
    `UPDATE campaign_leads
        SET state = 'waiting',
            eligible_at = datetime('now', ? || ' seconds'),
            last_action_at = datetime('now')
      WHERE id = ?`,
    `+${Math.max(0, Math.round(waitSeconds))}`,
    clId,
  );
}

export function exitLead(clId: number, state: CampaignLead['state'], reason: string): void {
  run(
    `UPDATE campaign_leads
        SET state = ?, exit_reason = ?, last_action_at = datetime('now')
      WHERE id = ?`,
    state,
    reason,
    clId,
  );
}

export function bumpAttempts(clId: number): number {
  run('UPDATE campaign_leads SET attempts = attempts + 1 WHERE id = ?', clId);
  return one<{ attempts: number }>('SELECT attempts FROM campaign_leads WHERE id = ?', clId)!
    .attempts;
}

export function setLeadVars(clId: number, vars: Record<string, unknown>): void {
  run('UPDATE campaign_leads SET vars = ? WHERE id = ?', JSON.stringify(vars), clId);
}

export function campaignFunnel(campaignId: number) {
  return all<{ step_position: number; state: string; n: number }>(
    `SELECT step_position, state, COUNT(*) AS n
       FROM campaign_leads WHERE campaign_id = ?
      GROUP BY step_position, state ORDER BY step_position`,
    campaignId,
  );
}

/* --------------------------------------------------------------- action log */

export function logAction(entry: {
  accountId: number;
  campaignId?: number | null;
  leadId?: number | null;
  stepPosition?: number | null;
  action: string;
  status: 'ok' | 'skip' | 'fail' | 'blocked';
  counted: boolean;
  detail?: unknown;
}): void {
  run(
    `INSERT INTO action_log
       (account_id, campaign_id, lead_id, step_position, action, status, counted, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    entry.accountId,
    entry.campaignId ?? null,
    entry.leadId ?? null,
    entry.stepPosition ?? null,
    entry.action,
    entry.status,
    entry.counted ? 1 : 0,
    JSON.stringify(entry.detail ?? {}),
  );
}

/** Counted actions of `action` for this account inside a rolling window. */
export function countRecentActions(accountId: number, action: string, hours: number): number {
  const row = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM action_log
      WHERE account_id = ? AND action = ? AND counted = 1
        AND created_at > datetime('now', ? || ' hours')`,
    accountId,
    action,
    `-${hours}`,
  );
  return row?.n ?? 0;
}

export function recentLog(limit = 100) {
  return all<Record<string, unknown>>(
    `SELECT al.*, l.full_name, l.profile_url, c.name AS campaign_name
       FROM action_log al
       LEFT JOIN leads l ON l.id = al.lead_id
       LEFT JOIN campaigns c ON c.id = al.campaign_id
      ORDER BY al.id DESC LIMIT ?`,
    limit,
  );
}

/* ----------------------------------------------------------------- messages */

export function recordMessage(
  leadId: number,
  campaignId: number | null,
  direction: 'in' | 'out',
  body: string,
): void {
  run(
    'INSERT OR IGNORE INTO messages (lead_id, campaign_id, direction, body) VALUES (?, ?, ?, ?)',
    leadId,
    campaignId,
    direction,
    body,
  );
}

export const leadMessages = (leadId: number) =>
  all<{ direction: string; body: string; sent_at: string }>(
    'SELECT direction, body, sent_at FROM messages WHERE lead_id = ? ORDER BY id',
    leadId,
  );

/* -------------------------------------------------------------- suppression */

export function suppress(profileUrl: string, reason: string): void {
  run(
    'INSERT OR IGNORE INTO suppression (profile_url, reason) VALUES (?, ?)',
    profileUrl,
    reason,
  );
}

export const isSuppressed = (profileUrl: string) =>
  Boolean(one('SELECT 1 FROM suppression WHERE profile_url = ?', profileUrl));

export const listSuppressed = () =>
  all<{ profile_url: string; reason: string; created_at: string }>(
    'SELECT * FROM suppression ORDER BY created_at DESC',
  );
