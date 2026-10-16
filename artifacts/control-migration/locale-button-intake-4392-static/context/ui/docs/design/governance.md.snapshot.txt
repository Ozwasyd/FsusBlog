# Design Governance

> **Role:** Normative design governance
> **Applies to:** FsusUI core, Web/Vue and Avalonia implementations, documentation examples, and FsusUI-consuming applications
> **Authority:** Interprets [`docs/design.md`](../design.md) and [`spec/`](../../spec/README.md); it cannot change their visual intent or canonical values.

This document governs how design rules are interpreted, changed, and applied. It prevents implementation convenience, model defaults, consumer preferences, or isolated screenshots from becoming a second FsusUI design language.

## 1. Normative language

| Term | Meaning |
| --- | --- |
| **MUST / 必须** | Required for conformance. |
| **MUST NOT / 不得** | Prohibited; aliases, wrappers, selector exceptions, and consumer patches cannot bypass it. |
| **SHOULD / 应** | Default; a deviation needs a specific, reviewable reason and evidence. |
| **SHOULD NOT / 不应** | Avoid unless a documented constraint makes the alternative materially worse. |
| **MAY / 可以** | Permitted only while higher-priority rules remain satisfied. |

Examples explain a rule; they do not authorize the same styling on another component or surface.

## 2. Rule precedence

Resolve conflicts in this order:

1. Security and accessibility requirements.
2. The platform-neutral specification and canonical token source.
3. Explicit prohibitions in `docs/design.md`.
4. Component- or surface-specific design rules.
5. General design principles in `docs/design.md`.
6. Public API and compatibility contracts.
7. Existing approved implementation and visual baselines.
8. Workflows, examples, framework defaults, common UI patterns, or implementer preference.

A lower-priority source cannot override a higher-priority source. “More modern”, “more polished”, SaaS similarity, framework defaults, and model preference are not valid override reasons.

## 3. Preservation default

Unless a task explicitly authorizes change, preserve:

- information architecture and content order;
- the number and priority of actions;
- the primary visual focus;
- component semantics and ownership;
- existing public behavior and accessibility;
- the distinction between task, reading, public, and marketing surfaces.

Do not add helper copy, badges, icons, cards, decorative surfaces, calls to action, illustrations, motion, or new states to make a result look complete. When evidence is incomplete, choose the smallest coherent change over speculative redesign.

## 4. Classify before implementing

Before selecting a component, token, layout pattern, or visual treatment, classify the change in [`change-classification.md`](./change-classification.md) by:

- **owner:** FsusUI specification, FsusUI implementation, platform override, or consumer;
- **surface:** task, reading, public, marketing, overlay, data-region, control-group, navigation, or expressive;
- **contract type:** token, component, interaction, accessibility, content, layout, example, or workflow;
- **impact:** local, shared component, global theme, cross-platform, or consumer-only.

The desired CSS effect must not determine the classification. A panel is not `expressive` merely to obtain a larger radius, and a consumer composition problem cannot be moved into FsusUI merely to avoid changing consumer code.

## 5. Single-source rule

- Canonical values belong in `spec/` and generated outputs.
- Human-readable visual intent belongs in `docs/design.md`.
- Domain-specific public behavior belongs in the nearest API, theme, UX, component, or platform contract.
- Workflows and Skills may reference these rules, but must not repeat their values.
- Consumer-specific composition, routing, copy, and product workflow remain in the consumer repository.

If a new document repeats a normative rule, replace the repetition with a link and domain-specific application notes.

## 6. Exceptions

An exception is valid only when the existing contract provides an explicit mechanism, such as a registered platform override, opt-in material, or expressive surface. Every new exception **MUST** record its semantic reason, exact scope, owner, affected platforms and states, test and visual-evidence policy, consumer impact, review/removal condition, and `reviewAfter` when its registry supports it.

The following are not acceptable reasons: aesthetic preference without a product requirement; similarity to a popular product or template; “AI generated” completeness; framework or component-library defaults; avoiding a proper FsusUI or consumer fix; or making one screenshot pass. Do not weaken an existing checker, baseline, or contract to admit an undocumented exception.

## 7. Changing the design contract

A change to FsusUI visual intent requires all applicable steps:

1. State the design problem and affected surfaces.
2. Identify the current rule and why it is insufficient.
3. Confirm that the change belongs to FsusUI rather than one consumer.
4. Update or add the canonical token/contract first when values or semantics change.
5. Update `docs/design.md` and the nearest domain contract.
6. Update Web and Avalonia mappings or register an explicit platform difference.
7. Add interaction, accessibility, visual, migration, and consumer evidence as applicable.
8. Record public API or release impact.

A local stylesheet change must not silently establish a new design rule.

## 8. Conformance versus visual acceptance

Passing static checks proves only the encoded rules. It does not by itself prove information hierarchy, focal-point count, optical alignment, density or whitespace rhythm, realistic long/short/empty/loading/error content, or a newly introduced state without a fixture. Visual acceptance requires inspected rendered evidence for affected states and viewports; zero-diff results, static checkers, and generated reports are not acceptance for an untested state. See [`docs/workflows/visual-change.md`](../workflows/visual-change.md).

## 9. Consumer interpretation

Consumers inherit FsusUI public component and token contracts, not every task-surface page composition. Public, marketing, editorial, and product-specific layouts must define their own rules without overriding FsusUI internals. See [`docs/consumers/design-integration.md`](../consumers/design-integration.md).
