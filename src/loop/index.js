/**
 * Agentic decision loop: Safe -> commit, Revise -> reformulate and retry up to
 * K times, Abort (or retries exhausted) -> escalate to a human.
 * Dependencies are injected so the loop is testable without an LLM.
 */

/**
 * @param {object} p
 * @param {string} p.diff  Initial proposed diff.
 * @param {number} p.K  Max Revise retries.
 * @param {(diff: string) => Promise<import('../engine/schema.js').ConsequenceReport>} p.simulate
 * @param {(diff: string, report: import('../engine/schema.js').ConsequenceReport) => Promise<string>} p.reformulate
 * @param {(diff: string) => Promise<void>} p.commit
 * @param {(diff: string, report: import('../engine/schema.js').ConsequenceReport) => Promise<void>} p.escalate
 * @returns {Promise<{outcome: 'committed'|'escalated', attempts: number, report: import('../engine/schema.js').ConsequenceReport}>}
 */
export async function runLoop({ diff, K, simulate, reformulate, commit, escalate }) {
  let current = diff;
  for (let attempt = 1; ; attempt++) {
    const report = await simulate(current);
    if (report.classification === 'Safe') {
      await commit(current);
      return { outcome: 'committed', attempts: attempt, report };
    }
    if (report.classification === 'Abort' || attempt > K) {
      await escalate(current, report);
      return { outcome: 'escalated', attempts: attempt, report };
    }
    current = await reformulate(current, report);
  }
}
