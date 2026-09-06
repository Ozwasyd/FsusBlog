---
name: fsusblog-design-conformance
description: Use for FsusBlog visual or interaction changes, rendered UI reviews, and design-contract edits. Excludes backend-only and non-visual runtime work.
---

# FsusBlog Design Conformance

Use this Skill as a consumer adapter, not a second design system. Design truth belongs to the active FsusUI source and the relevant current FsusBlog documents.

This Skill owns Blog-specific design and UX facts:

- ownership classification and consumer workaround prohibitions;
- design-authority selection together with required `fsusui-design-conformance`;
- UI decision classification and verification classes;
- required rendered evidence and independent UX acceptance semantics;
- system-design adjudication semantics for Blog/FsusUI ownership disputes.

This Skill does **not** own shared orchestration authority. An external scheduler or orchestrator exclusively owns Root/controller behavior, permanent actor roster, stage-to-role mapping, model/profile/effort selection, route selection, runtime permission classes, leases/resources/capacity, shared stage ordering, checkpoint/continuation, retry/recovery, delivery, cleanup, and terminalization.

A scheduler may carry the digests and classifications defined here, but it must not reinterpret Blog or FsusUI design facts. Conversely, this Skill must not tell a scheduler which actor, model, profile, route, lease, retry path, or control-plane stage to use.

Machine-readable domain contracts live under `contracts/`. The historical filename `contracts/blog-ui-stage-policy.json` now contains only repository-domain and acceptance policy.

## Select the task context

[Design governance](../../../docs/design/governance.md#task-routing) defines the boundary between documentation, review, and observable UI work. Load only the matching reference; follow further links when their condition applies.

| Task | Read |
| --- | --- |
| Editorial correction or design-document change without an observable UI implementation | [Design change](references/design-change.md); resolve the baseline only for claims about FsusUI |
| Observable visual or interaction implementation, regardless of size | [Design change](references/design-change.md), then [orchestrated UI](references/orchestrated-ui.md) |
| Read-only inspection of rendered behavior | [Rendered review](references/rendered-review.md) |
| Skill, domain-policy, schema, or checker integration change | [Execution policy](references/execution-policy.md) |

For design-dependent implementation or review, use [baseline resolution](references/baseline-resolution.md). Reuse verified context while its identity is unchanged; refresh only the invalidated authorities when checkout, alias, pin, files, or task scope changes. Do not read every reference or the full document index on entry.

## Preserve the boundaries

- FsusUI owns reusable primitives, public tokens, and shared interaction semantics. FsusBlog owns product composition and documented product semantics. Resolve ownership through governance; do not mask upstream defects with private selectors, fake tokens, or compatibility wrappers.
- Preserve the requested scope and existing design direction. A small diff is not an exemption from applicable UI classification, implementation ownership isolation, or independent acceptance.
- Work within the current authorization through implementation, relevant checks, failure repair, and completion. A first implementation or prose checkpoint is not completion.
- Report the candidate and evidence actually inspected. Documentation checks, compatibility checks, and contract self-tests do not establish rendered conformance or formal UX acceptance.
- Do not select or require a model, profile, effort, or execution route from this Skill. Those decisions remain external.
