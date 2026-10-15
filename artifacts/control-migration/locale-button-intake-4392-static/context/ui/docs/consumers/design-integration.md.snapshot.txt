# Consumer Design Integration

> **Role:** Normative consumer-boundary contract
> **Applies to:** Applications and libraries that import, alias, wrap, or embed FsusUI
> **Authority:** Applies FsusUI public contracts to consumers; it does not define product business logic, replace consumer layout rules, or claim shared orchestration authority.

A consumer inherits documented components, tokens, interaction semantics,
accessibility behavior, and variants. It does not inherit a complete route-level
design for public, marketing, reading, or business workflows.

## 1. Ownership boundary

| FsusUI owns | Consumer owns |
| --- | --- |
| Public component API and geometry | Routes, information architecture, workflows, and copy |
| Canonical theme/motion tokens | Page composition, content priority, and product layouts |
| `--fsus-viewport-block-size` and `--fsus-safe-area-inset-{top,right,bottom,left}` | Document viewport meta, including `viewport-fit=cover` when needed |
| Component states, keyboard behavior, and accessibility | Selection of documented variants and `--{consumer-name}-*` tokens |
| Task defaults and navigation/overlay/form/data/feedback primitives | Consumer fixtures and end-to-end evidence |
| Web/Avalonia conformance and registered platform differences | |

FsusUI does not rewrite `<meta name="viewport">` at runtime. Consumers must not
redeclare safe-area aliases, invent parallel `--fsus-safe-*` tokens, override
private selectors (`:deep(.el-overlay)`, `.el-overlay-dialog`,
`.el-overlay-message-box`, Drawer direction classes, or ImageViewer controls),
or ship a second viewport algorithm.

## 2. Adoption sequence

For a consumer visual or UX change:

1. Record the imported/aliased FsusUI version or revision.
2. Read [`docs/design.md`](../design.md), the relevant component contracts, and
   the consumer’s layout rules.
3. Classify the surface and owner with [`docs/design/change-classification.md`](../design/change-classification.md).
4. Use public components, props, slots, tokens, and documented composition.
5. Keep product layout and copy in the consumer.
6. Test realistic states, viewports, themes, locales, and content lengths.
7. If a reusable FsusUI defect is exposed, fix and verify FsusUI against that
   same revision before accepting the consumer.

## 3. Prohibited integration patterns

A consumer MUST NOT target undocumented DOM, private CSS selectors, generated
paths, XAML template parts, or internal imports; fabricate or redefine FsusUI
tokens; use `:deep()` to repair geometry; hide a defect in a compatibility
wrapper; fork a component because its documented default is inconvenient; or
modify FsusUI defaults for one route. It must not copy `docs/design.md`, infer
marketing/editorial layouts from task defaults, or mislabel a surface as
expressive/glass for an effect.

A product wrapper is allowed only when it adds product semantics or composition
without replacing the FsusUI primitive or bypassing its public contract.

## 4. Consumer tokens and surfaces

Use a consumer namespace and map it to public tokens:

```css
:root {
  --fsusblog-content-max-width: 72rem;
  --fsusblog-reading-gap: 2rem;
}

.fsusblog-shell {
  color: var(--fsus-ink);
  background: var(--fsus-page);
  border-color: var(--el-border-color-lighter);
}
```

Do not fabricate FsusUI truth such as `--fsus-card-premium-radius`.

| Surface | Consumer responsibility |
| --- | --- |
| Task | Use FsusUI task primitives, density, hierarchy, forms, data regions, and overlays; keep composition quiet and task-oriented. |
| Public/reading | Define page hierarchy, content width, responsive navigation, reading rhythm, media treatment, and route composition; do not import admin density into public content. |
| Marketing | Own hero, campaign, offer, CTA, and promotion; FsusUI prohibitions and component contracts still apply to used primitives. |

## 5. Defect routing

Fix the FsusUI source, tests, docs, and platform mappings when a public primitive
is wrong across valid consumers or violates its contract. Fix the consumer when
usage, hierarchy, or composition is product-specific. Do not repair both sides
with a compatibility layer; keep one owning implementation and one verified
integration.

## 6. Skill and orchestration boundary

The canonical `fsusui-design-conformance` Skill is under `.agents/skills/` in
this repository. A consumer may expose that exact revision or a pinned copy,
but must record the FsusUI revision and must not fork the domain contract or
embed copied design values. The Skill is optional assistance; specs, design,
and public contracts remain authoritative.

The Skill supplies ownership classification, `uiDecisionClass`,
`verificationClass`, design authority, rendered-evidence requirements, and UX
acceptance semantics. It does not define a Root/controller, actor roster,
model/profile/effort, route, runtime permission, lease/resource/capacity,
stage order, checkpoint, retry/recovery, delivery, cleanup, or terminalization.
Those belong to an external scheduler. Scheduler mappings and execution
metadata must not become FsusUI design truth or replace missing authority.

## 7. Consumer evidence

Acceptance should cover the route’s relevant states: realistic short/long
content; empty, loading, error, success, disabled, and permission states;
supported locales and expansion; light/dark themes; narrow/wide viewports;
keyboard order, focus, zoom, overflow, screen reader, and touch behavior; and
the exact FsusUI baseline. A passing FsusUI fixture does not prove consumer
composition, and a consumer screenshot does not authorize changing FsusUI
defaults.
