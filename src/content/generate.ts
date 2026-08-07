import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiClient } from '../ai/client.ts';
import type { PlatformId } from '../platforms/index.ts';
import { getPlatform } from '../platforms/index.ts';
import { pickTemplate, templateBrief, getTemplate, type Template } from './templates.ts';
import { gate, gateRulesForPrompt, type GateResult } from './gate.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const INSTRUCTIONS_DIR = join(root, 'instructions');

/** GLOBAL.md plus the platform file. Read fresh each time — editing them is live. */
export function loadInstructions(platform: PlatformId): string {
  const parts: string[] = [];
  for (const file of ['GLOBAL.md', `${platform}.md`]) {
    const path = join(INSTRUCTIONS_DIR, file);
    if (existsSync(path)) parts.push(readFileSync(path, 'utf8').trim());
  }
  if (parts.length === 0) {
    throw new Error(`no instruction files found in ${INSTRUCTIONS_DIR}`);
  }
  return parts.join('\n\n---\n\n');
}

export interface GenerateRequest {
  ai: AiClient;
  platform: PlatformId;
  kind: 'post' | 'dm' | 'comment' | 'reply';
  /** What this specific piece is about — the raw material, in your own words. */
  brief: string;
  /** Facts the model may use. It must not invent anything outside this. */
  facts?: string;
  /** Template rotation state: templateId -> last-used epoch ms. */
  usage?: Map<string, number>;
  /** Force a specific template instead of rotating. */
  templateId?: string;
  /** Recent published bodies on this account, for the repetition check. */
  recentBodies?: string[];
  /** How many repair rounds before giving up. */
  maxAttempts?: number;
  onLog?: (line: string) => void;
}

export interface GenerateResult {
  ok: boolean;
  body: string;
  templateId: string | null;
  attempts: number;
  violations: string[];
}

/**
 * Generate → gate → repair → gate, up to `maxAttempts`. If it never passes, the
 * result is `ok: false` and NOTHING is published. Failing closed is the whole
 * point: a missed post costs nothing, a bad post is public.
 */
export async function generate(req: GenerateRequest): Promise<GenerateResult> {
  const log = req.onLog ?? (() => {});
  const maxAttempts = req.maxAttempts ?? 3;
  const platform = getPlatform(req.platform);

  let template: Template | null = null;
  if (req.kind === 'post') {
    template = req.templateId
      ? getTemplate(req.templateId)
      : pickTemplate(req.platform, req.usage ?? new Map());
    log(`template: ${template.id} (${template.name})`);
  }

  const system = [
    loadInstructions(req.platform),
    '',
    '---',
    '',
    `You are writing one ${req.kind} for ${platform.displayName}.`,
    '',
    template ? templateBrief(template) : '',
    '',
    gateRulesForPrompt(req.platform, req.kind),
  ]
    .filter(Boolean)
    .join('\n');

  let violations: string[] = [];
  let body = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt =
      attempt === 1
        ? buildPrompt(req)
        : buildRepairPrompt(req, body, violations);

    body = (await req.ai.text({ system, prompt, maxTokens: 2_000 }))
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim();

    const result: GateResult = gate({
      platform: req.platform,
      kind: req.kind,
      body,
      templateId: template?.id ?? null,
      recentBodies: req.recentBodies,
    });

    if (result.pass) {
      log(`passed the gate on attempt ${attempt}`);
      return {
        ok: true,
        body: result.body,
        templateId: template?.id ?? null,
        attempts: attempt,
        violations: [],
      };
    }

    violations = result.violations;
    log(`attempt ${attempt} rejected: ${violations.join(' | ')}`);
  }

  return {
    ok: false,
    body,
    templateId: template?.id ?? null,
    attempts: maxAttempts,
    violations,
  };
}

function buildPrompt(req: GenerateRequest): string {
  return [
    'What this piece is about:',
    req.brief,
    '',
    req.facts
      ? [
          'The ONLY facts you may use. Do not add a number, a name, a date, or an event that is not here:',
          req.facts,
        ].join('\n')
      : 'You have been given no verified facts. Do not state any specific number, name, date or event — if the template requires one, say so instead of inventing it.',
    '',
    'Write the finished copy now. Output nothing else.',
  ].join('\n');
}

function buildRepairPrompt(req: GenerateRequest, previous: string, violations: string[]): string {
  return [
    'Your previous draft was rejected by an automated check. It was not published.',
    '',
    'Previous draft:',
    previous,
    '',
    'Every reason it was rejected:',
    ...violations.map((v) => `- ${v}`),
    '',
    'Rewrite it so every one of those is fixed. Keep whatever was working.',
    'Do not argue with the checks — they are enforced in code and cannot be overridden.',
    '',
    'Original brief, unchanged:',
    req.brief,
    '',
    'Output only the corrected copy.',
  ].join('\n');
}
