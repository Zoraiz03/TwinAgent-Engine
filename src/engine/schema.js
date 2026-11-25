/**
 * Consequence report schema: the single source of truth for every check result
 * and for the aggregated report the engine emits. Validate with zod; derive
 * JSDoc types from these schemas rather than redefining shapes elsewhere.
 */
import { z } from 'zod';

export const CHECK_IDS = /** @type {const} */ (['psi1', 'psi2', 'psi3', 'psi4']);
export const SEVERITIES = /** @type {const} */ (['none', 'low', 'medium', 'high', 'critical']);
export const CLASSIFICATIONS = /** @type {const} */ (['Safe', 'Revise', 'Abort']);

export const CheckResultSchema = z.object({
  id: z.enum(CHECK_IDS),
  passed: z.boolean(),
  severity: z.enum(SEVERITIES),
  evidence: z.array(z.string()),
});

export const ConsequenceReportSchema = z.object({
  psi1: CheckResultSchema,
  psi2: CheckResultSchema,
  psi3: CheckResultSchema,
  psi4: CheckResultSchema,
  classification: z.enum(CLASSIFICATIONS),
  latencyMs: z.number().nonnegative(),
});

/** @typedef {z.infer<typeof CheckResultSchema>} CheckResult */
/** @typedef {z.infer<typeof ConsequenceReportSchema>} ConsequenceReport */
/** @typedef {CheckResult['id']} CheckId */

/** @param {unknown} report @returns {ConsequenceReport} */
export function validateReport(report) {
  return ConsequenceReportSchema.parse(report);
}
