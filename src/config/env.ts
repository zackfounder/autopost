import { config } from 'dotenv';
import { resolve } from 'node:path';
import { DEFAULT_GROQ_MODEL } from '../ai/models.ts';

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
  // Loopback by default. The dashboard hands the API token to whoever loads it,
  // and the API can post to a real LinkedIn account, so binding this to every
  // interface puts both on the local network. Override only on purpose.
  bindHost: str('BIND_HOST', '127.0.0.1'),
  apiToken: str('API_TOKEN', ''),
  anthropicApiKey: str('ANTHROPIC_API_KEY', ''),
  // Paid models are opt-in. A key sitting in
  // .env is not consent to spend it: the key was being preferred over the free
  // provider simply because it existed.
  aiPaid: str('AI_PAID', '') === 'true',
  aiModel: str('AI_MODEL', 'claude-opus-5'),
  // Free lane, and the default: these posts are short and template-bound.
  groqApiKey: str('GROQ_API_KEY', ''),
  groqModel: str('GROQ_MODEL', DEFAULT_GROQ_MODEL),
  headless: bool('HEADLESS', false),
  paused: bool('PAUSED', false),
};

export type Env = typeof env;
