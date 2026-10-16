---
name: fsusui-design-conformance
description: Use for implementing, reviewing, or documenting visual, UX, theme, token, motion, icon, component, responsive-layout, or rendered-output changes in FsusUI itself or in a repository that imports, aliases, wraps, or embeds FsusUI. Do not use for generic UI work, backend-only changes, or products that do not consume FsusUI.
---

# FsusUI Design Conformance Workflow

Use this Skill only when the change belongs to FsusUI or a confirmed FsusUI consumer.

This Skill owns FsusUI-specific design and UX facts:

- ownership classification;
- design-authority selection;
- UI decision classification;
- required rendered evidence;
- consumer versus library responsibility;
- FsusUI-specific implementation boundaries;
- system-design adjudication semantics;
- UX acceptance semantics.

This Skill does **not** own shared orchestration authority. An external scheduler or orchestrator exclusively owns Root/controller behavior, permanent actor roster, stage-to-role mapping, model/profile/effort selection, route selection, runtime permission classes, leases/resources/capacity, shared stage ordering, checkpoint/continuation, retry/recovery, delivery, cleanup, and terminalization.

A scheduler may carry the digests and classifications defined here, but it must not reinterpret FsusUI design facts. Conversely, this Skill must not tell a scheduler which actor, model, profile, route, lease, retry path, or control-plane stage to use.

Machine-readable domain contracts live under `contracts/`. The historical filename `contracts/ui-stage-policy.json` now contains only repository-domain and acceptance policy. Validate the Skill and receipts with:

```bash
pnpm run check:fsusui-design-conformance
```

## 1. Confirm scope and baseline

Confirm one of these conditions before proceeding:

- the current repository is FsusUI;
- the current repository imports FsusUI through a package, workspace, alias, linked checkout, or embedded source;
- the task explicitly reviews a consumer against a known FsusUI baseline.

Otherwise, do not use this Skill.

For a consumer, locate the exact FsusUI package version, revision, alias target, or linked checkout. Do not assume the consumer's local copies of token values or design notes are authoritative.

Record the active FsusUI baseline identity and bind it to the exact Skill and authority digests used for the change.

## 2. Load the authoritative documents

Read, in order:

1. `docs/index.md`
2. `docs/design.md`
3. `docs/design/governance.md`
4. `docs/design/change-classification.md`
5. `docs/workflows/visual-change.md`
6. `docs/consumers/design-integration.md` when a consumer is involved
7. the nearest component, theme, UX, API, accessibility, motion, or platform contract

When working in a consumer repository, read these files from the linked FsusUI source or exact dependency baseline when available. Do not copy their values into the consumer or this Skill.

If this Skill conflicts with `spec/`, `docs/design.md`, or a public domain contract, the authoritative document wins. Correct the Skill or lower-authority document rather than reinterpret the design contract.

Loading must be observable. Bind the exact Skill digest, authority digests, baseline repository/revision, and dirty fingerprint to the classification evidence. Natural-language claims that a document was read are not evidence.

## 3. Freeze FsusUI-specific classification

Before changing observable UI/UX output, produce a valid:

`fsusui-design-conformance.ui-ux-classification-receipt.v2`

The receipt records:

- owner repository and affected surfaces;
- `uiDecisionClass`: `prescribed`, `bounded-composition`, `layout-judgment`, `interaction-judgment`, or `system-design-dispute`;
- `verificationClass`: `ux-local`, `ux-path`, or `ux-system`;
- required authorities and their digests;
- exact Skill digest;
- active FsusUI baseline identity;
- candidate SHA and candidate identity digest;
- state/evidence matrix;
- explicit in-scope and out-of-scope boundaries;
- classification evidence digest;
- `domainPolicyDigest`.

Do not choose a classification to obtain a desired visual effect. Do not classify an ordinary surface as expressive or glass, and do not move consumer composition into FsusUI.

The classification is a FsusUI domain fact. An external scheduler may consume it as input, but the receipt does not prescribe an actor, model, profile, route, work slice, lease, retry policy, or stage order.

## 4. Preserve repository ownership boundaries

The implementation must preserve the ownership boundaries defined by FsusUI contracts.

Unless the task explicitly changes the corresponding authority:

- implementation changes must not rewrite frozen tests, fixtures, snapshots, acceptance mappings, design authorities, or this Skill's contracts;
- acceptance and adjudication evidence must not modify implementation paths;
- a consumer must not patch private FsusUI selectors, invent fake `--fsus-*` tokens, or create a compatibility layer for a reusable FsusUI defect;
- a FsusUI change must not absorb consumer-specific route composition, product copy, or business workflow.

These are repository ownership constraints, not scheduler lease or permission rules. How an external orchestrator enforces them is outside this Skill.

## 5. Preserve design intent

Unless explicitly authorized by the authoritative documents and task:

