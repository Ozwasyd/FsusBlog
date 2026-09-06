# Orchestrated observable UI

This workflow applies to every observable UI implementation and to formal independent acceptance. It does not apply to isolated editorial or tooling changes merely because they mention design. The [governance task boundary](../../../../docs/design/governance.md#task-routing), not diff size or model preference, determines applicability.

## Bind the task

Resolve the [baseline](baseline-resolution.md) and the applicable [design context](design-change.md). The shared DAG authority freezes classification, owner, surface profile, affected states, exact scope, both design Skills, current authorities, slice/routing policies, context, candidate, and active baseline. Root cannot rewrite frozen classification or route on cost, retry count, model self-report, or preference.

The [stage policy](../contracts/blog-ui-stage-policy.json) is the sole execution-profile and route registry. Consume it together with the [classification](../contracts/ui-classification-receipt.schema.json), [dispatch](../contracts/ui-dispatch-receipt.schema.json), [adjudication](../contracts/ui-system-adjudication-receipt.schema.json), and [acceptance](../contracts/ux-acceptance-receipt.schema.json) schemas. Do not copy their field inventories or model mappings into task prompts.

Each dispatch binds a verified work plan, executable slice, compiled prompt, route, checkpoint policy, candidate, exact worktree, Skills, and authorities. A slice has one coherent observable objective, concrete first action and writable target, necessary states/files/probes, explicit non-goals, and completion/continuation predicates. Do not split one behavior into non-runnable fragments or silently combine unrelated surfaces.

## Respect roles and complete the slice

The single UI/UX implementer writes only authorized implementation. Frozen tests, fixtures, snapshot baselines, thresholds, Skills, and authority documents remain outside that lease. The policy orders mutually exclusive test-owner, implementation, and documentation leases; behavior verification, adjudication, and UX acceptance remain fresh and read-only/read-execute. The documentation stage of this UI workflow starts only after matching behavior and UX acceptance. That dependency is not imposed on unrelated documentation tasks.

Choose the route from the policy using the frozen decision class and execution shape. Unsupported shapes require re-slicing; system disputes require adjudication. Failed tests, rejected UX, missing output, or a difficult task do not authorize model promotion or wider write permission.

Complete the slice within the rollout: make the required change, run frozen focused checks and render probes, diagnose failures, repair authorized implementation, and rerun. Emit machine-observed checkpoints at their thresholds and resume from `nextRequiredAction`; a prose plan is not a checkpoint. Partial checkpoints cannot become candidate-green, and slice self-tests cannot replace full frozen-stage coverage or independent acceptance.

Classify missing output as a non-executable slice/prompt, runtime invocation failure, sandbox/cwd/worktree mismatch, unexecuted first action, or verified profile capability mismatch. Recovery must change an observed slice, prompt, runtime, permission, or worktree fingerprint, or carry verified capability and breaker-reset authority. New wording, agent, attempt, ID, or model alone does not reset a failed attempt.

## Resolve and verify

System-design disputes stop implementation, not independent authorized work. A fresh read-only adjudicator resolves owner, authority, scope, or component-capability questions using the policy's route. It cannot edit, redesign, expand scope, or sign UX acceptance. A unique resolution causes reclassification and re-slicing without an unnecessary human approval step.

Only a verified shared human-decision request for an eligible authority conflict, multiple valid product directions, or irreversible public-contract tradeoff can enter the human gate. A proposed design-system change must be resolved by its owner through the applicable eligible reason; difficulty, responsiveness, ordinary accessibility blockers, failure, or uncertainty are not human-gate reasons. Deposit the decision into its authority, then reclassify, re-slice, route, implement, and verify a new candidate. Human input does not make an old candidate green.

After behavior green, use a fresh read-only verifier and the [rendered review](rendered-review.md) requirements. Acceptance binds the same candidate, classification, dispatch, work plan, slices, prompt, route, baseline and authorities, with distinct run identities and inspected evidence. Accepted receipts have no blockers; rejection cannot modify code or scope. Every acceptance-group member carries its own matching identities and fresh receipts.

For policy/schema maintenance or external scheduler integration, load [execution policy](execution-policy.md). Running the contract self-check demonstrates only the checker fixtures, not application behavior or independent UX acceptance.
