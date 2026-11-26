/**
 * ActionRecord: the JSON-serializable trace of one action through the loop,
 * one JSONL line per action in the run log. Single source of truth for its shape.
 */
import { z } from 'zod';
import { CLASSIFICATIONS, ConsequenceReportSchema } from '../engine/schema.js';

const Usage = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() });

export const AttemptSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: z.enum(['propose', 'reformulate']),
  proposal: z.object({
    diffHash: z.string().nullable(),
    diffBytes: z.number().int().nonnegative(),
    rationale: z.string().nullable(),
    usage: Usage,
    error: z.string().optional(),
  }),
  report: ConsequenceReportSchema.nullable(),
  verdict: z.enum(CLASSIFICATIONS).nullable(),
  timings: z.object({ proposeMs: z.number().nonnegative(), simulateMs: z.number().nonnegative() }),
});

export const ERROR_TYPES = ['TP', 'TN', 'FP', 'FN', 'inconclusive'];

export const DeltaSchema = z.record(z.string(), z.object({
  predictedPass: z.boolean().nullable(),
  observedPass: z.boolean().nullable(),
  agree: z.boolean(),
  errorType: z.enum(ERROR_TYPES),
}));

export const ActionRecordSchema = z.object({
  actionId: z.string(),
  taskId: z.string(),
  actionIndex: z.number().int().nonnegative(),
  action: z.string(),
  mode: z.enum(['twinagent', 'direct', 'reactive', 'static']),
  attempts: z.array(AttemptSchema),
  finalStatus: z.enum(['Success', 'Escalated']),
  reason: z.string().nullable(),
  error: z.string().nullable(),
  committed: z.boolean(),
  commitId: z.string().nullable(),
  observed: z.object({ classification: z.enum(CLASSIFICATIONS), baselineId: z.string(), headId: z.string() }).loose().nullable(),
  deltaCR: DeltaSchema.nullable(),
  twinUpdates: z.object({
    promoted: z.boolean(),
    coverageAdded: z.array(z.object({ test: z.string(), module: z.string() })),
    telemetry: z.object({ matched: z.number(), unmatched: z.number() }),
  }).nullable(),
  calibration: z.object({ psi4: z.object({ predicted: z.unknown(), observed: z.unknown() }) }).nullable(),
  /** A change from this action was applied to the real system at some point. */
  executedOnReal: z.boolean(),
  /** An observed violation followed some execution (even if later rolled back). */
  harmfulExecuted: z.boolean(),
  /** An observed violation remains in the final state. */
  harmfulFinal: z.boolean(),
  rollbacks: z.number().int().nonnegative(),
  /** psi ids the last pre-execution prediction said were violated (null: no prediction). */
  predictedViolations: z.array(z.string()).nullable(),
  reformulateMode: z.enum(['report', 'blind']),
  // ---- evaluation harness annotations (absent outside eval runs) ----
  injection: z.object({ id: z.string(), category: z.string(), seed: z.number(), description: z.string(), psi4Pending: z.boolean() }).nullable().optional(),
  labelByConstruction: z.array(z.string()).nullable().optional(),
  labelObserved: z.array(z.string()).nullable().optional(),
  labelAgreement: z.boolean().nullable().optional(),
  evalTaskId: z.string().optional(),
  totalLatencyMs: z.number().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  promptVersion: z.string(),
  twinMode: z.enum(['twin', 'plain']),
  configHash: z.string(),
  timestamp: z.string(),
});

/** @typedef {z.infer<typeof ActionRecordSchema>} ActionRecord */
