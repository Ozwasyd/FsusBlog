# Issue #1312 Account route motion handoff

## Frame-owned policy

`AccountRouteFrame.vue` keeps the stable header/sidebar outside the route
transition and receives a typed policy from its owning frame. The policy table
is defined in `accountRouteMotion.ts` and does not branch on route names:

| Frame / page kind | Policy | Reason |
| --- | --- | --- |
| identity `identity-settings` / `settings` | FsusUI `identityRoute` (`ownership-transfer-snapshot`) | subtle opacity-only continuity; no translate, scale, stagger, or literal duration |
| identity inbox or any takeover content | immediate replacement | preserve pane and conversation continuity |
| other identity page kinds | immediate replacement | avoid decorative route motion |
| every admin page kind, including form/editor | immediate replacement | avoid `out-in` delay and preserve task/focus/unsaved-state semantics |
| any frame under reduced motion | immediate replacement | reuse the shared `useMotionPreference()` contract |

The previous literal `220ms` and `mode="out-in"` are removed. The optional
identity handoff consumes the FsusUI preset's registered duration and easing.
Existing Drawer, Dialog, Popover, row, and panel motion remains locally owned by
FsusUI or the corresponding view.

## Focus and remount behavior

The existing route-view key remains unchanged, including its nested admin
record behavior. Keyboard focus held by stable header/sidebar navigation stays
on that control. If navigation is programmatic or begins inside the outgoing
view, the next route tick focuses `#account-main` with `preventScroll`, so focus
cannot fall back to `body` after a crossfade removes the old node.

The first browser run exposed a defect in the initial implementation: waiting
for the outgoing node to disconnect missed the identity crossfade's later leave
completion. The final implementation restores meaningful focus immediately on
the committed route tick while still leaving stable chrome focus untouched.

## Before/after motion evidence

A local Playwright fixture used the real FsusUI `FsuTransition` and the candidate
typed policy. The baseline branch reproduced the former global
`out-in + 220ms` behavior. Mutation-observer frame sequences measured when the
new view first entered the DOM:

| Flow | Before | After | Classification |
| --- | ---: | ---: | --- |
| identity settings -> passkeys, mobile | 240ms | 5ms | intended continuity improvement: new view participates in an opacity crossfade immediately instead of waiting for old-view leave |
| admin dashboard -> collection, desktop | 286ms | 26ms | intended continuity improvement: immediate task replacement removes global leave delay |
| identity settings -> inbox takeover, mobile | global policy would delay | 7ms | intended pane-continuity correction: no route animation |
| identity settings -> passkeys, reduced motion | global policy would animate | 9ms | required accessibility correction: immediate replacement |

Representative transient frames:

| State | Evidence |
| --- | --- |
| identity before: old view still fading after navigation | [image](assets/screenshots/issue-1312/before-identity-transient.png) |
| identity after: new view present in the first sampled frame | [image](assets/screenshots/issue-1312/after-identity-transient.png) |
| admin before: old dashboard still fading | [image](assets/screenshots/issue-1312/before-admin-transient.png) |
| admin after: collection immediately visible | [image](assets/screenshots/issue-1312/after-admin-transient.png) |
| inbox takeover after: pane immediately visible | [image](assets/screenshots/issue-1312/after-inbox-transient.png) |
| reduced motion after: target immediately visible | [image](assets/screenshots/issue-1312/after-reduced-transient.png) |

Settled composition evidence is also retained for
[identity before](assets/screenshots/issue-1312/before-identity-settled.png) /
[identity after](assets/screenshots/issue-1312/after-identity-settled.png) and
[admin before](assets/screenshots/issue-1312/before-admin-settled.png) /
[admin after](assets/screenshots/issue-1312/after-admin-settled.png). Inspection
found no layout, typography, spacing, color, border, or content change. The
desktop admin pair differs by six antialias pixels; the mobile identity pair's
small difference is localized to navigation text rasterization, with unchanged
DOM, CSS, geometry, and content.

Every final scenario verified the exact URL/title, meaningful H1 content, no
Vite overlay, zero console/page errors or warnings, stable chrome identity,
keyboard focus retention, programmatic focus restoration to `account-main`, no
zero-view frame in the candidate, and zero horizontal overflow.

## Focused verification

- motion governance passes across 491 source files;
- typed policy/focus and account frame unit tests pass (6 tests);
- local-FsusUI type checking passes;
- browser sequence checks pass at `390x844` and `1365x768` with ordinary and
  reduced-motion preferences.

No static production style, route URL, data loading, session state,
authorization, Drawer/Dialog/Popover motion, production runtime, deployment, or
publication behavior changed.
