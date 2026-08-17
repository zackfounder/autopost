/**
 * The terminal workflow: write something, look at it, decide, publish it.
 *
 *   npm run draft -- <account> "what it should be about" [--facts "..."] [--template <id>]
 *   npm run queue                              everything waiting, with ids
 *   npm run queue -- show <id>                 the full body and why it was blocked
 *   npm run queue -- edit <id> "new body"      replace the text, re-gate it
 *   npm run queue -- discard <id>
 *   npm run publish -- <id>                    publish this one, now
 *   npm run publish -- <account> --text "..."  gate and publish something you wrote
 *
 * Why this exists: the scheduler is the point of this project, but nobody should
 * hand a scheduler their real account before they have seen what it writes. This
 * is the loop that earns that trust — generate, read it, fix it, publish one by
 * hand — and it is the same generate → gate → publish path the engine uses, not
 * a shortcut around it.
 *
 * Publishing opens a real browser and touches a real account. Everything else
 * here is local.
 */
import { initSchema, getAccountByName, listAccounts, logAction } from '../src/db/index.ts';
import {
  createContent, getContent, listContent, setContentState, recentPublishedBodies, templateUsage,
  recordTemplateUse,
} from '../src/db/content.ts';
import { generate } from '../src/content/generate.ts';
import { gate } from '../src/content/gate.ts';
import { buildAiClient } from '../src/ai/client.ts';
import { getPlatform, isPlatformId } from '../src/platforms/index.ts';
import { checkQuota } from '../src/engine/limits.ts';
import type { PlatformId } from '../src/platforms/types.ts';

const argv = process.argv.slice(2);
const mode = process.env.WRITE_MODE ?? 'draft';

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

initSchema();

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

/** The body, indented, so it reads as the post it is rather than as log output. */
function showBody(body: string): void {
  console.log();
  for (const line of body.split('\n')) console.log(`    ${line}`);
  console.log();
  const lines = body.split('\n').length;
  console.log(dim(`    ${body.length} characters, ${lines} line${lines === 1 ? '' : 's'}`));
}

function account(name: string | undefined) {
  if (!name) {
    console.error(`which account? ${listAccounts().map((a) => a.name).join(', ') || '(none connected)'}`);
    process.exit(1);
  }
  const acc = getAccountByName(name);
  if (!acc) {
    console.error(`no account "${name}". Have: ${listAccounts().map((a) => a.name).join(', ') || '(none)'}`);
    process.exit(1);
  }
  if (!isPlatformId(acc.platform)) {
    console.error(`account "${name}" is on ${acc.platform}, which this build no longer supports.`);
    process.exit(1);
  }
  return acc;
}

/* ────────────────────────────────────────────────────────────────── draft */

if (mode === 'draft') {
  const acc = account(positional[0]);
  const brief = positional.slice(1).join(' ').trim() || flag('brief') || '';
  if (!brief) {
    console.error('usage: npm run draft -- <account> "what this post should be about" [--facts "..."]');
    process.exit(1);
  }

  const platform = acc.platform as PlatformId;
  console.log(dim(`writing for ${acc.name} (${getPlatform(platform).displayName}) via ${buildAiClient().kind}…`));

  const result = await generate({
    ai: buildAiClient(),
    platform,
    kind: 'post',
    brief,
    facts: flag('facts'),
    templateId: flag('template'),
    usage: templateUsage(acc.id),
    recentBodies: recentPublishedBodies(acc.id),
    onLog: (l) => console.log(dim(`  ${l}`)),
  });

  const row = createContent({
    accountId: acc.id,
    platform,
    kind: 'post',
    templateId: result.templateId,
    body: result.body,
    state: result.ok ? 'drafted' : 'blocked',
    violations: result.violations,
    meta: { brief, attempts: result.attempts },
  });
  if (result.templateId) recordTemplateUse(acc.id, result.templateId);

  showBody(result.body);
  console.log(`  ${dim('template')}  ${result.templateId ?? '(none)'}`);

  if (!result.ok) {
    console.log(`  ${red('BLOCKED')} after ${result.attempts} attempt(s) — this cannot be published:`);
    for (const v of result.violations) console.log(`    - ${v}`);
    console.log(dim(`\n  Saved as #${row.id}. Fix it with: npm run queue -- edit ${row.id} "..."`));
    process.exit(1);
  }

  console.log(`  ${green('passed the gate')}  #${row.id}`);
  console.log(dim(`\n  publish it:  npm run publish -- ${row.id}`));
  console.log(dim(`  throw it away:  npm run queue -- discard ${row.id}`));
  process.exit(0);
}

/* ────────────────────────────────────────────────────────────────── queue */

