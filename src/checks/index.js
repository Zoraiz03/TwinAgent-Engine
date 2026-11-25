/**
 * Check registry: maps check ids to their `run(ctx)` implementations.
 * Each check exports `async run(ctx) -> { id, passed, severity, evidence }`.
 */
import * as psi1 from './psi1.js';
import * as psi2 from './psi2.js';
import * as psi3 from './psi3.js';
import * as psi4 from './psi4.js';

/**
 * @typedef {object} CheckContext
 * @property {import('../adapters/index.js').Workspace} workspace  Isolated copy, diff already applied.
 * @property {import('../adapters/index.js').Adapter} adapter
 * @property {string} diff
 * @property {object} config  Parsed config/default.json (or override).
 */

export const checks = { psi1, psi2, psi3, psi4 };
