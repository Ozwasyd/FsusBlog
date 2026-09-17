# Issue #1392: Release Tiers Canonical Evidence Projection Ledger

## 1. Context & Purpose
Refactored the 9 duplicate release runtime and AOT tiers (`release-admin-console`, `release-auth-flow`, `release-authoring-flow`, `release-private-preview`, `release-error-boundary`, `release-rbac-negative`, `release-aot-generation`, `release-aot-consumption`, `release-static-asset-digest-coherence`) to use canonical evidence projection (`executionMode: summary`) instead of re-executing physical Vitest, Playwright, or script producers.

## 2. Key Changes Made
1. **Eliminated Standalone Script Invocations**:
   - Replaced `tools/test/lanes/release-runtime-flow.sh` and `tools/test/lanes/release-aot-coherence.sh` calls in [tests/matrix.yml](file:///home/lyuaoss/projects/FsusBlog/tests/matrix.yml) with Node matrix summary aggregation (`executionMode: summary`).
2. **Resource & Dependency Cleansing**:
   - Cleared `services` (`[]`), `dependsOn` (`[]`), `requiresBootstrap: none`, and `requiresDotnet: false` for all 9 tiers.
   - Reduced resource allocation (`cost: low`, `resourceClass: io`) for lightweight evidence projection.
3. **Replacement Ledger**:
   - `release-admin-console` -> Projected from frontend unit/component tests (`index.test.ts`, `MessagesStateMachine.test.ts`, `AccountNavigationPanel.test.ts`, `AdminDashboardTaskWorkbench.test.ts`)
   - `release-auth-flow` -> Projected from `AuthFlowStates.test.ts`
   - `release-authoring-flow` -> Projected from `test-quality-summary.json`
   - `release-private-preview` -> Projected from `test-quality-summary.json`
   - `release-error-boundary` -> Projected from `test-quality-summary.json`
   - `release-rbac-negative` -> Projected from security domain evidence (`.tmp/security`)
   - `release-aot-generation` -> Projected from release evidence (`.tmp/release-evidence`)
   - `release-aot-consumption` -> Projected from Playwright & release evidence (`src/frontend/test-results/playwright`)
   - `release-static-asset-digest-coherence` -> Projected from publish artifacts summary (`publish-artifacts-summary.json`)

## 3. Verification & Compliance
- `! rg -n "release-runtime-flow\.sh|release-aot-coherence\.sh" tests/matrix.yml` (0 matches, PASSED)
- `node --test tests/tools/test-matrix-projection-declarations.test.mjs` (2/2 PASSED)
- `node --test tests/tools/release-final-evidence-binding.test.mjs` (2/2 PASSED)
- `node --test tests/tools/local-production-profile.test.mjs` (33/33 PASSED)
