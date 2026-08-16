import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.ts';

/**
 * The AI layer is a narrow interface with two implementations: a real Claude client
 * and a deterministic mock. Everything downstream (ai_message, ai_qualify, the
 * reply classifier) depends only on this interface, so the entire engine runs
 * end-to-end with no API key and no network.
 */
export interface AiClient {
  readonly kind: 'anthropic' | 'groq' | 'mock';
  /** Free-form text generation. */
  text(opts: { system?: string; prompt: string; maxTokens?: number }): Promise<string>;
  /** Schema-constrained JSON. `schema` is a JSON Schema object. */
  json<T = unknown>(opts: {
    system?: string;
    prompt: string;
    schema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<T>;
}

class AnthropicClient implements AiClient {
  readonly kind = 'anthropic' as const;
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  private async call(params: {
    system?: string;
    prompt: string;
    maxTokens: number;
    schema?: Record<string, unknown>;
  }) {
    const res = await this.client.beta.messages.create({
      model: env.aiModel,
      max_tokens: params.maxTokens,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        ...(params.schema
          ? { format: { type: 'json_schema' as const, schema: params.schema } }
          : {}),
      },
      // Claude Opus 5's safety classifiers can decline a request outright. Without
      // this, a decline just stops. "default" routes by refusal category, so we
      // never have to maintain a fallback model list.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      ...(params.system ? { system: params.system } : {}),
      messages: [{ role: 'user' as const, content: params.prompt }],
    } as never);

    const message = res as unknown as {
      stop_reason?: string;
      content: { type: string; text?: string }[];
    };
    if (message.stop_reason === 'refusal') {
      throw new Error('model declined this request');
    }
    return message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
  }

  async text(opts: { system?: string; prompt: string; maxTokens?: number }): Promise<string> {
    return this.call({ ...opts, maxTokens: opts.maxTokens ?? 2_000 });
  }

  async json<T>(opts: {
    system?: string;
    prompt: string;
    schema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<T> {
    const raw = await this.call({ ...opts, maxTokens: opts.maxTokens ?? 2_000 });
    return JSON.parse(raw) as T;
  }
}


/**
 * Groq, through its OpenAI-compatible endpoint.
 *
 * The default, and on purpose. These posts are two hundred words written against
 * a template that already dictates their shape, at a measured ~670ms and zero
 * cost — paying frontier prices for them buys nothing.
 *
 * Anthropic stays available: set ANTHROPIC_API_KEY *and* AI_PAID=true.
 */
class GroqClient implements AiClient {
  readonly kind = 'groq' as const;

  constructor(private apiKey: string, private model: string) {}

  private async call(params: {
    system?: string;
    prompt: string;
    maxTokens: number;
    schema?: Record<string, unknown>;
  }): Promise<string> {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: params.maxTokens,
        temperature: 0.7,
        ...(params.schema
          ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'out', schema: params.schema, strict: true },
            },
          }
          : {}),
        messages: [
          ...(params.system ? [{ role: 'system', content: params.system }] : []),
          { role: 'user', content: params.prompt },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = await res.json() as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('groq returned nothing');
    return text;
  }

  async text(opts: { system?: string; prompt: string; maxTokens?: number }): Promise<string> {
    return this.call({ ...opts, maxTokens: opts.maxTokens ?? 2_000 });
  }

  async json<T>(opts: {
    system?: string;
    prompt: string;
    schema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<T> {
    const raw = await this.call({ ...opts, maxTokens: opts.maxTokens ?? 2_000 });
    return JSON.parse(raw) as T;
  }
}

/**
 * Deterministic stand-in. Not random: the same input always produces the same
 * output, so smoke runs are reproducible.
 */
class MockClient implements AiClient {
  readonly kind = 'mock' as const;

  async text(opts: { prompt: string }): Promise<string> {
    const name = /first name[:\s]+([A-Za-z'-]+)/i.exec(opts.prompt)?.[1] ?? 'there';
    return `Hi ${name} — mock message (no ANTHROPIC_API_KEY set, so the AI layer is stubbed).`;
  }

  async json<T>(opts: { prompt: string; schema: Record<string, unknown> }): Promise<T> {
    const props = (opts.schema.properties ?? {}) as Record<string, { type?: string }>;
    const out: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(props)) {
      if (key === 'score') out[key] = 70;
      else if (def.type === 'number' || def.type === 'integer') out[key] = 1;
      else if (def.type === 'boolean') out[key] = true;
      else if (def.type === 'array') out[key] = [];
      else out[key] = 'mock';
    }
    return out as T;
  }
}

let cached: AiClient | null = null;

/**
 * The deterministic stand-in, on demand.
 *
 * The smoke suite's contract is "no credentials, no network, no browser". It
 * used to get the mock for free by virtue of no API key existing; once a key
 * is configured, buildAiClient() would hand it a real client and the suite
 * would start making live calls — which is how a rate limit turned up in the
 * middle of a test run. Asking for the mock explicitly keeps that contract
 * true whatever the environment holds.
 */
export function mockAiClient(): AiClient {
  return new MockClient();
}

export function buildAiClient(): AiClient {
  if (cached) return cached;
  // Free first. Anthropic is only used when AI_PAID=true is set deliberately —
  // having a key in .env is not a decision to spend it, and the old order meant
  // every generation quietly billed the founder's own Anthropic account.
  // Mock only when neither exists, and mock fails the gate by design so nothing
  // silently publishes stub text.
  cached = env.aiPaid && env.anthropicApiKey
    ? new AnthropicClient(env.anthropicApiKey)
    : env.groqApiKey
    ? new GroqClient(env.groqApiKey, env.groqModel)
    : new MockClient();
  return cached;
}
