# Issue #1023 admin information-architecture handoff

This handoff describes landed source and planned executable evidence; it does not claim validation has run.

## Landed behavior

- `accountNav.ts` models the admin surface as six first-level modules: Workbench, Content, Interaction, Security, System and Operations. The hard limit remains seven.
- Permissions, feature flags and policy gates filter leaves before a module is created. Empty modules disappear instead of exposing disabled or unauthorized links, and fallback landing routes use the first authorized leaf.
- `AccountNavigationPanel.vue` renders all visible first-level modules and only the current module's local destinations, with separate ARIA labels and `aria-current` state.
- `AccountLayout.vue` derives module and leaf state directly from `route.path`, preserving URL, refresh, deep-link and browser-history behavior. Desktop has no leaf-driven sidebar scroll container; mobile uses one Drawer for both levels with 44px targets and current-context naming.
- `AccountHeaderMenu.vue` owns guidelines, privacy and logout. The persistent header keeps only brand, main-site switch, theme, account menu and the required mobile Drawer trigger.
- Appearance/customization remains a System-local workspace and does not become a competing global IA.

## Direct test owners

- `tests/frontend/unit/layouts/accountNavModules.test.ts` covers the full/reduced permission matrix, feature/policy gates, unchanged URLs and prefix-sensitive deep links.
- `tests/frontend/unit/components/account/AccountNavigationPanel.test.ts` covers six global links, current-module leaves and route-driven current state.
- `tests/frontend/e2e/acceptance/admin-console.spec.ts` covers Drawer context/focus, navigation, browser back, runtime 44px module/local targets and desktop sidebar overflow at the acceptance viewport.
- the 1366 x 768 first-fold section in `tests/frontend/e2e/visual/console-visual.spec.ts` covers the non-scrolling desktop rail with the live admin shell.
- `tests/frontend/checks/static/check-visual-density-governance.mjs` protects the single-Drawer/module-panel structure.

## Static acceptance audit

| Acceptance | Static evidence |
| --- | --- |
| Six first-level modules, hard limit seven | `accountNav.ts` defines Workbench, Content, Interaction, Security, System and Operations templates and applies `ACCOUNT_GLOBAL_MODULE_LIMIT = 7`; the full-permission unit matrix asserts their exact order and landing URLs. |
| Fail-closed leaf filtering | `getAccountNavGroups` applies principal, permission, feature and policy gates before module creation, drops empty modules and selects the preferred or first authorized leaf as the landing route. Reduced/audit-only matrices exercise both omission and fallback. |
| URL and deep-link continuity | Existing route URLs are used unchanged. Explicit item matching separates article create/edit, nested security, anonymous governance and integrity-proof prefixes; both `AccountLayout` and `AccountNavigationPanel` derive current context from `route.path`. |
| Desktop two-level rail | `AccountNavigationPanel` renders all visible modules and only the active module's leaves with distinct ARIA labels/current values. `AccountLayout` gives the rail no internal overflow container; static and 768px live visual owners protect that boundary. |
| One mobile Drawer | `AccountLayout` mounts one `el-drawer` and reuses the same navigation panel for both levels. Module/local links have `min-height: 2.75rem`; acceptance now measures both visible targets at 44px or greater in addition to focus containment and hit testing. |
| Header action boundary | Persistent slots contain brand chrome, main-site switch, theme, account menu and the mobile-only Drawer trigger. `AccountHeaderMenu` owns surface switching, guidelines, privacy and logout. |
| Appearance remains local | The only System-level destination is the existing settings workspace; no appearance module, tab row, second Drawer or separate mobile group store was introduced. |

No production-source defect was found during this audit. The direct browser owner was
strengthened so its previous “44px controls” claim is now backed by measured module and
local-link bounding boxes rather than implementation text alone.

## Central registration

The central registry now owns this issue as `frontend-admin-information-architecture`
in `frontend-unit-shard`, `acceptance`, and `visual-console`. The consolidated
visual-density checker remains under the existing `frontend-static-governance`
coverage instead of creating another static tier. Registered paths are:

- `src/frontend/src/layouts/accountNav.ts`
- `src/frontend/src/layouts/accountWorkspaceContext.ts`
- `src/frontend/src/layouts/AccountLayout.vue`
- `src/frontend/src/components/account/AccountNavigationPanel.vue`
- `src/frontend/src/components/account/AccountHeaderMenu.vue`
- `tests/frontend/unit/layouts/accountNavModules.test.ts`
- `tests/frontend/unit/components/account/AccountNavigationPanel.test.ts`
- `tests/frontend/e2e/acceptance/admin-console.spec.ts`
- `tests/frontend/e2e/visual/console-visual.spec.ts`
- `tests/frontend/checks/static/check-visual-density-governance.mjs`
- `docs/issue-1023-admin-ia-handoff.md`

## Risk and rollback

No route or backend permission was renamed. If a feature/policy source becomes unavailable, its gated leaf and any resulting empty module fail closed. The route remains directly addressable only when the existing router and server authorization allow it.

## Validation status

The source-level acceptance audit is complete. No test, build, lint, checker or syntax
command was run; executable validation remains pending the unified phase by instruction.
