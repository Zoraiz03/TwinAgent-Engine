/**
 * Check registry: maps check ids to their `run(ctx)` implementations.
 * Each check exports `async run(ctx) -> { id, passed, severity, evidence }`.
 */
import * as psi1 from './psi1-tests.js';
import * as psi2 from './psi2-security.js';
import * as psi3 from './psi3-dependencies.js';
import * as psi4 from './psi4.js';

/**
 * @typedef {object} CheckContext
 * @property {string} cloneDir  Isolated clone with the diff applied; the only dir checks may touch.
 * @property {import('../adapters/index.js').TargetAdapter} adapter
 * @property {import('./../engine/schema.js').ApplyResult} applyResult
 * @property {import('./../engine/schema.js').InstallResult} install
 * @property {string} targetPath  Original target (read-only; baselines clone it).
 * @property {string|null} stateKey  Cache key of the target state.
 * @property {string} [tmpRoot]  Where baseline clones are created.
 * @property {Record<string, string>} env  Scrubbed env for subprocesses.
 * @property {string} diff
 * @property {import('../twin/twin.js').Twin|null} [twin]  T: twin of the unmodified target (twin mode; read-only).
 * @property {import('../twin/twin.js').Twin|null} [twinPrime]  T': clone of T synced with the diff.
 * @property {object} config  Parsed config/default.json (or override).
 */

export const checks = { psi1, psi2, psi3, psi4 };
