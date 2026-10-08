# Frontend atomic source integration

These modules supply source material and single-command executors for the existing
matrix/compiler owners. They do not register topology, admit attempts, verify
runtime receipts, or issue replay plans. Every projection explicitly returns
`qualificationEligible: false`. The authoritative topology remains
`tests/matrix.yml`; no projection is persisted as a second catalog.

## Manifest entries

`projectFrontendManifestGroups(matrix)` derives the frontend group set from
canonical `commandGroups`. `projectFrontendManifestGroup(matrix, groupId)` binds
the exact parent and complete manifest entries through the existing canonical
digest API. Commands, input/output declarations, explicit dependency arrays,
resources, applicability and nested declarations retain their source values.
No edge is inferred from command order or overlapping outputs. Missing input or
resource declarations remain explicit gaps; inherited group weights are not
presented as independently proven entry contracts.

`executeFrontendManifestEntry({root, groupId, entryId, expectedSourceDigest,
env, signal})` reloads the matrix, validates the entire group, checks its digest
and executes exactly one entry using the existing `executeManifestEntry` process
owner. It does not call the group scheduler, write group success, retry, or execute
siblings. The canonical compiler must establish dependencies, resource grants,
applicability, sealed environment, attempt and replay admission before calling it.
The executor does not substitute for those checks. Its CLI requires all three
selectors and accepts no group-only execution or source override.

The current `views-constraints` entry contains `localCommands`, while its package
wrapper performs multiple commands. The executor rejects that entry pending the
canonical composite disposition. It does not simultaneously execute the wrapper
and its children or silently remove either canonical declaration. Other package
wrapper dispositions also remain subject to that upstream inventory.

## Property, state machines and perf

`projectFrontendPropertyModelPerf(matrix, packageDocument)` exposes the fixed
three producer IDs and command-source bindings. The new executable lanes reuse
`EnsureFrontendFsusUiBaseline`, `RunTier`, `RunVitestScriptUnsharded` and
`RunInClientMeasurement` directly. They contain one command each and do not write
an unconditional group summary. They preserve package scripts, config selection,
worker policy, seed ownership, measurement window and noise authority.

The property package script currently binds its random-stream producer to
`frontend-property-model-perf`. That source remains unchanged: the random/replay
owner must supply the exact child binding before cutover. The perf source
projection requests the existing `benchmark-window` and `exclusiveCapacity`,
which the weighted DAG already honors. This isolates measurement from all
executable siblings without turning property/state failures into perf blockers.
The declaration/compiler owner must retain that isolation in its actual plan.

## Visual

`projectFrontendVisual(matrix)` preserves the existing public/console declarations
verbatim, including fixtures, commands, evidence classes, baseline/spec paths,
artifacts and applicability. It exposes settled summary dependencies while
retaining the original aggregate declaration separately. It does not create a
second Playwright install, build, runtime or fixture owner.

`compareVisualSharedIdentityMaterial(publicIdentity, consoleIdentity)` reports
field differences in run/source/candidate/build/FsusUI/browser-plan/service
generation material. Equality is only a comparison, never independent
verification or runtime admission. Public and console endpoint URLs may differ.
Public must not depend on console session/reset preparation; shared corruption
must block dependent consumers through the existing scheduler.

## Required integration by existing owners

The published framework at `ebf0d6e0e555ba8bf64ceb4dbc9de6427cc1699c`, including
behavior correction `653ef38e2ce6dbcf8e2671bd8e091eb9c04538a0`, now supplies the
canonical declaration/compiler/attempt execution API. The followup consumer
`prepareFrontendManifestAdmission(compiled, options)` independently matches the
matrix's manifest entry set, unchanged command argv, explicit hard/settled edges,
every declared resource field and command environment against that compiled graph.
It consumes the existing independent authority reference and replay validators
for current-run/source/environment binding. It creates no topology, retry policy,
test selection, seed, resource grant or authority receipt.

`executeFrontendManifestAtomicGroup(compiled, options)` calls that preparation
then dispatches once through `executeCompiledAtomicProducerDag`. The canonical
runner owns each attempt and evidence root; the canonical execution error/vector
is returned unchanged, including blocked children and complete settled outcomes.
Its options are the original framework execution options plus `groupId`; the graph
must contain only that logical parent. No raw group loop or separate attempt runner
is used. These checks supplement reference validation; they do not independently
prove transitive input custody, physical enforcement or runtime qualification.

The current seven runtime entries still lack explicit entry resources/inputs and
cannot be admitted by this bridge. Composite `localCommands` remain refused.
An explicit applicability field requires the compiler owner to supply its policy
admission; it is not discarded or converted to success. The framework currently
admits correctness static/build/runtime execution classes: the perf benchmark
and existing diagnostic visual declarations cannot be relabeled to fit that schema.
Their respective replay/measurement and fixture/browser proof boundaries remain
open. The separately published scheduler terminal/CAS/journal capabilities at
`2eda290cc6098971b685b3fb1465d7193bd3dde2` were inspected; this command preparation
bridge does not seal scheduler terminal authority or adopt that broad source tree.

All three issues remain open until the following consumers are integrated and
tested on the exact combined candidate:

- The declaration/inventory owner supplies exact-one atomic disposition, physical
  ownership, input closure, per-entry resources and evidence/replay contracts.
- The atomic compiler owner calls the existing attempt runner exactly once per
  admitted producer with zero retries, supplies child-bound terminal receipts and
  uses the existing weighted DAG. No scheduler is implemented here.
- The matrix/local/CI owners consume the same canonical projection and compiled
  identity; local fixture tests are not evidence of their current integration.
- The shared suite owner replaces `RunFrontendPropertyModelPerfGroupBody`,
  manifest group fan-out and `RunVisualOnly` only after those admission contracts
  exist. Those actively shared files are untouched in this increment.
- The visual fixture/admission owners supply verified lifecycle/reset receipts,
  shared candidate/browser/service-generation binding and exact-once preparation.
  The visual matrix owner changes hard aggregate dependencies into settled edges.
- The summary consumers use `buildSettledPhaseJoinEvidence` and
  `validateSettledPhaseJoinConsistency` from the existing bundle owner, with all
  child terminal states and independently bound evidence. Existing visual evidence
  verification and skip/diagnostic policy must additionally remain in force.

The focused tests execute real controlled manifest commands through the existing
process/DAG owners and exercise the existing settled join validator. Property
and visual scheduling probes are isolated controls, not actual Vitest measurement
or browser receipts. Product/runtime, independent review, full matrix, producer
registration and issue acceptance are not qualified by these tests. No package
publication, deployment, history promotion or self-merge is part of this increment.
