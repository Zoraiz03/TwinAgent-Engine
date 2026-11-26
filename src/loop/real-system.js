/**
 * RealSystem: the working directory that stands in for the real codebase.
 * The engine only ever simulates on clones of it; the RealSystem itself is
 * touched only by apply() (git apply + git commit) and restore().
 *
 * observe(baselineId) is ground truth: the FULL checks (psi1 full suite, psi2
 * full scan, psi3 full dependency/import analysis, psi4) on the current state
 * versus the pre-change baseline, with the twin DISABLED, so observations
 * never depend on the twin. Optional runtime `probes` (commands run in the
 * real directory, e.g. a smoke run of a CLI) stand in for production signals
 * that tests cannot see; a failing probe marks its psi as violated.
 * Optional `telemetrySource()` returns OTel-shaped spans for the twin.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, mergeConfig, simulate } from '../engine/index.js';
import { scrubbedEnv } from '../engine/env.js';
import { run } from '../engine/exec.js';

/** Observation settings: ground truth must not depend on the twin or on diff scoping. */
export const OBSERVE_CONFIG = {
  twin: { enabled: false },
  tests: { scope: 'full', tamperingDetection: false },
  analysisScope: 'full',
};

const GIT_ID = ['-c', 'user.name=TwinAgent', '-c', 'user.email=twinagent@localhost', '-c', 'commit.gpgsign=false'];

/**
 * @typedef {{name: string, cmd: string, args?: string[], psi?: 'psi1'|'psi2'|'psi3'|'psi4', timeoutMs?: number}} Probe
 */

export class RealSystem {
  /**
   * @param {string} dir
   * @param {{config?: any, probes?: Probe[], telemetrySource?: () => Promise<any[]>, tmpRoot?: string}} [opts]
   */
  constructor(dir, { config = {}, probes = [], telemetrySource, tmpRoot } = {}) {
    this.dir = dir;
    this.config = config;
    this.probes = probes;
    this.telemetrySource = telemetrySource;
    this.tmpRoot = tmpRoot;
  }

  /** Wrap `dir`, turning it into a git repo with one commit if it is not one. */
  static async init(dir, opts) {
    const real = await realpath(dir);
    const sys = new RealSystem(real, opts);
    const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd: real });
    if (top.code !== 0 || (await realpath(top.stdout.trim())) !== real) {
      await sys._git(['init', '-q']);
      await mkdir(join(real, '.git', 'info'), { recursive: true });
      await run('sh', ['-c', 'echo node_modules >> .git/info/exclude'], { cwd: real });
      await sys._git(['add', '-A']);
      await sys._git(['commit', '-q', '-m', 'twinagent: initial state']);
    }
    return sys;
  }

  async _git(args, input) {
    const r = await run('git', [...GIT_ID, ...args], { cwd: this.dir, input, timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    return r.stdout.trim();
  }

  async head() {
    return this._git(['rev-parse', 'HEAD']);
  }

  /** Commit any uncommitted state and return the commit id. */
  async snapshot() {
    if (await this._git(['status', '--porcelain'])) {
      await this._git(['add', '-A']);
      await this._git(['commit', '-q', '-m', 'twinagent: snapshot']);
    }
    return this.head();
  }

  /** Return the tree to a snapshot (tracked files reset, untracked files removed; ignored files kept). */
  async restore(id) {
    await this._git(['reset', '-q', '--hard', id]);
    await this._git(['clean', '-q', '-fd']);
  }

  /**
   * Apply a diff and commit it.
   * @returns {Promise<{ok: true, commit: string} | {ok: false, error: string}>}
   */
  async apply(diff, message = 'twinagent: apply change') {
    const input = diff.endsWith('\n') ? diff : `${diff}\n`;
    try {
      await this._git(['apply', '--check', '--index', '--whitespace=nowarn', '-'], input);
      await this._git(['apply', '--index', '--whitespace=nowarn', '-'], input);
      await this._git(['commit', '-q', '-m', message]);
      return { ok: true, commit: await this.head() };
    } catch (err) {
      await this._git(['reset', '-q', '--hard', 'HEAD']).catch(() => {});
      return { ok: false, error: err.message };
    }
  }

  /**
   * Ground-truth observation of HEAD against `baselineId`.
   * @param {string} baselineId
   */
  async observe(baselineId) {
    const start = performance.now();
    const headId = await this.head();
    const diff = await this._git(['diff', '--binary', '-M', baselineId, headId]).then((d) => `${d}\n`);
    const root = await mkdtemp(join(this.tmpRoot ?? tmpdir(), 'twinagent-observe-'));
    const base = join(root, 'base');
    await this._git(['worktree', 'add', '-q', '--detach', base, baselineId]);
    try {
      const report = await simulate({ target: base, diff, tmpRoot: this.tmpRoot, config: mergeConfig(this.config, OBSERVE_CONFIG) });
      const home = join(root, 'home');
      await mkdir(home);
      const probes = [];
      for (const p of this.probes) {
        const r = await run(p.cmd, p.args ?? [], { cwd: this.dir, env: scrubbedEnv({ home, allow: this.config?.env?.allow }), timeoutMs: p.timeoutMs ?? 60_000 });
        const passed = r.code === 0 && !r.timedOut;
        probes.push({ name: p.name, psi: p.psi ?? 'psi1', passed, exitCode: r.code, timedOut: r.timedOut, output: (r.stderr || r.stdout).trim().slice(-500) });
      }
      for (const p of probes.filter((x) => !x.passed)) {
        const check = report[p.psi];
        if (!check) continue;
        check.passed = false;
        check.inconclusive = false;
        check.severity = 'high';
        check.evidence.push({ kind: 'runtime-probe-failed', detail: `probe "${p.name}" failed (exit ${p.exitCode}${p.timedOut ? ', timed out' : ''})`, files: [], severity: 'high' });
      }
      if (probes.some((p) => !p.passed)) {
        report.classification = classify(['psi1', 'psi2', 'psi3', 'psi4'].map((id) => report[id]).filter(Boolean));
      }
      const spans = this.telemetrySource ? await this.telemetrySource() : [];
      return { ...report, probes, spans, baselineId, headId, observeMs: Math.round(performance.now() - start) };
    } finally {
      await run('git', ['worktree', 'remove', '--force', base], { cwd: this.dir });
      await rm(root, { recursive: true, force: true });
      await run('git', ['worktree', 'prune'], { cwd: this.dir });
    }
  }
}
