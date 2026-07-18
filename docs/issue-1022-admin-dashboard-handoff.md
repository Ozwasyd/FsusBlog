# Issue #1022 admin dashboard handoff

This file records implementation ownership only; it is not generated test output.

## Landed behavior

- `Dashboard.vue` now owns a single task-workbench composition. The repository-maintenance welcome callout, icon KPI cards and embedded chart/analytics wall are absent from the production first view.
- `AdminDashboardTaskWorkbench.vue` exposes four direct actions: pending comments, pending tickets, cache/index incidents and new-article authoring. Each zero, loading and error state gives a concrete next action.
- `useAdminDashboardWorkbench.ts` reads the four independent sources concurrently and keeps failures isolated. It does not change backend APIs or statistics definitions.
- The site summary is a compact three-value `dl` ledger; detailed traffic/RUM/AOT/reading analysis remains behind the existing analytics route.
- Repository feedback moved behind the collapsed `帮助与反馈` disclosure, so the first view contains no GitHub/Issue/maintenance banner.

## Direct test owners

- `tests/frontend/unit/components/admin/AdminDashboardTaskWorkbench.test.ts`
- `tests/frontend/unit/composables/useAdminDashboardWorkbench.test.ts`
- `tests/frontend/unit/view-contracts/adminDashboardWorkbench.test.ts`
- `tests/frontend/e2e/visual/admin-dashboard-workbench.spec.ts`
- the 1366 x 768 first-fold section in `tests/frontend/e2e/visual/console-visual.spec.ts`
- the dashboard task-flow section in `tests/frontend/e2e/acceptance/admin-console.spec.ts`
- the dashboard contract section in `tests/frontend/checks/static/check-visual-density-governance.mjs`

Together these sources cover zero/high workload, desktop/mobile, Light/Dark, all direct task routes, compact ledger semantics, explicit recovery states, feedback disclosure and the 768px desktop viewport.

## Static acceptance audit

| Acceptance | Static evidence |
| --- | --- |
| Task-first first view | `Dashboard.vue` delegates its entire template to `AdminDashboardTaskWorkbench`; the workbench renders `今日待处理` before `站点摘要` and imports none of the legacy analytics panels. |
| Four direct actions | `createAdminDashboardTasks` returns comment moderation, message tickets, cache/index diagnostics and article writing in a fixed order with named router destinations. Its unit owner covers zero, high, loading, idle and error copy. |
| Concurrent, isolated reads | `useAdminDashboardWorkbench` owns four separate `useViewTask` instances and starts stats, comments, tickets and cache through one `Promise.all`. The composable test now holds all four promises open and proves every request starts before any source resolves. |
| Compact summary boundary | `AdminDashboardTaskWorkbench.vue` renders a three-value semantic `dl` and links to `ManageAnalytics`; no read-total, chart, icon KPI card or embedded analytics component is present. |
| Recoverable and zero states | Task rows remain router links in every read state. Summary loading is announced, failure exposes `重新加载摘要`, and zero copy points to writing an article instead of a generic empty card. |
| Feedback migration | The page header owns a collapsed native `details` disclosure with a separately labelled navigation region and neutral external-link copy. |
| Visual and fold coverage | The isolated visual fixture spans zero/high x desktop/mobile x Light/Dark; the live console visual suite owns the complete 1366 x 768 first-fold assertion. |

The static-governance cross-line assertions for task-before-summary order and the
help disclosure were corrected from literal `[sS]*` matching to `[\s\S]*`, so the
checker now describes the intended source contract instead of an unreachable pattern.

## Central registration

The central registry now owns this issue as `frontend-admin-task-first-dashboard` in
`frontend-unit-shard` and `visual-console`. The consolidated visual-density checker
continues to run through the existing `frontend-static-governance` coverage instead
of creating a duplicate issue-specific static tier. Registered paths are:

- `src/frontend/src/views/admin/Dashboard.vue`
- `src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue`
- `src/frontend/src/composables/useAdminDashboardWorkbench.ts`
- `src/frontend/src/view-contracts/adminDashboard.ts`
- `tests/frontend/fixtures/adminDashboardWorkbenchVisual.ts`
- `tests/frontend/unit/components/admin/AdminDashboardTaskWorkbench.test.ts`
- `tests/frontend/unit/composables/useAdminDashboardWorkbench.test.ts`
- `tests/frontend/unit/view-contracts/adminDashboardWorkbench.test.ts`
- `tests/frontend/e2e/visual/admin-dashboard-workbench.spec.ts`
- `tests/frontend/e2e/visual/console-visual.spec.ts`
- `tests/frontend/e2e/acceptance/admin-console.spec.ts`
- `tests/frontend/checks/static/check-visual-density-governance.mjs`
- `docs/issue-1022-admin-dashboard-handoff.md`

## Risk and rollback

The workbench consumes existing read APIs only. A source failure degrades its row independently and keeps the destination link usable; summary reload is explicit. Detailed analytics remains available on its dedicated route, so disabling the new dashboard composition does not require an API rollback.

## Validation status

The source-level acceptance audit is complete. No test, build, lint, checker or syntax
command was run; executable validation remains deferred until the unified phase.