- preserve information architecture, content order, and action priority;
- preserve the existing primary visual focus;
- do not add cards, surfaces, badges, icons, helper copy, illustrations, calls to action, motion, or decorative effects;
- do not redesign adjacent components;
- do not create new tokens, wrappers, variants, or exceptions;
- do not use generic SaaS patterns, framework defaults, trends, or model preference as design evidence.

Prefer the smallest coherent fix that restores the documented contract.

## 6. Handle system-design disputes as domain disputes

When the frozen classification is `system-design-dispute`, implementation must not proceed on an unresolved design-system assumption.

Produce a valid:

`fsusui-design-conformance.ui-system-adjudication-receipt.v2`

The adjudication receipt binds:

- the disputed classification receipt;
- owner repository;
- Skill and authority digests;
- active baseline identity;
- candidate identity;
- the exact problem classification;
- the design/ownership disposition;
- the allowed post-adjudication `uiDecisionClass`;
- in-scope and out-of-scope boundaries;
- any required consumer or library follow-up issue;
- `domainPolicyDigest`.

Adjudication determines design and ownership facts only. It must not select a model/profile, define an execution route, set a sandbox or permission class, acquire a lease, choose a retry path, or prescribe scheduler control flow.

An adjudication receipt cannot include implementation modifications.

## 7. Implement the smallest coherent FsusUI fix

Use the owning source and public contracts:

- reuse canonical tokens and documented primitives;
- preserve adjacent behavior that is not in scope;
- keep one coherent user-observable behavior complete across its required states;
- do not weaken tests, baselines, thresholds, or checkers to make a visual result pass;
- do not update snapshots or fixture expectations as a substitute for correcting the implementation;
- do not use a consumer workaround for an FsusUI defect.

If the work is too broad to reason about coherently, report the domain boundaries that need to be separated. The mechanics of slicing, dispatch, checkpoints, or continuation belong to the external orchestrator.

## 8. Inspect rendered evidence

Follow `docs/workflows/visual-change.md`.

Inspect the existing rendered state before changing observable output, then inspect the resulting production-fixture evidence across applicable dimensions:

- default and changed interaction states;
- light and dark themes;
- relevant desktop and mobile viewports;
- realistic short, long, empty, loading, error, and permission content;
- supported locales and text expansion;
- keyboard focus;
- touch;
- screen reader behavior;
- zoom and overflow;
- reduced motion;
- Web/Avalonia or consumer comparison when applicable.

A passing compile, unit test, static checker, or zero-diff screenshot command is not sufficient for an untested state.

## 9. Verify UX independently

UX acceptance is a FsusUI domain decision, not a routing decision.

Produce a valid:

`fsusui-design-conformance.ux-acceptance-receipt.v2`

The receipt binds:

- the frozen classification receipt;
- candidate SHA and candidate identity digest;
- `verificationClass`;
- Skill and authority digests;
- active baseline identity;
- `domainPolicyDigest`;
- evidence that acceptance is independent from implementation;
- production-fixture state/viewport/theme/input coverage;
- inspected rendered artifacts;
- blockers;
- final `accepted` or `rejected` status.

An accepted receipt has no blockers. A rejected receipt has at least one blocker. Acceptance evidence must not modify implementation paths.

The receipt deliberately does not define an actor name, model, profile, effort, route, sandbox, work plan, prompt, checkpoint, retry, or scheduler state. External orchestration may bind additional execution metadata in its own contracts without changing this receipt.

Do not claim visual acceptance without inspected rendered evidence.

## 10. Respect FsusUI and consumer ownership

When the public FsusUI primitive is defective, fix FsusUI and its tests. Do not add a compatibility layer, private selector override, fake `--fsus-*` token, or local component fork in the consumer.

When the issue is route composition, product copy, business workflow, public/marketing/editorial layout, or selection among valid variants, keep the change in the consumer. Do not change FsusUI defaults for one consumer.

Each affected repository or consumer surface must establish its own baseline, ownership classification, candidate identity, and acceptance evidence. Do not inherit those facts from another member.

## 11. Shared orchestration authority firewall

The following shared orchestration categories are explicitly outside this Skill:

```text
root/controller
permanent actor roster
stage-to-role mapping
model/profile/effort
route selection
runtime execution/permission class
lease/resource/capacity
shared stage order
checkpoint/continuation
retry/recovery/failure routing
delivery/cleanup/terminalization
```

If an external scheduler is present, it may map `uiDecisionClass` and `verificationClass` to its own execution machinery. That mapping belongs exclusively to the scheduler.

Do not add fields such as role profiles, route maps, model names, effort levels, sandbox selection, lease order, retry bases, or scheduler stage order to FsusUI machine contracts.

## 12. Completion report

Report:

1. FsusUI baseline and ownership classification;
2. authoritative documents and sections applied;
3. files changed and contracts affected;
4. validation commands and exact results;
5. rendered states and evidence inspected;
6. remaining uncertainty;
7. confirmation that the change did not create a parallel design system, consumer compatibility layer, or undocumented exception;
8. confirmation that FsusUI domain receipts did not claim shared orchestration authority.

Do not claim visual acceptance without inspected rendered evidence.
