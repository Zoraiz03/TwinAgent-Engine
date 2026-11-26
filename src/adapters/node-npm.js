/**
 * Node/npm adapter. Detects npm projects (package.json, no yarn/pnpm lockfile),
 * finds the test command from package.json (noting jest/vitest/mocha), and
 * prepares a clone by symlinking the target's node_modules, or by running a
 * real `npm ci` / `npm install` inside the clone when the diff changes a
 * dependency manifest.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../engine/exec.js';
import { parseJestJson, parseJunit } from './test-output.js';

const MANIFESTS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'];
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];
const FRAMEWORKS = ['jest', 'vitest', 'mocha'];
const NPM_DEFAULT_TEST = /no test specified/;
const NODE_TEST_SCRIPT = /\bnode\b[^&|;]*\s--test(?=\s|$)/;
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
    const framework = FRAMEWORKS.find((f) => f in deps) ?? (NODE_TEST_SCRIPT.test(script) ? 'node:test' : null);
    return { cmd: 'npm', args: ['test'], cwd: cloneDir, framework };
  },

  /**
   * Run the target's tests in `dir` and return machine-readable results.
   * `testFiles` runs exactly those test files (twin-selected); `files` asks a
   * runner with a native related mode for tests related to those files.
   * jest / vitest run through `npm exec` with JSON output (related-file
   * selection when `files` is given); node:test scripts get the junit reporter
   * injected; anything else runs `npm test` and is reported at file level from
   * the exit code. Timeouts kill the whole process tree.
   * @type {import('./index.js').TargetAdapter['runTests']}
   */
  /** Whether the runner can select tests related to changed files by itself. */
  supportsRelated(dir) {
    const fw = nodeNpmAdapter.testCommand(dir)?.framework;
    return fw === 'jest' || fw === 'vitest';
  },

  async runTests(dir, { files, testFiles, timeoutMs, env } = {}) {
    const empty = { ran: false, tests: [], exitCode: null, durationMs: 0, timedOut: false };
    const cmd = nodeNpmAdapter.testCommand(dir);
    if (!cmd) return empty;
    const start = performance.now();
    const related = files ? files.filter((f) => existsSync(join(dir, f))) : null;
    const explicit = testFiles ? testFiles.filter((f) => existsSync(join(dir, f))) : null;
    if (explicit && explicit.length === 0) return empty;
    const out = await mkdtemp(join(env?.HOME ?? tmpdir(), 'test-out-'));
    const outFile = join(out, 'report.json');
    const finish = (r, tests) => ({
      ran: true,
      tests,
      exitCode: r.code,
      durationMs: Math.round(performance.now() - start),
      timedOut: r.timedOut,
    });
    try {
      if (cmd.framework === 'jest' || cmd.framework === 'vitest') {
        if (related && related.length === 0) return empty; // nothing related to select
        const args = cmd.framework === 'jest'
          ? ['jest', '--json', `--outputFile=${outFile}`, '--ci', '--passWithNoTests',
            ...(explicit ? ['--runTestsByPath', ...explicit] : related ? ['--findRelatedTests', ...related] : [])]
          : ['vitest', ...(explicit ? ['run', ...explicit] : related ? ['related', ...related, '--run'] : ['run']),
            '--reporter=json', `--outputFile=${outFile}`, '--passWithNoTests'];
        const r = await run('npm', ['exec', '--no-install', '--', ...args], { cwd: dir, env, timeoutMs });
        const text = await readFile(outFile, 'utf8').catch(() => '');
        return finish(r, text ? parseJestJson(text, dir) : []);
      }
      if (cmd.framework === 'node:test') {
        const script = explicit
          ? `node --test --test-reporter=junit ${explicit.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(' ')}`
          : readPkg(dir).scripts.test.replace(/(\s)--test(?=\s|$)/, '$1--test --test-reporter=junit');
        const path = `${join(dir, 'node_modules', '.bin')}:${env?.PATH ?? process.env.PATH}`;
        const r = await run('sh', ['-c', script], { cwd: dir, env: { ...env, PATH: path }, timeoutMs });
        return finish(r, parseJunit(r.stdout, dir));
      }
      const r = await run('npm', ['test', '--silent'], { cwd: dir, env, timeoutMs });
      return finish(r, [{ id: 'npm test', file: 'package.json', status: r.code === 0 ? 'pass' : 'fail' }]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  },

  async prepare(cloneDir, { targetPath, touchesManifest, installTimeoutMs, env, ignoreScripts = true }) {
    const start = performance.now();
    const result = (strategy, ok, error) => ({
      strategy,
      ok,
      durationMs: Math.round(performance.now() - start),
      ...(error ? { error } : {}),
    });

    if (touchesManifest) {
      const useCi = LOCKFILES.some((f) => existsSync(join(cloneDir, f)));
      const flags = ignoreScripts ? [...NPM_FLAGS, '--ignore-scripts'] : NPM_FLAGS;
      const r = await run('npm', [useCi ? 'ci' : 'install', ...flags], {
        cwd: cloneDir,
        timeoutMs: installTimeoutMs,
        env,
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
