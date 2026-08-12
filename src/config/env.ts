import { config } from 'dotenv';
import { resolve } from 'node:path';

config();

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

export const env = {
  dbPath: resolve(str('DB_PATH', './data/pilot.db')),
  profilesDir: resolve(str('PROFILES_DIR', './data/profiles')),
  port: Number(str('PORT', '4310')),
  apiToken: str('API_TOKEN', ''),
  anthropicApiKey: str('ANTHROPIC_API_KEY', ''),
  // Paid models are opt-in, the same rule Crew HQ runs on. A key sitting in
  // .env is not consent to spend it: the key was being preferred over the free
  // provider simply because it existed.
  aiPaid: str('AI_PAID', '') === 'true',
  aiModel: str('AI_MODEL', 'claude-opus-5'),
  // Free lane. Crew HQ runs its entire company on this tier already.
  groqApiKey: str('GROQ_API_KEY', ''),
  groqModel: str('GROQ_MODEL', 'llama-3.3-70b-versatile'),
  headless: bool('HEADLESS', false),
  paused: bool('PAUSED', false),
};

export type Env = typeof env;
