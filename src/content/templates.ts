import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { PlatformId } from '../platforms/index.ts';

/**
 * The approved template bank. This is the hard boundary on autonomy: the agents
 * can decide WHAT to say inside a shape, but they cannot invent a new shape. If a
 * generated post does not resolve to a template id in this bank, the gate rejects
 * it and nothing is published.
 *
 * Editing `templates/<platform>/bank.json` is how you change what your accounts
 * are allowed to say. No code change, no redeploy.
 */

const TemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  when: z.string().min(1),
  skeleton: z.string().min(1),
  slots: z.record(z.string()),
  constraints: z
    .object({
      maxChars: z.number().optional(),
      minChars: z.number().optional(),
      maxLines: z.number().optional(),
      requiresNumber: z.boolean().optional(),
      requiresTitle: z.boolean().optional(),
      isThread: z.boolean().optional(),
      perTweet: z.boolean().optional(),
    })
    .default({}),
});

const BankSchema = z.object({
  platform: z.string(),
  kind: z.string().default('post'),
  note: z.string().optional(),
  templates: z.array(TemplateSchema).min(1),
});

export type Template = z.infer<typeof TemplateSchema> & { platform: PlatformId; kind: string };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEMPLATE_DIR = join(root, 'templates');

let cache: Map<string, Template> | null = null;

export function loadTemplates(force = false): Map<string, Template> {
  if (cache && !force) return cache;
  const map = new Map<string, Template>();

  if (!existsSync(TEMPLATE_DIR)) {
    throw new Error(`no templates/ directory at ${TEMPLATE_DIR}`);
  }

  for (const platformDir of readdirSync(TEMPLATE_DIR, { withFileTypes: true })) {
    if (!platformDir.isDirectory()) continue;
    const dir = join(TEMPLATE_DIR, platformDir.name);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const bank = BankSchema.parse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
      for (const t of bank.templates) {
        if (map.has(t.id)) {
          throw new Error(`duplicate template id "${t.id}" in ${join(dir, file)}`);
        }
        map.set(t.id, { ...t, platform: bank.platform as PlatformId, kind: bank.kind });
      }
    }
  }

  cache = map;
  return map;
}

export function getTemplate(id: string): Template {
  const t = loadTemplates().get(id);
  if (!t) {
    throw new Error(
      `"${id}" is not an approved template. Approved: ${[...loadTemplates().keys()].join(', ')}`,
    );
  }
  return t;
}

export function templatesFor(platform: PlatformId, kind = 'post'): Template[] {
  return [...loadTemplates().values()].filter((t) => t.platform === platform && t.kind === kind);
}

export function isApprovedTemplate(id: string | null | undefined): boolean {
  return Boolean(id && loadTemplates().has(id));
}

/**
 * Fair rotation. Least-recently-used first, so every approved shape gets used and
 * the account never posts the same structure twice running while an unused one
 * exists. `usage` is a map of templateId -> last-used epoch ms (absent = never).
 */
export function pickTemplate(
  platform: PlatformId,
  usage: Map<string, number>,
  kind = 'post',
  exclude: string[] = [],
): Template {
  const pool = templatesFor(platform, kind).filter((t) => !exclude.includes(t.id));
  if (pool.length === 0) {
    throw new Error(`no templates available for ${platform}/${kind} after exclusions`);
  }
  const never = pool.filter((t) => !usage.has(t.id));
  if (never.length > 0) return never[0]!;

  return pool.reduce((oldest, t) =>
    (usage.get(t.id) ?? 0) < (usage.get(oldest.id) ?? 0) ? t : oldest,
  );
}

/** The template rendered for a prompt: shape plus the rules for each slot. */
export function templateBrief(t: Template): string {
  const slots = Object.entries(t.slots)
    .filter(([, desc]) => desc !== 'unused')
    .map(([slot, desc]) => `  {{${slot}}} — ${desc}`)
    .join('\n');

  const constraints = Object.entries(t.constraints)
    .map(([k, v]) => `  ${k}: ${String(v)}`)
    .join('\n');

  return [
    `TEMPLATE: ${t.id} — ${t.name}`,
    `USE WHEN: ${t.when}`,
    '',
    'SHAPE (each line is one beat; produce the filled prose, not the placeholders):',
    t.skeleton,
    '',
    'WHAT GOES IN EACH SLOT:',
    slots,
    constraints ? `\nHARD CONSTRAINTS:\n${constraints}` : '',
  ].join('\n');
}
