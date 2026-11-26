/**
 * LLM coding agent. Model-agnostic: it is given a GenerateFn (see src/llm),
 * so tests use a deterministic scripted mock and production uses the AI SDK.
 *
 *   propose(task, context)                         -> Proposal
 *   reformulate(task, previous, report, mode)      -> Proposal
 *     mode "report": failing checks + evidence + previous diff
 *     mode "blind":  only "rejected" + previous diff (the ablation)
 *   decompose(task, context)                       -> { actions } | { error }
 *
 * Proposal = { rationale, diff, usage: {inputTokens, outputTokens}, promptVersion }
 *          | { error, usage, promptVersion }
 * Output is validated with zod (and a structural diff check); an invalid answer
 * gets one repair round-trip, then { error }. Never throws.
 */
import { z } from 'zod';
import {
  decomposePrompt, PROMPT_VERSION, proposePrompt, reformulateBlindPrompt,
  reformulateReportPrompt, repairPrompt, SYSTEM_PROMPT,
} from './prompts.js';

export { PROMPT_VERSION } from './prompts.js';

export const ProposalSchema = z.object({ rationale: z.string().min(1), diff: z.string().min(1) });
export const DecompositionSchema = z.object({ actions: z.array(z.string().min(1)).min(1) });

function parseJsonLoose(text) {
  if (!text) return undefined;
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(stripped);
  } catch {
    const i = stripped.indexOf('{');
    const j = stripped.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try { return JSON.parse(stripped.slice(i, j + 1)); } catch { /* fall through */ }
    }
    return undefined;
  }
}

/** Normalize and structurally check a diff; returns the cleaned diff or throws. */
export function cleanDiff(diff) {
  let d = diff.replace(/^```(?:diff|patch)?\s*\n/, '').replace(/\n```\s*$/, '\n');
  if (!d.endsWith('\n')) d += '\n';
  const hasHeader = /^(diff --git |--- )/m.test(d);
  const hasTarget = /^\+\+\+ /m.test(d) || /^rename to /m.test(d) || /^deleted file mode/m.test(d);
  if (!hasHeader || !hasTarget) throw new Error('diff is not a unified diff (missing ---/+++ headers)');
  if (/^\+\+\+ /m.test(d) && !/^@@ /m.test(d) && !/^(rename|new file|deleted file) /m.test(d)) throw new Error('diff has no hunks');
  return d;
}

const addUsage = (acc, u) => {
  acc.inputTokens += u?.inputTokens ?? 0;
  acc.outputTokens += u?.outputTokens ?? 0;
};

/** Condensed, structured summary of why a report was rejected ("report" mode). */
export function summarizeReport(report) {
  const out = { classification: report.classification };
  if (report.applyResult && !report.applyResult.applied) out.applyError = report.applyResult.error ?? 'diff did not apply';
  out.failingChecks = ['psi1', 'psi2', 'psi3', 'psi4']
    .filter((id) => report[id] && !report[id].passed)
    .map((id) => ({
      check: id,
      severity: report[id].severity,
      evidence: report[id].evidence
        .filter((e) => e.severity && e.severity !== 'none')
        .map((e) => ({ kind: e.kind, severity: e.severity, detail: e.detail, files: e.files })),
    }));
  return JSON.stringify(out, null, 2);
}

/**
 * @param {{generate: import('../llm/index.js').GenerateFn, config?: any}} opts
 */
export function createAgent({ generate, config = {} }) {
  async function ask(prompt, schema, validate) {
    const usage = { inputTokens: 0, outputTokens: 0 };
    let error = '';
    let raw = '';
    for (let round = 0; round < 2; round++) {
      let out;
      try {
        out = await generate({ system: SYSTEM_PROMPT, prompt: round === 0 ? prompt : repairPrompt({ prompt, error, raw }), schema });
      } catch (err) {
        return { error: `llm call failed: ${err?.message ?? err}`, usage, promptVersion: PROMPT_VERSION };
      }
      addUsage(usage, out?.usage);
      raw = out?.text ?? JSON.stringify(out?.object ?? null);
      try {
        const value = validate(schema.parse(out?.object ?? parseJsonLoose(out?.text)));
        return { ...value, usage, promptVersion: PROMPT_VERSION };
      } catch (err) {
        error = err instanceof z.ZodError ? `invalid structure: ${err.issues.map((i) => `${i.path.join('.') || 'root'} ${i.message}`).join('; ')}` : err.message;
      }
    }
    return { error: `invalid model output after one repair attempt: ${error}`, usage, promptVersion: PROMPT_VERSION };
  }

  const proposal = (p) => ({ rationale: p.rationale, diff: cleanDiff(p.diff) });

  return {
    /** @param {string} task @param {string} context */
    propose(task, context) {
      return ask(proposePrompt({ task, context }), ProposalSchema, proposal);
    },

    /**
     * @param {string} task @param {{diff?: string}} previous @param {any} report
     * @param {'report'|'blind'} [mode] @param {string} [context]
     */
    reformulate(task, previous, report, mode = config.agent?.reformulateMode ?? 'report', context = '') {
      const previousDiff = previous?.diff ?? '(no valid diff was produced)';
      const prompt = mode === 'blind'
        ? reformulateBlindPrompt({ task, context, previousDiff })
        : reformulateReportPrompt({ task, context, previousDiff, summary: summarizeReport(report) });
      return ask(prompt, ProposalSchema, proposal);
    },

    /** @param {string} task @param {string} context */
    decompose(task, context = '') {
      return ask(decomposePrompt({ task, context }), DecompositionSchema, (d) => ({ actions: d.actions }));
    },
  };
}
