# Account layout ownership

The account surface has one shared chrome and two deliberately separate workspaces. `AccountLayout.vue` owns the site header, account-wide policy orchestration, logout wiring, the mobile-drawer state and the two nested route outlets. It does not choose page geometry from a leaf route name and it does not own identity or admin page composition.

## Frame boundary

| Owner | Stable responsibility | Excluded responsibility |
| --- | --- | --- |
| `AccountLayout.vue` | shared brand chrome, Main-site/theme/account actions, catalog-backed `LocaleSelectorRuntimeAdapter` slot placement (desktop + mobile compact), one drawer state and named mobile-action outlet; does not own locale runtime/catalog/bundle/preference APIs | identity/admin navigation data, page width, page-kind styling or route motion |
| `AccountIdentityFrame.vue` | self-service navigation context, identity width/content mode and identity page-kind policy | admin permissions, workbench composition or admin status surfaces |
| `AdminWorkspaceFrame.vue` | permission-filtered admin navigation context, admin width/content mode and admin page-kind policy | identity settings/inbox composition or self-service navigation |
| `AccountRouteFrame.vue` | shared desktop rail, content scroll, one mobile Drawer, direct-frame-child route key and main-content focus target | area selection, permission policy or page-specific content |

The unnamed `/user` and `/user/manage` route records select the identity and admin frames. Named leaf routes and their URLs remain stable. Shared chrome stays mounted while the active frame supplies its mobile navigation action through the `accountMobileAction` outlet; a second header or Drawer is not allowed.

Desktop navigation is sticky without an internal leaf-driven scroll container. The main column owns content scrolling. Identity takeover content may fill its outlet, while admin collection, form, settings, dashboard and console composition remains within the admin frame.

## Route metadata authority

Typed route metadata selects composition without coupling the shell to route names:

| Metadata | Responsibility |
| --- | --- |
| `accountArea` | selects the self-service or manage workspace context |
| `accountPageKind` | selects the finite identity/admin page-kind class |
| `accountContentMode` | selects `standard`, `wide` or `takeover` width behavior independently of page kind |
| `routeState` | records URL/query restoration and session sensitivity |
| `requiredAdminPermissions` | participates in admin authorization and navigation filtering |
| feature/policy visibility | hides unavailable navigation leaves without replacing authorization |

Every account leaf must declare valid page-kind and content-mode metadata. Refresh, copied deep links and browser history reconstruct the frame and navigation context from the route; no parallel layout state is authoritative.

## Responsibility links

- [Account navigation](account-navigation.md) owns the two-level navigation, title and header-action hierarchy.
- [Account style ownership](account-style-ownership.md) owns base/identity/admin CSS boundaries and typography roles.
- [Account motion](account-motion.md) owns route replacement, reduced-motion and focus-continuity policy.
- [Admin information architecture](admin-information-architecture.md) owns admin module taxonomy and permission/feature filtering semantics.
- [Admin dashboard task workbench](admin-dashboard-workbench.md) owns dashboard task and summary composition.
- [Layout visual governance](layout-visual-governance.md) alone classifies representative-route and baseline movement.

## Migration record

| Removed implementation record | Canonical target | Disposition |
| --- | --- | --- |
| `docs/issue-1022-admin-dashboard-handoff.md` | `docs/frontend/admin-dashboard-workbench.md` | stable task model retained; test-session narrative removed |
| `docs/issue-1023-admin-ia-handoff.md` | `docs/frontend/admin-information-architecture.md` | admin taxonomy retained; shared shell behavior belongs to account navigation |
| `docs/issue-1291-account-page-title-hierarchy.md` | `docs/frontend/account-navigation.md` | current title hierarchy retained; obsolete selector details removed |
| `docs/issue-1292-account-navigation-hierarchy.md` | `docs/frontend/account-navigation.md` | current navigation hierarchy retained; obsolete typography values removed |
| `docs/issue-1293-account-integer-typography.md` | `docs/frontend/account-style-ownership.md` | current account typography roles retained; superseded acceptance baseline removed |
| `docs/issue-1309-account-frame-handoff.md` | `docs/frontend/account-layout-ownership.md` | frame and route-metadata ownership retained |
| `docs/issue-1310-account-css-ownership-handoff.md` | `docs/frontend/account-style-ownership.md` | CSS layer boundary retained; local run narrative removed |
| `docs/issue-1311-account-header-actions.md` | `docs/frontend/account-navigation.md` | current header action density retained |
| `docs/issue-1312-account-route-motion-handoff.md` | `docs/frontend/account-motion.md` | motion/focus policy retained; transient measurements removed |

Issue numbers remain lifecycle traceability metadata. The removed paths are recorded in the machine-readable `pathMigrations` registry and are not current or historical authorities.
