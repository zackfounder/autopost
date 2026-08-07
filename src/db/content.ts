import { db } from './index.ts';
import type { PlatformId } from '../platforms/index.ts';

/* ------------------------------------------------------------------ helpers */

const all = <T>(sql: string, ...p: unknown[]) => db().prepare(sql).all(...(p as never[])) as T[];
const one = <T>(sql: string, ...p: unknown[]) =>
  db().prepare(sql).get(...(p as never[])) as T | undefined;
const run = (sql: string, ...p: unknown[]) => {
  const r = db().prepare(sql).run(...(p as never[]));
  return Number(r.lastInsertRowid);
};

/* ------------------------------------------------------------------ content */

export interface ContentRow {
  id: number;
  account_id: number;
  platform: string;
  kind: string;
  template_id: string | null;
  target_ref: string | null;
  body: string;
  state: 'drafted' | 'blocked' | 'queued' | 'published' | 'failed' | 'skipped';
  violations: string;
  attempts: number;
  permalink: string | null;
  meta: string;
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string;
}

export function createContent(row: {
  accountId: number;
  platform: string;
  kind: string;
  templateId?: string | null;
  targetRef?: string | null;
  body: string;
  state: ContentRow['state'];
  violations?: string[];
  meta?: unknown;
  scheduledAt?: string | null;
}): ContentRow {
  const id = run(
    `INSERT INTO content
       (account_id, platform, kind, template_id, target_ref, body, state, violations, meta, scheduled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.accountId,
    row.platform,
    row.kind,
    row.templateId ?? null,
    row.targetRef ?? null,
    row.body,
    row.state,
    JSON.stringify(row.violations ?? []),
    JSON.stringify(row.meta ?? {}),
    row.scheduledAt ?? null,
  );
  return getContent(id)!;
}

export const getContent = (id: number) =>
  one<ContentRow>('SELECT * FROM content WHERE id = ?', id);

export function setContentState(
  id: number,
  state: ContentRow['state'],
  extra: { permalink?: string | null; violations?: string[]; error?: string } = {},
): void {
  run(
    `UPDATE content SET
       state        = ?,
       permalink    = COALESCE(?, permalink),
       violations   = COALESCE(?, violations),
       attempts     = attempts + 1,
       published_at = CASE WHEN ? = 'published' THEN datetime('now') ELSE published_at END,
       meta         = CASE WHEN ? IS NULL THEN meta
                           ELSE json_set(COALESCE(NULLIF(meta,''),'{}'), '$.lastError', ?) END
     WHERE id = ?`,
    state,
    extra.permalink ?? null,
    extra.violations ? JSON.stringify(extra.violations) : null,
    state,
    extra.error ?? null,
    extra.error ?? null,
    id,
  );
}

/** Set or clear the publish time on a content row. */
export function scheduleContent(id: number, scheduledAt: string | null): void {
  run('UPDATE content SET scheduled_at = ? WHERE id = ?', scheduledAt, id);
}

/** Everything queued and due, oldest first. */
export const dueContent = (accountId: number) =>
  all<ContentRow>(
    `SELECT * FROM content
      WHERE account_id = ? AND state = 'queued'
        AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))
      ORDER BY COALESCE(scheduled_at, created_at) ASC`,
    accountId,
  );

export const recentPublishedBodies = (accountId: number, limit = 12) =>
  all<{ body: string }>(
    `SELECT body FROM content
      WHERE account_id = ? AND state = 'published'
      ORDER BY id DESC LIMIT ?`,
    accountId,
    limit,
  ).map((r) => r.body);

export const listContent = (limit = 60) =>
  all<ContentRow & { account_name: string }>(
    `SELECT c.*, a.name AS account_name
       FROM content c JOIN accounts a ON a.id = c.account_id
      ORDER BY c.id DESC LIMIT ?`,
    limit,
  );

/* ---------------------------------------------------------- template usage */

export function recordTemplateUse(accountId: number, templateId: string): void {
  run('INSERT INTO template_usage (account_id, template_id) VALUES (?, ?)', accountId, templateId);
}

/** templateId -> last-used epoch ms, for the rotation picker. */
export function templateUsage(accountId: number): Map<string, number> {
  const rows = all<{ template_id: string; used_at: string }>(
    `SELECT template_id, MAX(used_at) AS used_at
       FROM template_usage WHERE account_id = ? GROUP BY template_id`,
    accountId,
  );
  return new Map(rows.map((r) => [r.template_id, Date.parse(`${r.used_at.replace(' ', 'T')}Z`) || 0]));
}

/* --------------------------------------------------------------------- jobs */

export interface JobRow {
  id: number;
  account_id: number;
  kind: string;
  payload: string;
  run_at: string;
  state: 'ready' | 'running' | 'done' | 'failed' | 'disabled';
  recurrence: string | null;
  attempts: number;
  last_error: string | null;
  last_run_at: string | null;
  created_at: string;
}

export function createJob(job: {
  accountId: number;
  kind: string;
  payload?: unknown;
  runAt?: string;
  recurrence?: string | null;
}): JobRow {
  const id = run(
    `INSERT INTO jobs (account_id, kind, payload, run_at, recurrence)
     VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?)`,
    job.accountId,
    job.kind,
    JSON.stringify(job.payload ?? {}),
    job.runAt ?? null,
    job.recurrence ?? null,
  );
  return one<JobRow>('SELECT * FROM jobs WHERE id = ?', id)!;
}

export const listJobs = () =>
  all<JobRow & { account_name: string; platform: string }>(
    `SELECT j.*, a.name AS account_name, a.platform
       FROM jobs j JOIN accounts a ON a.id = j.account_id
      ORDER BY j.run_at ASC`,
  );

/** The next due job for one account, or undefined. */
export const nextDueJob = (accountId: number) =>
  one<JobRow>(
    `SELECT * FROM jobs
      WHERE account_id = ? AND state = 'ready' AND run_at <= datetime('now')
      ORDER BY run_at ASC LIMIT 1`,
    accountId,
  );

/**
 * Close out a job. A recurring job re-arms itself at now + its interval; a one-shot
 * is marked done. A job that has failed three times is disabled rather than looping.
 */
export function finishJob(
  job: JobRow,
  outcome: 'done' | 'failed',
  error?: string,
): void {
  const attempts = job.attempts + 1;

  if (outcome === 'failed' && attempts >= 3 && !job.recurrence) {
    run(
      `UPDATE jobs SET state = 'disabled', attempts = ?, last_error = ?, last_run_at = datetime('now') WHERE id = ?`,
      attempts,
      error ?? null,
      job.id,
    );
    return;
  }

  if (job.recurrence) {
    const next = nextRunAt(job.recurrence);
    run(
      `UPDATE jobs SET state = 'ready', run_at = ?, attempts = ?, last_error = ?, last_run_at = datetime('now') WHERE id = ?`,
      next,
      outcome === 'failed' ? attempts : 0,
      error ?? null,
      job.id,
    );
    return;
  }

  run(
    `UPDATE jobs SET state = ?, attempts = ?, last_error = ?, last_run_at = datetime('now') WHERE id = ?`,
    outcome === 'failed' ? 'ready' : 'done',
    attempts,
    error ?? null,
    job.id,
  );
}

export function setJobState(id: number, state: JobRow['state']): void {
  run('UPDATE jobs SET state = ? WHERE id = ?', state, id);
}

export function deleteJob(id: number): void {
  run('DELETE FROM jobs WHERE id = ?', id);
}

/**
 * Recurrence is deliberately tiny: "<n><unit>" where unit is m/h/d, plus a random
 * jitter of up to 20% so a daily job does not fire at the same minute every day.
 */
export function nextRunAt(recurrence: string, now = new Date()): string {
  const m = /^(\d+)([mhd])$/.exec(recurrence.trim());
  if (!m) throw new Error(`bad recurrence "${recurrence}" — use e.g. "90m", "6h", "1d"`);
  const n = Number(m[1]);
  const unitMs = m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
  const base = n * unitMs;
  const jitter = Math.floor(Math.random() * base * 0.2);
  const at = new Date(now.getTime() + base + jitter);
  return at.toISOString().slice(0, 19).replace('T', ' ');
}

/* ---------------------------------------------------------------- feed seen */

export function markFeedSeen(row: {
  accountId: number;
  platform: PlatformId | string;
  postRef: string;
  author?: string | null;
  excerpt?: string | null;
  action?: string | null;
  reason?: string | null;
}): void {
  run(
    `INSERT OR IGNORE INTO feed_seen (account_id, platform, post_ref, author, excerpt, action, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    row.accountId,
    row.platform,
    row.postRef,
    row.author ?? null,
    row.excerpt?.slice(0, 400) ?? null,
    row.action ?? null,
    row.reason ?? null,
  );
}

export const hasSeenFeedItem = (accountId: number, postRef: string) =>
  Boolean(one('SELECT 1 FROM feed_seen WHERE account_id = ? AND post_ref = ?', accountId, postRef));

export const recentFeedActions = (limit = 40) =>
  all<Record<string, unknown>>(
    `SELECT f.*, a.name AS account_name FROM feed_seen f
       JOIN accounts a ON a.id = f.account_id
      WHERE f.action IS NOT NULL
      ORDER BY f.id DESC LIMIT ?`,
    limit,
  );
