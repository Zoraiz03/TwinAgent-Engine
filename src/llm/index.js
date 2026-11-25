/**
 * Provider-agnostic LLM interface built on the Vercel AI SDK ("ai"). The model
 * is chosen by config (`llm.provider` / `llm.model`); callers may also inject
 * any AI SDK model object. Provider packages (e.g. @ai-sdk/anthropic) are
 * loaded lazily so the engine has no hard dependency on any one vendor.
 */
import { generateText } from 'ai';

/**
 * Resolve a model from config.
 * @param {{provider: string, model: string}} llmConfig
 * @returns {Promise<import('ai').LanguageModel>}
 */
export async function resolveModel({ provider, model }) {
  const mod = await import(`@ai-sdk/${provider}`).catch(() => {
    throw new Error(`Provider package "@ai-sdk/${provider}" is not installed`);
  });
  const factory = mod[provider] ?? mod.default;
  return factory(model);
}

/**
 * Generate text with the configured (or injected) model.
 * @param {string} prompt
 * @param {{model?: import('ai').LanguageModel, llm?: {provider: string, model: string}}} opts
 * @returns {Promise<string>}
 */
export async function complete(prompt, { model, llm } = {}) {
  const m = model ?? (await resolveModel(/** @type {any} */ (llm)));
  const { text } = await generateText({ model: m, prompt });
  return text;
}
