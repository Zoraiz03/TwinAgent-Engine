/**
 * Run manifest: everything needed to reproduce a run's numbers from its log.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMPT_VERSION } from '../agent/prompts.js';
import { semgrepVersion } from '../checks/semgrep.js';
import { targetStateKey } from '../engine/clone.js';
import { run } from '../engine/exec.js';
import { configHash } from '../loop/index.js';

const ENGINE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const MANIFEST_FIELDS = [
  'evalType', 'mode', 'engineCommit', 'engineDirty', 'config', 'configHash', 'seed', 'n', 'categories',
  'targetPath', 'targetStateKey', 'semgrepVersion', 'nodeVersion', 'promptVersion', 'modelId',
  'startedAt', 'finishedAt', 'skippedCategories',
];

async function engineCommit() {
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: ENGINE_ROOT });
  const dirty = await run('git', ['status', '--porcelain'], { cwd: ENGINE_ROOT });
  return { engineCommit: head.code === 0 ? head.stdout.trim() : null, engineDirty: head.code === 0 ? dirty.stdout.trim() !== '' : null };
}

/**
 * @param {object} p
 * @returns {Promise<object>}
 */
export async function buildManifest({ evalType, mode, config, seed = null, n = null, categories = null, targetPath, modelId, startedAt, skippedCategories = [] }) {
  return {
    evalType,
    mode,
    ...(await engineCommit()),
    config,
    configHash: configHash(config),
    seed,
    n,
    categories,
    targetPath,
    targetStateKey: await targetStateKey(targetPath),
    semgrepVersion: await semgrepVersion(config.security?.semgrepPath ?? 'semgrep'),
    nodeVersion: process.version,
    promptVersion: PROMPT_VERSION,
    modelId,
    startedAt,
    finishedAt: new Date().toISOString(),
    skippedCategories,
  };
}

export const writeManifest = (dir, m) => writeFile(join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
export const readManifest = async (dir) => JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
