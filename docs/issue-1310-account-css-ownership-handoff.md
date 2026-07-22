# Issue #1310 Account CSS ownership handoff

## Ownership result

The former `account-shell.css` mixed shared chrome, identity composition, admin
task surfaces, and FsusUI internal selectors. It has been removed and replaced
by three explicit consumer-owned layers:

| Layer | Owns | Does not own |
| --- | --- | --- |
| `account-shell-base.css` | account palette/type context, header actions, mobile drawer application hooks, shared route/sidebar/main/outlet geometry | identity/admin page composition; FsusUI drawer or control internals |
| `account-identity.css` | `.account-identity-frame` outlet width, takeover height, identity settings/inbox page composition | admin status, data surfaces, or workbench composition |
| `admin-workspace.css` | `.admin-workspace-frame` status tokens, alerts, dashboard/workbench, list/form/settings/console widths and data-surface composition | identity pages or generic FsusUI control/table internals |

`AccountLayout.vue` now owns markup only. `AccountRouteFrame.vue` exposes stable
application hooks and receives a required frame root from
`AccountIdentityFrame.vue` or `AdminWorkspaceFrame.vue`. The identity page-kind
mapping now emits explicit identity classes, so every page declaration is
contained by one frame owner. The teleported user-ban dialog carries the same
admin frame root on its overlay, so admin status composition remains scoped
without leaking globally. The three CSS files contain no `.el-*` selector,
and the former boundary exemptions for account shell and drawer internals are
deleted.

Responsive ownership remains at the existing `640px` and `1024px` layout tiers,
with the compact landscape rule at `520px` height. The wider `768px` and
`1440px` tiers remain owned by the existing account page/component contracts;
this change neither duplicates nor overrides them.

## Before/after visual evidence

A local Playwright fixture loaded the same semantic account frame against the
latest pre-change CSS and the candidate CSS, with the baseline's former Vue
Tailwind geometry projected into the harness. Each run verified the intended
URL/title, meaningful H1 content, no Vite overlay, zero page or console
error/warning diagnostics, zero horizontal overflow, and a real action state
change with a `44px` target.

The review-only comparison set was retired after ownership transfer. Current
account/admin composition is represented by the deterministic
[admin dashboard](assets/screenshots/admin-dashboard.png),
[security console](assets/screenshots/security-console.png), and
[operations status](assets/screenshots/operations-status.png) baselines.

There are no product-owned visual regressions. The only visible change is the
intended inbox takeover fill, which prevents unused frame height from escaping
the inbox surface after the ownership move.

## Focused verification

- account CSS ownership, FsusUI boundary, task-surface geometry, visual density,
  motion, title scale, foundation token, shell material, and UX semantics checks
  pass;
- local-FsusUI type checking passes;
- account page-kind, route-frame, title hierarchy, and integer typography tests
  pass (15 tests);
- `check-font-size-contract` reports the same existing
  `ArticleCommentsVirtualList.vue` comment-time failure on both `origin/master`
  and this branch, so #1310 does not introduce or widen it;
- the changed-style runner reaches the repository's existing missing specialized
  formatter/toolchain boundary; no command-registry or aggregate-governance
  change was added because that belongs to the follow-up governance issue.

No backend API, route contract, authentication, notification stream, binary/AEDS
contract, production runtime, deployment, or publication path changed.
