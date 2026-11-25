/**
 * Node/npm adapter. Detects npm projects (package.json, no yarn/pnpm lockfile),
 * finds the test command from package.json (noting jest/vitest/mocha), and
 * prepares a clone by symlinking the target's node_modules, or by running a
 * real `npm ci` / `npm install` inside the clone when the diff changes a
 * dependency manifest.
 */
import { existsSync, readFileSync } from 'node:fs';
import { realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../engine/exec.js';

const MANIFESTS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'];
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];
const FRAMEWORKS = ['jest', 'vitest', 'mocha'];
const NPM_DEFAULT_TEST = /no test specified/;
const NPM_FLAGS = ['--no-audit', '--no-fund', '--loglevel=error'];

/** @param {string} dir */
function readPkg(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** @type {import('./index.js').TargetAdapter} */
export const nodeNpmAdapter = {
  name: 'node-npm',

  detect(targetPath) {
    return (
      existsSync(join(targetPath, 'package.json')) &&
      !existsSync(join(targetPath, 'yarn.lock')) &&
      !existsSync(join(targetPath, 'pnpm-lock.yaml'))
    );
  },

  manifestFiles() {
    return [...MANIFESTS];
  },

  testCommand(cloneDir) {
    const pkg = readPkg(cloneDir);
    const script = pkg?.scripts?.test;
    if (!script || NPM_DEFAULT_TEST.test(script)) return null;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const framework = FRAMEWORKS.find((f) => f in deps) ?? null;
    return { cmd: 'npm', args: ['test'], cwd: cloneDir, framework };
  },

  async prepare(cloneDir, { targetPath, touchesManifest, installTimeoutMs }) {
    const start = performance.now();
    const result = (strategy, ok, error) => ({
      strategy,
      ok,
      durationMs: Math.round(performance.now() - start),
      ...(error ? { error } : {}),
    });

    if (touchesManifest) {
      const useCi = LOCKFILES.some((f) => existsSync(join(cloneDir, f)));
      const r = await run('npm', [useCi ? 'ci' : 'install', ...NPM_FLAGS], {
        cwd: cloneDir,
        timeoutMs: installTimeoutMs,
      });
      const strategy = useCi ? 'npm-ci' : 'npm-install';
      if (r.timedOut) return result(strategy, false, `install timed out after ${installTimeoutMs}ms`);
      if (r.code !== 0) return result(strategy, false, (r.stderr || r.stdout).trim().slice(-2000));
      return result(strategy, true);
    }

    const nm = join(targetPath, 'node_modules');
    if (existsSync(nm)) {
      await symlink(await realpath(nm), join(cloneDir, 'node_modules'), 'dir');
      return result('symlink', true);
    }
    return result('none', true);
  },
};
