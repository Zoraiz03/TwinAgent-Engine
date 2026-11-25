/**
 * Helpers for building check results from evidence entries. A check fails when
 * any entry carries a severity other than "none"; the result severity is the
 * maximum over those entries.
 */
import { maxSeverity } from '../engine/schema.js';

/**
 * @param {'psi1'|'psi2'|'psi3'|'psi4'} id
 * @param {import('../engine/schema.js').Evidence[]} evidence
 * @param {{inconclusive?: boolean, durationMs?: number}} [extra]
 * @returns {import('../engine/schema.js').CheckResult}
 */
export function buildResult(id, evidence, { inconclusive = false, durationMs } = {}) {
  const failing = evidence.filter((e) => e.severity && e.severity !== 'none');
  return {
    id,
    passed: failing.length === 0,
    severity: maxSeverity(failing.map((e) => e.severity)),
    evidence,
    inconclusive,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}
