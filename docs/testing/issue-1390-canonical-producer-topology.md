# Issue #1390: Production Fresh Canonical Producer Topology Ledger

## 1. Context & Purpose
Refactored Production Fresh topology to converge logical tiers onto canonical producers and completely remove physical process scheduling for no-op/summary/projection nodes.

## 2. Key Changes Made
1. **Removed `noop.sh` Physical Scheduling**:
   - `frontend-fast-summary`: Categorized as `executionMode: summary`.
   - `fast`: Categorized as `executionMode: summary`.
   - `coverage-gate`: Categorized as `executionMode: summary`.
   - `ci`: Categorized as `executionMode: summary`.
   - `browser-diagnostics`: Categorized as `executionMode: summary`.
   - `production`: Categorized as `executionMode: summary` (CLI alias resolving to `production-correctness`).
2. **Fixed `NODE_OPTIONS` environment resolution**:
   - Fixed invalid `cachePreload` in [production-build-layout.mjs](file:///home/lyuaoss/projects/FsusBlog/tools/test-matrix/production-build-layout.mjs) that introduced malformed `--import` flags into spawned Node processes.
3. **Updated Bundle Steps**:
   - Replaced `tools/test/lanes/noop.sh production` in [bundle-steps.mjs](file:///home/lyuaoss/projects/FsusBlog/tools/test/bundles/bundle-steps.mjs) with `tools/test/lanes/production-correctness-receipt.sh`.
4. **Added Projection Verification Tests**:
   - Created [test-matrix-projection-declarations.test.mjs](file:///home/lyuaoss/projects/FsusBlog/tests/tools/test-matrix-projection-declarations.test.mjs) to enforce schema compliance and verify zero `noop.sh` physical scheduling.

## 3. Verification & Compliance
- `rg -n "noop\.sh (production|fast|frontend-fast-summary|coverage-gate)" tests/matrix.yml` (0 matches, PASSED)
- `node --test tests/tools/test-matrix-projection-declarations.test.mjs` (2/2 PASSED)
- `node --test tests/tools/local-production-profile.test.mjs` (33/33 PASSED)
- `node --test tests/tools/test-matrix-scheduler.test.mjs` (74/74 PASSED)
