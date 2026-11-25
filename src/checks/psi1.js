/**
 * psi1 (tests): runs the target's test suite in the workspace.
 * Contract: `run(ctx)` -> { id, passed, severity, evidence }. Must only touch
 * `ctx.cloneDir` (the temp clone), never the original target.
 * Stubbed: returns a deterministic passing result.
 */

/**
 * @param {import('./index.js').CheckContext} _ctx
 * @returns {Promise<import('../engine/schema.js').CheckResult>}
 */
export async function run(_ctx) {
  return { id: 'psi1', passed: true, severity: 'none', evidence: ['stub: psi1 (tests) not implemented'] };
}
