# Frontend Test Layout

Use `npm run check:*` and `../../../tools/test.sh <tier>` as the stable entry points.
`tests/frontend/` is the only frontend test ownership root. Production source and
runner configuration stay under `src/frontend/`, but no `src/frontend/**/tests/**`
tree is permitted without a reasoned, path-scoped governance exception.

- `checks/`: Node-based gates grouped by tier or subsystem.
- `e2e/`: Playwright specs and their colocated screenshot baselines.
- `fixtures/`: Runtime fixture, account preparation scripts, and cross-stack contract matrices.
- `property/`: Deterministic property tests for normalization, patch algebra, ranking, and boundary invariants.
- `benchmarks/`: Lightweight regression budgets that emit machine-readable evidence under `.tmp/`.
- `support/`: Shared HTTP, auth, binary, corpus, Playwright, and Vitest runtime helpers.
  `support/unit/setup.ts` is the canonical browser-global/WASM mock setup and
  `support/unit/animationFrameEnvironment.ts` owns its animation-frame lifecycle.

Vitest configs remain beside the frontend package and all import
`frontendUnitSetupFile` from `src/frontend/vitest.shared.mjs`; they must not resolve
the support path independently. See
[`../../docs/testing/issue-1173-frontend-test-support-ownership.md`](../../docs/testing/issue-1173-frontend-test-support-ownership.md)
for ownership, transform-cache invalidation, and rollback details.

Fast gate additions:

- `npm run test:property`
- `npm run check:frontend-state-machines`
- `npm run check:worker-contracts`
- `npm run check:frontend-perf-regression`
- `npm run check:a11y:deep`
- `npm run check:frontend-test-governance`
- `npm run check:frontend-test-layout`
- `npm run check:contract:binary-matrix`
- `npm run check:contract:api-parity`
- `npm run check:contract:frame-schema`
- `npm run check:contract:negative-matrix`
- `npm run check:coherence:runtime-matrix`
- `npm run check:cross-stack-test-governance`

Cross-stack contract governance:

- `npm run check:cross-stack-contract` validates the full frontend/backend contract ledger in `fixtures/cross-stack-contract-matrix.json`.
- The ledger covers binary endpoint routes, API wrapper parity, shared AEDS schema sync, negative cases, runtime/distribution/notification stream/upload/auth/SW/perf coherence profiles, fixture families, and eventual-consistency evidence fields.

Keep `../../tools/frontend/` for build, Wasm, public hydration generation, and local utility scripts only.
