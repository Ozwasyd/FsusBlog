# Canonical Canvas contracts-layer repair — source WIP

The supplied consumer2325 source `a0d58a2f3b5121dd34e6e9a1eabcc836e15b268f`
and the latest canonical Shared source `b304c494de2d805f9b5b70ce8d738b1f1cb6df94`
both retain the runtime import from `contracts/authoringCanvas.ts` into the
binary wire module. The unchanged original `check-binary-import-boundaries.mjs`
forbids every runtime import in contracts, including an import of another
contracts module. Moving the import to a new helper would not repair that rule.

The original Canvas producer now owns the marked client-budget section directly
inside the canonical contract. It resolves all twelve literals from the same
Shared domain owners/schema as its existing wire limits. The contract has no
runtime import. Outside that section and the removed import, the complete
contract is byte-exact to the supplied a0d58a2f source. The original thirteen-case
contract TestOwner is imported byte-exact from canonical b304 (also unchanged in
a0d58a2f). There is no new budget source, exception, anycast or duplicated codec.
Existing managed, TypeScript and C++ wire products are unchanged byte-for-byte.

Required source paths for consumer integration are:

- `tools/contracts/generate-authoring-canvas-wire.mjs`
- `src/frontend/src/contracts/authoringCanvas.ts`
- `tests/tools/authoring-canvas-contract-layer.test.mjs`
- `tests/frontend/unit/contracts/authoringCanvasContract.test.ts`

Ordinary controls: original Canvas wire owner (28 cases) plus four new producer/
layer controls (32 total), original generator `--check`, strict standalone
TypeScript for the contract and wire file, and the unchanged original Vitest
contract owner (13 cases). The layer controls run the original rule on five
explicit actual source files; the exact old import is required to fail. They
check cleanup and do not claim full repository graph acceptance. The original
layer guard and Font/theme API paths are unchanged. No broad frontend type suite
or held audit was run.

Original Vitest config and unit setup/hooks are retained. The first invocation
found no tests due to an incorrect relative file location; that file was moved
back to its canonical path. Two subsequent invocations encountered unavailable
`happy-dom` during the original setup. Exact public versions from the repository
lock, Vitest 4.1.11 and happy-dom 20.9.0, were installed into the task's disposable
`/tmp/chain-3735-tooling/front-test-env` with scripts/audit disabled. The selected
original thirteen cases then passed. This is ordinary source behavior evidence,
not FsusUI runtime/rendered UX or full dependency qualification. The original
Vite extension warning remains visible. Failed setup attempts are retained.

Full #3735/#3736/#3738 runtime/session/Postgres/CAS/provider/UX/full frontend and
canonical CI acceptance gates remain OPEN. Font/theme work belongs to group1.
The frozen 8464/b304 Shared candidates, 6402 Export candidate and supplied a0d58a2f
consumer are immutable; this repair is published on the new isolated current-base
branch. Parent remains the sole GitHub content API writer.

Published/tested source candidate: `af301b7ac1dd3ac88fd2ae42557ff77d52e38e9c`. Final exact-candidate runs passed 32/32 Node controls and 13/13 original Vitest cases; strict two-file TypeScript and generator check exited 0. Logs/reports and retained setup failures are in `canvas-layer-evidence/`; source/output identities and argv are in `canvas-layer-run-evidence.json`. A first evidence-packaging script failed with a Path/string concatenation error after copying logs; this follow-up completes the missing report/manifest without altering test results.
