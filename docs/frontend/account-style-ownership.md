# Account style ownership

Account styling is split by surface responsibility. Shared chrome and geometry cannot become a back door for identity/admin inheritance, and consumer CSS cannot reach into FsusUI component internals.

## Layer boundary

| Layer | Owns | Must not own |
| --- | --- | --- |
| `account-shell-base.css` | account palette/type context, header action family, mobile Drawer application hooks, shared route/sidebar/main/outlet geometry | identity/admin page composition or FsusUI Drawer/control internals |
| `account-identity.css` | `.account-identity-frame` widths, takeover height and identity settings/inbox composition | admin status, workbench, table or console composition |
| `admin-workspace.css` | `.admin-workspace-frame` status tokens, alerts, workbench, list/form/settings/console widths and admin data-surface composition | identity pages or generic FsusUI control/table internals |

`AccountLayout.vue` owns markup rather than page CSS. `AccountRouteFrame.vue` exposes shared application hooks, and each area frame supplies its required root class. Teleported admin overlays carry the admin frame root so admin status composition stays scoped. The three layers do not use `.el-*` selectors; supported public tokens, slots and application hooks are the only component boundary.

Responsive ownership stays at the established account tiers. Shared geometry owns the desktop rail/content relationship and mobile Drawer application surface; identity/admin layers may refine their own composition without crossing frame roots.

## Typography roles

Account route headings use the canonical task-page header described in [Account navigation](account-navigation.md). Compact navigation currently uses 11px group labels and 13px module/local labels. Identity status, summary and policy copy may use the repository's maintained small-text roles, but no deleted issue document is an independent numeric baseline. Repository font-size and loaded-weight checkers remain authoritative for globally allowed values.

## Change boundary

A style ownership change does not imply a visual baseline move. Classify representative-route movement only through [Layout visual governance](layout-visual-governance.md) and its single ledger. Domain documentation links to that process and does not copy its archetype or approval registry.

No layer may change route identity, authorization, notification stream, binary contracts or backend APIs. Runtime behavior belongs to its owning implementation contract, not to CSS.
