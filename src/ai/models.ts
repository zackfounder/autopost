/**
 * Choosing a Groq chat model, in one place.
 *
 * Groq retires model ids on its own schedule — `llama-3.3-70b-versatile` was the
 * documented default here and vanished from the catalogue entirely — so setup,
 * the wizard and `doctor` all have to answer "that one is gone, now what".
 *
 * They each answered it separately, with a heuristic of "not whisper, not a
 * guard model, take the first". That picked `canopylabs/orpheus-v1-english`, a
 * text-to-speech model, and offered it as the thing to write LinkedIn posts
 * with. Three copies of a rule is three chances to be wrong in a different way,
 * which is why this is now one function with one list.
 */

/**
 * The default when nothing is configured. Groq retires ids regularly, so this is
 * a starting guess that setup and doctor are expected to correct — not a promise
 * that it exists today.
 */
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

/**
 * Models that cannot write a post at all, whatever their name suggests:
 * speech synthesis, transcription, safety classifiers, embeddings, rerankers.
 */
const NOT_A_WRITER = /whisper|orpheus|playai|tts|stt|guard|embed|rerank|moderation/i;

/**
 * Preference order, best first. Deliberately family-shaped rather than an exact
 * list: a new size of a family we already trust should be picked up without a
 * code change, and an unknown family should not win by accident.
 */
const PREFERRED: RegExp[] = [
  /gpt-oss-120b/i,
  /gpt-oss/i,
  /qwen3/i,
  /llama.*70b/i,
  /llama-3\.[3-9]/i,
  /^llama/i,
  /compound(?!-mini)/i,
  /compound/i,
];

/** Every model on this key that could plausibly write prose. */
export function writableModels(ids: string[]): string[] {
  return ids.filter((id) => !NOT_A_WRITER.test(id));
}

/**
 * The model to use, given what the key actually has.
 *
 * Returns `wanted` untouched when it is still live — a configured model is a
 * decision, and this only overrides a decision that has stopped being possible.
 */
export function pickChatModel(ids: string[], wanted: string): { model: string; switched: boolean } {
  if (ids.includes(wanted)) return { model: wanted, switched: false };

  const usable = writableModels(ids);
  for (const pattern of PREFERRED) {
    const hit = usable.find((id) => pattern.test(id));
    if (hit) return { model: hit, switched: true };
  }
  // Nothing recognised. Anything that can write beats keeping an id that 404s.
  return usable[0] ? { model: usable[0], switched: true } : { model: wanted, switched: false };
}

/** Ask Groq what this key can use. Free, and it costs no tokens. */
export async function fetchModelIds(apiKey: string): Promise<
  { ok: true; ids: string[] } | { ok: false; error: string; status?: number }
> {
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  }).catch((e: Error) => e);

  if (res instanceof Error) return { ok: false, error: `could not reach Groq: ${res.message}` };
  if (res.status === 401) return { ok: false, error: 'Groq rejected that key (401)', status: 401 };
  if (!res.ok) return { ok: false, error: `Groq answered ${res.status}`, status: res.status };

  const body = await res.json() as { data?: { id: string }[] };
  return { ok: true, ids: (body.data ?? []).map((m) => m.id) };
}
