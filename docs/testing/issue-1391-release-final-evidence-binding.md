# Issue #1391: Release-Final Pure Evidence Binding Topology Ledger

## 1. Context & Purpose
Issue #1594 hardens the historical #1391 boundary: `release-final` is a pure evidence finalizer (`executionMode: summary`). It validates evidence bindings, publish credentials, and target environment closeout without executing test producers.

## 2. Key Changes Made
1. **Removed Physical Producer Invocations from `release-final`**:
    - `release-final` script files ([release-final.sh](file:///home/lyuaoss/projects/FsusBlog/tools/test/lanes/release-final.sh), [check-release-final.mjs](file:///home/lyuaoss/projects/FsusBlog/tools/release/check-release-final.mjs)) do not call `dotnet test`, `vitest`, `playwright`, `bootstrap-acceptance`, `load-`, `soak`, `mutation`, or `npm build`.
2. **Updated Matrix Topology**:
    - `executionDependsOn` is the only scheduler edge. `requiresEvidenceFrom` is receipt-only and never enters the execution closure.
    - Tier-level `dependsOn` is retired and rejected by the active parser/schema; command-group and local bundle DAGs retain their separately scoped dependency fields.
    - `release-final.executionDependsOn` is empty; its Production, Browser, single qualified Reliability, build, and fuzz inputs remain required evidence.
    - The finalizer is Node-only: `services: []`, `requiresBootstrap: none`, `requiresDotnet: false`, `requiresPlaywright: none`, and `cacheProfile: none`.
3. **Unit & Negative Tests**:
    - `tests/fixtures/test-matrix/execution-dependency-contract.json` seals the carried tier and command-group graphs without requiring Git history. Its only update authority is `node tools/test-matrix/execution-dependency-contract.mjs --write`; `--check` rejects drift.
    - `tests/fixtures/test-matrix/release-final-evidence-inputs.json` is the independent, sorted, unique 17-tier semantic source for the finalizer's exact evidence set. The seven former per-scenario reliability inputs are replaced by the single `release-reliability-fresh` qualified authority. `node tools/test-matrix/release-final-evidence-contract.mjs --write` seals only that source into `release-final-evidence-contract.json`; it never reads `tests/matrix.yml`, and `--check` rejects digest drift. The fixed semantic anchor is `sha256:32497578d8ac83c88d5ecb137912ab4bd8ae4820c66db16aab593847c5459cef`.
    - `release-final-execution-graph.test.mjs` carries a fixed digest anchor independent of the semantic fixture, matrix, and generated contract, so changing and regenerating all three cannot silently bless a deletion, replacement, duplication, or addition. It also checks both default and CI plans, runs their execution commands with process-level producer sentinels, and proves its scheduler-edge mutation fixture observes a producer entering the scheduler.
    - The carried execution graph contract is checked against the current matrix-derived graph without pinning a historical edge count. Evidence-only projection changes can therefore update the graph contract to their integrated current value without restoring retired scheduler edges.
    - `release-final-evidence-binding.test.mjs` runs the real finalizer/checker boundary; missing receipts fail closed without spawning a fallback producer.
    - `release-final-reliability-binding.test.mjs` proves exact-one canonical receipt discovery, independent verifier admission, exact-seven audit projection and source/build/image/fixture/machine/topology/policy/evidence digest drift rejection. Job summaries remain transport-only, and direct memory/open-handle summaries are not alternate correctness authorities.
    - Summary validation binds every required evidence tier to a matching `tierIds` and CI-job identity; missing base or shard evidence reports `./tools/test.sh ci-tier <producer>` without executing it.

## 3. Verification & Compliance
- `! rg -n "dotnet test|vitest|playwright|bootstrap-acceptance|load-|soak|mutation|npm.*build" tools/test/lanes/release-final.sh tools/release/check-release-final.mjs` (0 matches, PASSED)
- `node --test tests/tools/release-final-execution-graph.test.mjs`
- `node --test tests/tools/release-final-evidence-binding.test.mjs`
- `node --test tests/tools/release-final-reliability-binding.test.mjs`
- `node --test tests/tools/release-reliability-receipt.test.mjs`
- `node tools/test-matrix/release-final-evidence-contract.mjs --check`
- `node --test tests/tools/test-matrix-projection-declarations.test.mjs`
- `node --test tests/tools/local-production-profile.test.mjs`
