/**
 * Scrubbed environment for subprocesses that run target code (install, tests).
 * Only PATH, a private HOME, NODE_ENV=test, CI=true and an explicit allowlist
 * (config env.allow) are passed. API keys and tokens in the parent environment
 * are never inherited.
 */

/**
 * @param {{home: string, allow?: string[], source?: NodeJS.ProcessEnv}} opts
 * @returns {Record<string, string>}
 */
export function scrubbedEnv({ home, allow = [], source = process.env }) {
  /** @type {Record<string, string>} */
  const env = { PATH: source.PATH ?? '', HOME: home, NODE_ENV: 'test', CI: 'true' };
  for (const key of allow) {
    if (!(key in env) && source[key] !== undefined) env[key] = /** @type {string} */ (source[key]);
  }
  return env;
}
