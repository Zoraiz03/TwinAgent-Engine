/**
 * Vulnerability providers for psi2. Interface:
 *   name: string
 *   scan(cloneDir, { env, timeoutMs, config }) -> Promise<Advisory[]>
 *     Advisory = { advisoryId, package, version, severity, title }
 *     severity: "critical" | "high" | "moderate" | "low"
 *   Throws ProviderUnavailableError when it cannot run (missing binary, no
 *   network, no fixture); psi2 turns that into an inconclusive result.
 */
import { fixtureProvider } from './fixture.js';
import { npmAuditProvider } from './npm-audit.js';
import { osvScannerProvider } from './osv-scanner.js';

export { ProviderUnavailableError } from './errors.js';

/** @typedef {{advisoryId: string, package: string, version: string, severity: string, title: string}} Advisory */

const providers = Object.fromEntries([npmAuditProvider, osvScannerProvider, fixtureProvider].map((p) => [p.name, p]));

/** @param {string} name */
export const getProvider = (name) => providers[name] ?? null;
