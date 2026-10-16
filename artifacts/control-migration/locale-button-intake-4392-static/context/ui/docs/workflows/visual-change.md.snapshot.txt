# Visual Change Workflow

> **Role:** Normative implementation and review workflow
> **Applies to:** FsusUI component, theme, motion, layout, and consumer visual changes
> **Authority:** Executes `spec/`, `docs/design.md`, domain contracts, and consumer rules; it cannot redefine them or claim shared orchestration authority.

Use this workflow when rendered output, interaction states, geometry, theme,
motion, icons, responsive layout, documentation examples, or consumer
composition changes.

## 1. Baseline and owning contracts

Record the repository/revision, affected component or route, fixture, platform,
and existing evidence. For a consumer, record the exact FsusUI revision,
package version, alias, or linked checkout; do not evaluate one revision and
implement against another.

Read the minimum relevant sources, always including:

1. [`docs/design.md`](../design.md)
2. [`docs/design/governance.md`](../design/governance.md)
3. [`docs/design/change-classification.md`](../design/change-classification.md)
4. the nearest token, component, UX, API, or platform contract
5. [`docs/consumers/design-integration.md`](../consumers/design-integration.md) for downstream work

Do not replace a contract with a Skill summary, issue text, screenshot, or model
preference.

## 2. Classify before editing

Produce a machine-validated
`fsusui-design-conformance.ui-ux-classification-receipt.v2` containing:

- owner repository and affected surface;
- affected public behavior and visual states;
- explicit in- and out-of-scope areas;
- whether design intent changes or conformance is restored;
- `uiDecisionClass`: `prescribed`, `bounded-composition`, `layout-judgment`,
  `interaction-judgment`, or `system-design-dispute`;
- `verificationClass`: `ux-local`, `ux-path`, or `ux-system`;
- exact Skill, design-authority, active-baseline, candidate, and
  classification-evidence digests; and
- `domainPolicyDigest`.

This is a repository/domain fact. It does not select an actor, model, profile,
route, lease, retry path, checkpoint policy, or scheduler stage. If a new token,
reclassification, or design-intent change is needed, use the design-contract
change process rather than treating it as a local style fix.

## 3. Inspect and preserve ownership

Inspect the current rendered state with realistic content before editing. Check
the actual failure—hierarchy, composition, component defect, token drift,
interaction, accessibility, platform variance, or consumer override—rather
than inferring it from source alone.

Implementation must leave frozen tests, fixtures, snapshots, acceptance
mappings, design authorities, and the Skill unchanged. Change only the owning
source, reuse public primitives and canonical tokens, preserve adjacent
information architecture, and keep every state for one observable behavior
coherent. Do not add a consumer compatibility layer for an FsusUI defect,
weaken a checker/threshold, or update a snapshot instead of fixing code.

## 4. Resolve system-design disputes

For `system-design-dispute`, stop implementation until a valid
`fsusui-design-conformance.ui-system-adjudication-receipt.v2` is produced. It
must bind the classification receipt, owner repository, Skill and authority
digests, active baseline, candidate, problem and disposition, allowed
post-adjudication `uiDecisionClass`, scope boundaries, required follow-up, and
`domainPolicyDigest`.

The adjudication determines design/ownership facts only. It cannot include
implementation changes or choose model/profile/effort, runtime permissions,
execution route, leases, retries, or scheduler order.

## 5. Verify by impact

Start with repository-local commands:

```bash
pnpm run check:design-source-drift
pnpm run check:anti-ai-visual
pnpm run tokens:check
pnpm run tokens:lint
pnpm run verify:visual:affected
```

Add focused type, unit, interaction, accessibility, motion, platform, package,
or consumer checks according to the change classification. Use the consumer’s
own screenshot matrix while preserving FsusUI baseline and public contracts.
These commands are acceptance facts; they do not prescribe an actor or model.

Inspect, rather than merely generate, the affected evidence across required
states, themes, viewports, locales, content lengths, keyboard/touch/screen
reader behavior, zoom/overflow, reduced motion, and Web/Avalonia or consumer
comparisons. A zero visual diff proves only covered baselines; it does not prove
an untested state.

## 6. Independent UX acceptance

Produce a valid `fsusui-design-conformance.ux-acceptance-receipt.v2` bound to
the classification, candidate, `verificationClass`, Skill/authority digests,
active baseline, `domainPolicyDigest`, independence evidence,
viewport/state/theme/input matrix, inspected production artifacts, blockers,
and acceptance status. Accepted receipts have no blockers; rejected receipts
have at least one.

The UX receipt contains no actor, model/profile/effort, route, sandbox, plan,
prompt, checkpoint, retry, or scheduler state. Do not claim visual acceptance
without inspected rendered evidence.

## 7. Review and orchestration boundary

Reject or revise changes that create parallel design rules/unregistered values,
add focal points, decorative surfaces, unsupported copy or motion, consumer
overrides, product composition in FsusUI, misclassified surfaces, weakened
checks, or placeholder-only evidence.

FsusUI owns design, product, component, consumer, and acceptance semantics. A
shared scheduler/orchestrator exclusively owns:

```text
root/controller behavior
permanent actor roster and stage-role mapping
model/profile/effort selection
route selection
runtime execution and permission classes
lease/resource/capacity
shared stage order
checkpoint/continuation
retry/recovery/failure routing
delivery/cleanup/terminalization
```

Do not add those decisions to this workflow, the Skill, or FsusUI machine
contracts.

## 8. Completion evidence

Report the baseline and classification; changed files and design sections;
affected public contracts, tokens, states, and consumers; exact commands and
results; inspected viewports/themes/locales/states/platforms; artifacts and
failure evidence; remaining uncertainty; and confirmation that no parallel
design system, compatibility layer, or shared orchestration authority was
introduced.
