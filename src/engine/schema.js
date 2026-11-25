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

export const ApplyResultSchema = z.object({
  applied: z.boolean(),
  filesChanged: z.array(z.string()),
  addedLines: z.number().int().nonnegative(),
  removedLines: z.number().int().nonnegative(),
  touchesManifest: z.boolean(),
  /** True when the diff was refused as unsafe (path escape, .git); implies Abort. */
  rejected: z.boolean().optional(),
  error: z.string().optional(),
});

export const InstallResultSchema = z.object({
  strategy: z.enum(['symlink', 'npm-ci', 'npm-install', 'none']),
  ok: z.boolean(),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
});

export const TimingsSchema = z.object({
  cloneMs: z.number().nonnegative(),
  installMs: z.number().nonnegative(),
  applyMs: z.number().nonnegative(),
  /** Per-check wall time in ms, keyed by check id. */
  checks: z.record(z.string(), z.number().nonnegative()),
});

const CheckResultOptional = CheckResultSchema.optional();

export const ConsequenceReportSchema = z
  .object({
    psi1: CheckResultOptional,
    psi2: CheckResultOptional,
    psi3: CheckResultOptional,
    psi4: CheckResultOptional,
    applyResult: ApplyResultSchema,
    install: InstallResultSchema.optional(),
    cloneKind: z.enum(['worktree', 'copy']),
    classification: z.enum(CLASSIFICATIONS),
    timings: TimingsSchema,
    latencyMs: z.number().nonnegative(),
  })
  .superRefine((r, ctx) => {
    // Checks only run on a diff that applied; otherwise they are absent.
    if (!r.applyResult.applied) return;
    for (const id of CHECK_IDS) {
      if (!r[id]) ctx.addIssue({ code: 'custom', path: [id], message: `${id} is required when the diff applied` });
    }
  });

/** @typedef {z.infer<typeof CheckResultSchema>} CheckResult */
/** @typedef {z.infer<typeof ConsequenceReportSchema>} ConsequenceReport */
/** @typedef {z.infer<typeof ApplyResultSchema>} ApplyResult */
/** @typedef {z.infer<typeof InstallResultSchema>} InstallResult */
/** @typedef {CheckResult['id']} CheckId */

/** @param {unknown} report @returns {ConsequenceReport} */
export function validateReport(report) {
  return ConsequenceReportSchema.parse(report);
}
