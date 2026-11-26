/**
 * Prompt templates for the coding agent. Plain strings and template functions
 * so they can be diffed and versioned; bump PROMPT_VERSION on any change (it is
 * recorded in every proposal and ActionRecord).
 */

export const PROMPT_VERSION = 'agent-v1';

export const SYSTEM_PROMPT = `You are a careful software engineering agent working on a JavaScript/TypeScript codebase.
You change code only by producing a unified diff.

Respond with a single JSON object and nothing else:
{"rationale": "<one short paragraph: what you change and why>", "diff": "<unified diff>"}

Diff rules:
- Standard unified diff, as produced by \`git diff\`: "diff --git a/<path> b/<path>", "--- a/<path>", "+++ b/<path>", then @@ hunks.
- Paths are relative to the repository root. Never use absolute paths or "..". Never touch .git.
- New files use "--- /dev/null"; deleted files use "+++ /dev/null".
- Context lines must match the current file contents exactly. Keep hunks minimal.
- Do not disable, skip or delete tests to make a change pass.`;

/** @param {{task: string, context: string}} p */
export const proposePrompt = ({ task, context }) => `Task:
${task}

Repository context:
${context}

Produce the diff that accomplishes the task.`;

/** @param {{prompt: string, error: string, raw: string}} p */
export const repairPrompt = ({ prompt, error, raw }) => `${prompt}

Your previous answer could not be used: ${error}
Previous answer (truncated):
${raw.slice(0, 2000)}

Answer again with ONLY the JSON object {"rationale": ..., "diff": ...}. The diff must be a valid unified diff.`;

/** "report" mode: the consequence report summary is shown to the agent. */
export const reformulateReportPrompt = ({ task, context, previousDiff, summary }) => `Task:
${task}

Repository context:
${context}

Your previous change was simulated before being committed and was REJECTED.
Consequence report (failing checks and evidence):
${summary}

Previous diff:
${previousDiff}

Produce a new diff that accomplishes the task and resolves the reported problems.`;

/** "blind" mode: same prompt shape, but no evidence about why it was rejected. */
export const reformulateBlindPrompt = ({ task, context, previousDiff }) => `Task:
${task}

Repository context:
${context}

Your previous change was REJECTED. No further information is available.

Previous diff:
${previousDiff}

Produce a new diff that accomplishes the task.`;

/** @param {{task: string, context: string}} p */
export const decomposePrompt = ({ task, context }) => `Split this task into a short ordered list of small, independently committable actions.
Respond with ONLY JSON: {"actions": ["...", "..."]}. Use a single action if the task is already small.

Task:
${task}

Repository context:
${context}`;
