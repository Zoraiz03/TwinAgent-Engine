# twinagent-engine

Research implementation of **TwinAgent**, a five-layer framework that simulates an AI coding agent's proposed change on an isolated clone of a target codebase *before* committing it, and returns a **Safe / Revise / Abort** verdict. The engine forks a clone, applies the diff, runs four checks in parallel (psi1 tests, psi2 security, psi3 dependencies, psi4 performance) and aggregates a consequence report. The original target is never modified. Check logic is currently stubbed with deterministic fake results.

```sh
npm install
npm test        # node:test smoke tests
npm run lint
node bin/twinagent.js simulate --target <path> --diff <file>
```

`psi2` uses [Semgrep](https://semgrep.dev) (optional; without it the check reports `inconclusive`) with the local rules in `rules/semgrep/`, plus a pluggable dependency-advisory provider (`security.vulnProvider`: `npm-audit`, `osv-scanner`, or a frozen `fixture` file).

By default the engine runs in `twin` mode: it builds a digital twin graph of the target once per state (`src/twin/`), forks it per simulation, and syncs it incrementally with the diff. Set `twin.enabled: false` for `plain` mode, the ablation baseline without the twin.

The decision loop (`src/loop/`, paper Algorithm 1) drives an LLM agent (`src/agent/`): propose a diff, simulate it, commit Safe changes to a `RealSystem` working directory, observe ground truth there, and log predicted-vs-observed outcomes as JSONL (`eval.logPath`). `node scripts/live-smoke.js --yes` runs one task against a real provider (`TWINAGENT_PROVIDER`); it is not part of `npm test`.
