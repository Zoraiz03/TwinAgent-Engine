/**
 * psi2 (security): scans the changed workspace for vulnerabilities.
 * Contract: `run(ctx)` -> { id, passed, severity, evidence }. Must only touch
 * `ctx.workspace.path` (the temp copy), never the original target.
 * Stubbed: returns a deterministic passing result.
 */

/**
 * @param {import('./index.js').CheckContext} _ctx
 * @returns {Promise<import('../engine/schema.js').CheckResult>}
 */
export async function run(_ctx) {
  return { id: 'psi2', passed: true, severity: 'none', evidence: ['stub: psi2 (security) not implemented'] };
}
