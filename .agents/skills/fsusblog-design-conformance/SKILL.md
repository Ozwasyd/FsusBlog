---
name: fsusblog-design-conformance
description: Use for FsusBlog visual or interaction changes, rendered UI reviews, and design-contract edits. Excludes backend-only and non-visual runtime work.
---

# FsusBlog Design Conformance

Use this Skill as a consumer adapter, not a second design system. Design truth belongs to the active FsusUI source and the relevant current FsusBlog documents.

## Select the task context

[Design governance](../../../docs/design/governance.md#task-routing) defines the boundary between documentation, review, and observable UI work. Load only the matching reference; follow further links when their condition applies.

| Task | Read |
| --- | --- |
| Editorial correction or design-document change without an observable UI implementation | [Design change](references/design-change.md); resolve the baseline only for claims about FsusUI |
| Observable visual or interaction implementation, regardless of size | [Design change](references/design-change.md), then [orchestrated UI](references/orchestrated-ui.md) |
| Read-only inspection of rendered behavior | [Rendered review](references/rendered-review.md) |
| Skill, routing policy, schema, or scheduler integration change | [Execution policy](references/execution-policy.md) |

For design-dependent implementation or review, use [baseline resolution](references/baseline-resolution.md). Reuse verified context while its identity is unchanged; refresh only the invalidated authorities when checkout, alias, pin, files, or task scope changes. Do not read every reference or the full document index on entry.

## Preserve the boundaries

- FsusUI owns reusable primitives, public tokens, and shared interaction semantics. FsusBlog owns product composition and documented product semantics. Resolve ownership through governance; do not mask upstream defects with private selectors, fake tokens, or compatibility wrappers.
- Preserve the requested scope and existing design direction. A small diff is not an exemption from applicable UI classification, writer isolation, or independent acceptance.
- Work within the current authorization through implementation, relevant checks, failure repair, and completion. A first implementation or prose checkpoint is not completion.
- Report the candidate and evidence actually inspected. Documentation checks, compatibility checks, and contract self-tests do not establish rendered conformance or formal UX acceptance.
