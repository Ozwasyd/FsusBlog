# Design changes and documentation

Classify the task against [`docs/fsusui.md`](../../../../docs/fsusui.md) and [`../FsusUI/docs/design.md`](../../../../../FsusUI/docs/design.md) before loading implementation machinery.

For an editorial correction, read the changed paragraph and its relevant authority; preserve meaning and run the affected checks. Do not resolve an upstream checkout or start browser acceptance merely to fix a spelling mistake. For semantic design-contract changes, establish the responsible owner and synchronize applicable contracts and checks. A documentation-only result does not prove that its intended rendered behavior has been implemented.

Observable UI implementation always follows [orchestrated UI](orchestrated-ui.md), including a one-line CSS or copy change. Before changing observable output, resolve the [active baseline](baseline-resolution.md), consult [`../FsusUI/docs/design.md`](../../../../../FsusUI/docs/design.md) ("The Intellectual Minimalist"), and check the nearest current document under `docs/product/` and [`docs/web-validation.md`](../../../../docs/web-validation.md).

Classify the affected owner, hierarchy, components, states, themes, locales, viewports, focus, overflow, reduced-motion behavior, contract change, and exact in/out scope. Product composition belongs to FsusBlog; reusable control geometry, public tokens, and shared interaction/accessibility behavior belong to FsusUI.

Examples help locate ownership, not prescribe a redesign:

| Change | Authority boundary |
| --- | --- |
| Article image or code-block entrance | Reading surface; decorative scroll reveal remains disallowed |
| Dialog internal padding or radius | FsusUI component geometry, not a consumer override |
| Login composition | FsusBlog focused-auth composition, with FsusUI controls |
| Home layout | Public-editorial composition (`PublicListing.vue`), not an admin card grid |
| Reusable color, radius, or motion value | FsusUI; product-semantic tokens must have a distinct Blog meaning |

Preserve the information architecture, content order, action priority, primary focus, component semantics, and accessibility unless the request changes them. Do not decorate or introduce a parallel design system. For acceptance, load [rendered review](rendered-review.md); select the affected evidence rather than an unrelated full matrix, while retaining all mandatory coverage for the classified task.