if (mode === 'queue') {
  const [sub, idArg] = positional;

  if (!sub || sub === 'list') {
    const rows = listContent(100).filter((r) => ['drafted', 'queued', 'blocked'].includes(r.state));
    if (rows.length === 0) {
      console.log('\nNothing waiting.\n');
      console.log(dim('  write something: npm run draft -- <account> "..."\n'));
      process.exit(0);
    }
    console.log();
    for (const r of rows) {
      const mark = r.state === 'blocked' ? red('blocked') : r.state === 'queued' ? green('queued ') : 'drafted';
      const first = r.body.split('\n')[0]!.slice(0, 62);
      console.log(`  ${bold(`#${r.id}`)}  ${mark}  ${dim(`${r.account_name}/${r.platform}`)}  ${first}${r.body.length > 62 ? '…' : ''}`);
    }
    console.log(dim(`\n  npm run queue -- show <id>   |   npm run publish -- <id>\n`));
    process.exit(0);
  }

  const id = Number(idArg);
  const row = getContent(id);
  if (!row) { console.error(`no content #${idArg}`); process.exit(1); }

  if (sub === 'show') {
    console.log(`\n  ${bold(`#${row.id}`)}  ${row.state}  ${dim(`${row.platform} · ${row.template_id ?? 'no template'}`)}`);
    showBody(row.body);
    const violations = JSON.parse(row.violations || '[]') as string[];
    if (violations.length) {
      console.log(`  ${red('why it is blocked:')}`);
      for (const v of violations) console.log(`    - ${v}`);
      console.log();
    }
    process.exit(0);
  }

  if (sub === 'edit') {
    const body = positional.slice(2).join(' ').trim() || flag('text') || '';
    if (!body) { console.error('usage: npm run queue -- edit <id> "the new body"'); process.exit(1); }

    // Re-gate. An edit is exactly when a body stops being the thing that passed.
    const checked = gate({
      platform: row.platform as PlatformId,
      kind: row.kind as 'post' | 'dm' | 'comment' | 'reply',
      body,
      templateId: row.template_id,
      recentBodies: recentPublishedBodies(row.account_id),
    });
    setContentState(row.id, checked.pass ? 'drafted' : 'blocked', { violations: checked.violations });
    const { updateContentBody } = await import('../src/db/content.ts');
    updateContentBody(row.id, body);

    showBody(body);
    if (!checked.pass) {
      console.log(`  ${red('still blocked:')}`);
      for (const v of checked.violations) console.log(`    - ${v}`);
      process.exit(1);
    }
    console.log(`  ${green('passes now')}  #${row.id}`);
    process.exit(0);
  }

  if (sub === 'discard') {
    setContentState(row.id, 'skipped');
    console.log(`discarded #${row.id}`);
    process.exit(0);
  }

  console.error('usage: npm run queue [-- show|edit|discard <id>]');
  process.exit(1);
}

/* ──────────────────────────────────────────────────────────────── publish */

if (mode === 'publish') {
  const first = positional[0];
  const asId = Number(first);
  const looksLikeId = Number.isFinite(asId) && String(asId) === first;
  let row = looksLikeId ? getContent(asId) : null;

  // A number that is not a row is a typo, not an account name. Falling through
  // to the account lookup answered `publish -- 9999` with "no account 9999".
  if (looksLikeId && !row) {
    console.error(`no content #${first}. See what is waiting: npm run queue`);
    process.exit(1);
  }

  // `publish <account> --text "..."` writes the row first, so the same gate and
  // the same audit trail apply to something you typed yourself.
  if (!row) {
    const acc = account(first);
    const body = (flag('text') ?? positional.slice(1).join(' ')).trim();
    if (!body) {
      console.error('usage: npm run publish -- <id>   |   npm run publish -- <account> --text "..."');
      process.exit(1);
    }
    const checked = gate({ platform: acc.platform as PlatformId, kind: 'post', body });
    row = createContent({
      accountId: acc.id,
      platform: acc.platform,
      kind: 'post',
      body,
      state: checked.pass ? 'drafted' : 'blocked',
      violations: checked.violations,
    });
    if (!checked.pass) {
      showBody(body);
      console.log(`  ${red('BLOCKED — not published:')}`);
      for (const v of checked.violations) console.log(`    - ${v}`);
      process.exit(1);
    }
  }

  if (row.state === 'published') { console.error(`#${row.id} is already published`); process.exit(1); }

  const acc = listAccounts().find((a) => a.id === row!.account_id)!;
  const adapter = getPlatform(row.platform);

  // The same re-gate the engine runs immediately before the browser acts. A row
  // that passed yesterday is not a row that passes now — the repetition check
  // compares against what has been published since.
  const recheck = gate({
    platform: row.platform as PlatformId,
    kind: row.kind as 'post' | 'dm' | 'comment' | 'reply',
    body: row.body,
    templateId: row.template_id,
    recentBodies: recentPublishedBodies(row.account_id),
  });
  if (!recheck.pass) {
    setContentState(row.id, 'blocked', { violations: recheck.violations });
    console.log(`  ${red('the pre-publish re-check failed:')}`);
    for (const v of recheck.violations) console.log(`    - ${v}`);
    process.exit(1);
  }

  const quota = checkQuota(acc.id, 'post', row.platform);
  if (!quota.allowed) {
    console.error(`held: ${quota.reason} (${quota.used}/${quota.cap}). The cap is the point — try tomorrow.`);
    process.exit(1);
  }

  showBody(row.body);
  console.log(dim(`  publishing to ${adapter.displayName} as ${acc.name}…`));

  const { openSession, checkLogin } = await import('../src/browser/session.ts');
  const session = await openSession(acc, {});
  const state = await checkLogin(session);
  if (state !== 'ok') {
    console.error(`\n  the session is ${state}. Run: npm run login -- ${acc.name} --platform ${acc.platform}`);
    await session.close();
    process.exit(1);
  }

  const out = await adapter.post!(session.page, row.body, { postAs: acc.post_as });
  logAction({
    accountId: acc.id,
    action: 'post',
    status: out.ok ? 'ok' : 'fail',
    counted: out.ok,
    detail: { contentId: row.id, platform: row.platform, error: out.error ?? null, via: 'cli' },
  });
  setContentState(row.id, out.ok ? 'published' : 'failed', {
    permalink: out.permalink ?? null,
    error: out.error,
  });
  await session.close();

  if (!out.ok) {
    console.error(`\n  ${red('failed:')} ${out.error}\n`);
    process.exit(1);
  }
  console.log(`\n  ${green('published')} #${row.id}${out.permalink ? ` → ${out.permalink}` : ''}\n`);
  process.exit(0);
}

console.error(`unknown mode "${mode}"`);
process.exit(1);
