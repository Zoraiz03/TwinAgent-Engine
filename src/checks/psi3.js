/**
 * psi3 (dependencies): audits added/changed dependencies.
 * Contract: `run(ctx)` -> { id, passed, severity, evidence }. Must only touch
 * `ctx.workspace.path` (the temp copy), never the original target.
 * Stubbed: returns a deterministic passing result.
 */

/**
 * @param {import('./index.js').CheckContext} _ctx
 * @returns {Promise<import('../engine/schema.js').CheckResult>}
 */
export async function run(_ctx) {
  return { id: 'psi3', passed: true, severity: 'none', evidence: ['stub: psi3 (dependencies) not implemented'] };
}
