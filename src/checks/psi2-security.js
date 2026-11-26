/**
 * psi2 (security): scans the changed workspace for vulnerabilities.
 * Contract: `run(ctx)` -> { id, passed, severity, evidence }. Must only touch
 * `ctx.cloneDir` (the temp clone), never the original target.
 * Stubbed: returns a deterministic passing result.
 */

/**
 * @param {import('./index.js').CheckContext} _ctx
 * @returns {Promise<import('../engine/schema.js').CheckResult>}
 */
export async function run(_ctx) {
  return {
    id: 'psi2',
    passed: true,
    severity: 'none',
    evidence: [{ kind: 'stub', detail: 'psi2 not implemented', files: [] }],
    inconclusive: false,
  };
}
