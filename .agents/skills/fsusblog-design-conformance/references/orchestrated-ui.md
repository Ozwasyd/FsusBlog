# Observable UI domain workflow

This workflow applies to every observable UI implementation and to formal independent acceptance. It does not apply to isolated editorial or tooling changes merely because they mention design. The [governance task boundary](../../../../docs/design/governance.md#task-routing), not diff size or model preference, determines applicability.

## Bind the domain facts

Resolve the [baseline](baseline-resolution.md) and the applicable [design context](design-change.md). Freeze classification, owner, surface profile, affected states, exact scope, both design Skills, current authorities, candidate, and active baseline. Domain classification is not rewritten to obtain a preferred visual effect, cheaper route, or preferred model.

The [stage policy](../contracts/blog-ui-stage-policy.json) is repository-domain and acceptance policy only. Consume it together with the [classification](../contracts/ui-classification-receipt.schema.json), [adjudication](../contracts/ui-system-adjudication-receipt.schema.json), and [acceptance](../contracts/ux-acceptance-receipt.schema.json) schemas. Do not copy their field inventories into task prompts, and do not treat this Skill as a model/profile/effort or route registry.

Shared orchestration remains external. Actor roster, model/profile/effort selection, route selection, leases, stage order, checkpoints, retries, delivery, and terminalization belong to the external scheduler. A scheduler may carry the digests defined here; it must not reinterpret Blog or FsusUI design facts.

## Preserve ownership and complete acceptance

Implementation may change only authorized implementation paths. Frozen tests, fixtures, snapshot baselines, thresholds, Skills, and authority documents remain outside implementation ownership. Acceptance and adjudication evidence must not modify implementation paths.

System-design disputes stop implementation on an unresolved design-system assumption. A fresh adjudication determines owner, authority, scope, or component-capability disposition only. It cannot edit implementation, expand product scope, select a model/profile, define an execution route, or sign UX acceptance.

After behavior green, use independent verification and the [rendered review](rendered-review.md) requirements. Acceptance binds the same candidate, classification, Skills, authorities, baseline, and domain policy, with inspected production-fixture evidence. Accepted receipts have no blockers; rejection cannot modify code or scope.

For domain-policy or schema maintenance, load [execution policy](execution-policy.md). Running the contract self-check demonstrates only the checker fixtures, not application behavior or independent UX acceptance.
