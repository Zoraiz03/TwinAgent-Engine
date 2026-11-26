/**
 * Provider-agnostic LLM interface built on the Vercel AI SDK ("ai").
 *
 * The agent never talks to a provider directly; it receives a GenerateFn:
 *   ({ system, prompt, schema? }) => Promise<{ object?, text?, usage? }>
 * Tests inject a scripted function; production uses createGenerate(), which
 * resolves the provider from config (llm.provider / llm.model) on demand.
 * API keys are read here and only here, from each provider's standard env var.
 */
import { generateText, NoObjectGeneratedError, Output } from 'ai';

/** Standard API-key env var per provider package (@ai-sdk/<provider>). */
export const API_KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

/**
 * @typedef {{inputTokens: number, outputTokens: number}} Usage
 * @typedef {(req: {system: string, prompt: string, schema?: import('zod').ZodType}) => Promise<{object?: unknown, text?: string, usage?: Partial<Usage>}>} GenerateFn
 */

/**
 * Resolve a model from config. The provider package is imported on demand.
 * @param {{provider: string, model: string}} llmConfig
 * @returns {Promise<import('ai').LanguageModel>}
 */
export async function resolveModel({ provider, model }) {
  const mod = await import(`@ai-sdk/${provider}`).catch(() => {
    throw new Error(`Provider package "@ai-sdk/${provider}" is not installed`);
  });
  const create = mod[`create${provider[0].toUpperCase()}${provider.slice(1)}`];
  const apiKey = API_KEY_ENV[provider] ? process.env[API_KEY_ENV[provider]] : undefined;
  if (create) return create(apiKey ? { apiKey } : {})(model);
  return (mod[provider] ?? mod.default)(model);
}

const usageOf = (u) => ({ inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0 });

/**
 * GenerateFn backed by the AI SDK. With a schema it asks for structured output
 * (Output.object); if the model's output does not match, the raw text is
 * returned instead of throwing so the caller can run its repair step.
 * @param {{model?: import('ai').LanguageModel, llm?: {provider: string, model: string}}} opts
 * @returns {GenerateFn}
 */
export function createGenerate({ model, llm } = {}) {
  let resolved = model;
  return async ({ system, prompt, schema }) => {
    resolved ??= await resolveModel(/** @type {any} */ (llm));
    try {
      const r = await generateText({ model: resolved, system, prompt, ...(schema ? { output: Output.object({ schema }) } : {}) });
      return { object: schema ? r.output : undefined, text: r.text, usage: usageOf(r.usage) };
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) return { text: err.text ?? '', usage: usageOf(err.usage) };
      throw err;
    }
  };
}

/**
 * Plain text completion (no schema).
 * @param {string} prompt
 * @param {{model?: import('ai').LanguageModel, llm?: {provider: string, model: string}}} opts
 */
export async function complete(prompt, opts = {}) {
  const { text } = await createGenerate(opts)({ system: '', prompt });
  return text ?? '';
}
