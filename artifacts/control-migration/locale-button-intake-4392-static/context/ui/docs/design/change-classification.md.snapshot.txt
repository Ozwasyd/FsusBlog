# Design Change Classification

> **Role:** Normative change-routing contract
> **Applies to:** FsusUI implementation and documentation changes, plus downstream applications that consume FsusUI
> **Authority:** Applies [`docs/design.md`](../design.md), [`docs/design/governance.md`](./governance.md), and [`spec/`](../../spec/README.md).

Classify every change before implementation. The result sets ownership, allowed sources, required documentation, and evidence; do not select a category because it simplifies the intended CSS or code.

## 1. Ownership classes

| Class | Owns | Does not own | Primary sources |
| --- | --- | --- | --- |
| Canonical specification | Token names/values, component states, platform-neutral semantics, accessibility, motion, registered platform differences | Vue selectors, XAML details, product workflows | `spec/` |
| FsusUI design contract | Visual intent, surface taxonomy, typography, density, material, component defaults | Consumer page composition | `docs/design.md`, `docs/design/` |
| Web/Vue implementation | Vue behavior, Element Plus compatibility, DOM and theme integration | Cross-platform truth, consumer business logic | `vue/`, `docs/components/`, `docs/theme/` |
| Avalonia implementation | XAML themes, .NET controls, Avalonia behavior | Web DOM assumptions | `dotnet/`, `docs/avalonia/` |
| Platform override | Necessary, bounded differences that cannot be eliminated | Convenience divergence, unregistered preference | `spec/platform-overrides/` |
| Consumer integration | Product routing, business copy, information architecture, page composition, product-specific public/marketing/reading rules | FsusUI internals, new `--fsus-*` truth | Consumer repository, `docs/consumers/` |
| Example or record | Usage demonstrations and evidence records | New normative behavior | Examples, Demo, `docs/releases/evidence/`, audit reports |

## 2. Surface classification

| Surface | Typical content | Default owner | Required caution |
| --- | --- | --- | --- |
| Task | Forms, settings, moderation, editing, administration | FsusUI components plus consumer composition | Use task density and a stable action hierarchy |
| Reading | Long-form text, articles, documentation | Consumer layout plus FsusUI typography primitives | Do not import admin-panel/card patterns |
| Public | Public navigation, listings, account entry, public shell | Shared primitives plus consumer layout rules | Define responsive navigation and content hierarchy in the consumer |
| Marketing | Hero, campaign, pricing, promotional CTA | Consumer | FsusUI does not supply a complete marketing language |
| Document | Page headers, results, statistics, summaries | FsusUI | Flat by default; do not manufacture a card |
| Control group | Toolbar, segmented control, grouped inputs | FsusUI | Enclose only a real interaction group |
| Data region | Table, calendar, transfer, structured comparison | FsusUI | A region may have a border; rows stay flat |
| Overlay | Dialog, drawer, popover, dropdown, tooltip | FsusUI | Use overlay contracts; do not turn page content into overlays |
| Navigation | Menu, tabs, public-shell navigation | Shared | Mobile mode must be explicit and semantically correct |
| Expressive | Explicit opt-in visual surface | Explicit owner and contract | Never classify ordinary content as expressive to gain styling |

## 3. Impact classes and required updates

| Change | Update or inspect | Minimum evidence |
| --- | --- | --- |
| Canonical token value or alias | `spec/tokens/tokens.json`, generated outputs, `docs/design.md` mapping, token docs, Web/Avalonia consumers | Token checks, conformance, affected visual evidence, migration/release impact |
| Component public behavior or state | Component source/docs, platform-neutral contract where applicable, focused tests | Unit/interaction/a11y tests and affected visual evidence |
| Component default visual output | `docs/design.md`, theme/component source, component docs, fixtures | Anti-AI/design checks and affected-state visual evidence |
| Motion behavior | Motion spec/docs, reduced-motion behavior, state-machine tests | Motion, SSR, reduced-motion, and affected visual evidence |
| Typography or foundation style | Canonical typography/foundation sources and affected surfaces | Full required visual plan and readable-content inspection |
| New or changed UX pattern | `spec/patterns/`, `docs/ux/`, implementation/example, semantic checker | Realistic task example plus interaction/accessibility evidence |
| Public/marketing/reading layout in a consumer | Consumer rules, components, fixtures | Consumer viewport/theme/content matrix; no FsusUI internal patch |
| FsusUI defect exposed by a consumer | Fix the owning FsusUI source and tests | FsusUI regression evidence plus consumer confirmation |
| Platform-only difference | Registered override with reason, owner, test policy, review condition | Platform conformance and comparison evidence |
| Documentation example only | Nearest guide/example and normative links | Syntax or example validation; no contract-change claim |

## 4. FsusUI versus consumer

A change belongs to FsusUI when it corrects or extends a reusable public component, token, interaction, accessibility behavior, or documented primitive for multiple consumers.

It belongs to the consumer when it concerns route composition, product content priority, business copy/workflow, public/marketing/editorial layout, selection among documented variants, or consumer-owned `--{consumer}-*` tokens mapped to public FsusUI tokens.

Do not add a consumer compatibility layer to mask an FsusUI defect. Do not generalize one consumer's page composition into FsusUI without evidence of a reusable primitive.

## 5. Ambiguity rule

When classification remains ambiguous:

1. Preserve current behavior.
2. Isolate the smallest change.
3. Document the uncertainty.
4. Do not introduce a new token, surface role, wrapper, or exception.
5. Seek evidence from an existing contract, component, fixture, or multiple consumers.

Ambiguity is not permission to redesign.
