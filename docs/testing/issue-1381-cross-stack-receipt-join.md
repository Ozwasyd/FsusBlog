# Cross-stack canonical receipt join

`cross-stack-contract` keeps its logical coverage and independent conclusion, but no longer starts the shared OpenAPI, binary, frame, API, runtime, governance, or security checkers. Their physical owners publish current-run receipts after successful execution:

- `frontend-static-governance`: OpenAPI sync/generated/consumer checks, frontend routes, API parity, frame schema, and cross-stack test governance;
- `frontend-runtime-contracts`: binary matrix, negative matrix, and runtime coherence;
- `security-static`: PoW parity and the security matrix/schema gate.

The checked-in ownership registry at `tests/fixtures/evidence-projection/cross-stack-assertion-ownership.json` assigns every assertion to exactly one physical owner. Distribution, notification business events, upload completion, auth state, service-worker/backend cache, the cross-stack performance contract, and the runtime auth-zero probe remain unique Cross-stack executions.

Each owner receipt binds the full source commit, worktree fingerprint, run ID, namespace, assertion IDs, outcomes, artifact paths, artifact digests, and its own canonical digest. The final projector waits only for receipts from the current run, validates the exact registry partition and live artifact digests, and writes `.tmp/release-evidence/cross-stack-contract.json`. Missing shared or unique assertions, duplicate owners, failed outcomes, stale source/run/namespace identities, replaced receipts, and artifact changes fail closed.

Cross-stack static no longer requests a Debug backend filtered build or exports OpenAPI. Its unique source checks require no backend build; the auth-zero runtime assertion uses the already bootstrapped immutable production runtime.

## Local verification

```bash
node --test tests/tools/cross-stack-receipt-join.test.mjs
node tools/run-test-matrix.mjs validate
```
