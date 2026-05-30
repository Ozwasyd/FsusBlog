# Frontend Test Layout

Use `npm run check:*` and `../../../tools/test.sh <tier>` as the stable entry points.

- `checks/`: Node-based gates grouped by tier or subsystem.
- `e2e/`: Playwright specs and their colocated screenshot baselines.
- `fixtures/`: Runtime fixture and account preparation scripts.
- `support/`: Shared HTTP, auth, binary, corpus, and Playwright helpers.

Keep `../../tools/frontend/` for build, Wasm, public hydration generation, and local utility scripts only.
