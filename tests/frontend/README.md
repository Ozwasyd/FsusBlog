# Frontend Test Layout

Use `npm run check:*` and `../../../tools/test.sh <tier>` as the stable entry points.

- `checks/`: Node-based gates grouped by tier or subsystem.
- `e2e/`: Playwright specs and their colocated screenshot baselines.
- `fixtures/`: Runtime fixture and account preparation scripts.
- `property/`: Deterministic property tests for normalization, patch algebra, ranking, and boundary invariants.
- `model/`: State-machine tests for interaction workflows that should not be verified only through visible-page smoke.
- `benchmarks/`: Lightweight regression budgets that emit machine-readable evidence under `.tmp/`.
- `support/`: Shared HTTP, auth, binary, corpus, and Playwright helpers.

Fast gate additions:

- `npm run test:property`
- `npm run check:frontend-state-machines`
- `npm run check:worker-contracts`
- `npm run check:frontend-perf-regression`
- `npm run check:a11y:deep`
- `npm run check:frontend-test-governance`

Keep `../../tools/frontend/` for build, Wasm, public hydration generation, and local utility scripts only.
