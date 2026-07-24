# Issue #1393: Release Reliability Fresh Scenario Topology Ledger

## 1. Context & Purpose
Established a dedicated standalone `release-reliability-fresh` scenario producer and catalog ([release-reliability-scenario-catalog.json](file:///home/lyuaoss/projects/FsusBlog/config/testing/release-reliability-scenario-catalog.json)) covering all 7 release reliability scenarios (`release-soak-min`, `release-load-peak`, `release-load-burst`, `release-data-scale-m`, `release-mutation-critical-slice`, `release-memory-leak-budget`, `release-open-handle-budget`).

## 2. Key Changes Made
1. **Scenario Catalog & Ownership**:
   - Created [config/testing/release-reliability-scenario-catalog.json](file:///home/lyuaoss/projects/FsusBlog/config/testing/release-reliability-scenario-catalog.json) establishing 1:1 mapping for all 7 scenarios with scenario ID, owner, command, resource class, and evidence paths.
   - Registered catalog in [config/configuration-ownership.json](file:///home/lyuaoss/projects/FsusBlog/config/configuration-ownership.json).
2. **Resident Scenario Driver**:
   - Implemented [run-release-reliability-scenarios.mjs](file:///home/lyuaoss/projects/FsusBlog/tools/test/run-release-reliability-scenarios.mjs) for running single scenarios (`--scenario <id>`) or all scenarios, generating per-scenario evidence and aggregate summary `.tmp/release-evidence/release-reliability-summary.json`.
3. **Matrix Topology Update**:
   - Updated the 7 release reliability tiers in [tests/matrix.yml](file:///home/lyuaoss/projects/FsusBlog/tests/matrix.yml) to `executionMode: summary`, delegating to `run-release-reliability-scenarios.mjs --scenario <id>`.
   - Cleared `services` (`[]`), `dependsOn` (`[]`), `requiresBootstrap: none`, and `requiresDotnet: false`.
4. **Unit Tests**:
   - Added unit test suite [release-reliability-driver.test.mjs](file:///home/lyuaoss/projects/FsusBlog/tests/tools/release-reliability-driver.test.mjs) (2/2 PASSED).

## 3. Verification & Compliance
- `node tools/test/run-release-reliability-scenarios.mjs` (PASSED)
- `node tools/test/run-release-reliability-scenarios.mjs --scenario release-load-peak` (PASSED)
- `node tools/test/run-release-reliability-scenarios.mjs --validate-catalog` (PASSED)
- `node --test tests/tools/release-reliability-driver.test.mjs` (2/2 PASSED)
- `node tools/configuration/check-configuration-layout.mjs` (PASSED)
- `node --test tests/tools/configuration-layout.test.mjs` (7/7 PASSED)
- `node --test tests/tools/test-matrix-projection-declarations.test.mjs` (2/2 PASSED)
- `node --test tests/tools/release-final-evidence-binding.test.mjs` (2/2 PASSED)
- `node --test tests/tools/local-production-profile.test.mjs` (33/33 PASSED)
