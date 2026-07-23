# Account motion

Account route motion is frame-owned. The shared header and sidebar remain mounted outside the route transition, while the active identity or admin frame supplies a typed policy based on area, page kind and content mode. Policy does not branch on route names.

## Route policy

| Surface or content | Policy | Reason |
| --- | --- | --- |
| identity settings with standard content | FsusUI `identityRoute` preset (`ownership-transfer-snapshot`) | opacity-only identity continuity |
| identity inbox or any takeover content | immediate replacement | preserve pane and conversation continuity |
| other identity page kinds | immediate replacement | avoid decorative route motion |
| every admin page kind | immediate replacement | preserve task focus and unsaved-state semantics without leave delay |
| any route under reduced motion | immediate replacement | honor the shared motion preference |

The optional identity transition consumes the registered FsusUI duration and easing. Literal route durations, translate/scale/stagger effects and `out-in` sequencing are not part of the account contract. Drawer, Dialog, Popover, row and panel motion remain owned by their component or view rather than this route policy.

## Focus and remount continuity

The route-view key is derived from the direct child of the active account frame, so nested admin pages do not remount their parent workspace on every leaf change. Keyboard focus in stable header/sidebar chrome is preserved. When navigation begins inside outgoing content or programmatically, the committed route focuses `#account-main` with `preventScroll`; it must not fall back to `body`.

Reduced motion disables the optional identity transition without changing DOM order, frame selection, focus restoration or route identity. Motion policy does not change layout, typography, content loading, authorization or mobile Drawer behavior.

Frame selection is defined in [Account layout ownership](account-layout-ownership.md). Visual baseline movement remains governed only by [Layout visual governance](layout-visual-governance.md).
