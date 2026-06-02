# Frontend Test Layout

Use `npm run check:*` and `../../../tools/test.sh <tier>` as the stable entry points.

- `checks/`: Node-based gates grouped by tier or subsystem.
- `e2e/`: Playwright specs and their colocated screenshot baselines.
- `fixtures/`: Runtime fixture, account preparation scripts, and cross-stack contract matrices.
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
- `npm run check:contract:binary-matrix`
- `npm run check:contract:api-parity`
- `npm run check:contract:frame-schema`
- `npm run check:contract:negative-matrix`
- `npm run check:coherence:runtime-matrix`
- `npm run check:cross-stack-test-governance`

Cross-stack contract governance:

- `npm run check:cross-stack-contract` validates the full frontend/backend contract ledger in `fixtures/cross-stack-contract-matrix.json`.
- The ledger covers binary endpoint routes, API wrapper parity, shared AEDS schema sync, negative cases, runtime/distribution/SSE/upload/auth/SW/perf coherence profiles, fixture families, and eventual-consistency evidence fields.

Keep `../../tools/frontend/` for build, Wasm, public hydration generation, and local utility scripts only.
