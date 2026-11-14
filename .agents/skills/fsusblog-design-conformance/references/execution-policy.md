# Domain-policy maintenance and external integration

This reference is for Skill, domain-policy, schema, or checker changes. It is not an extra reading requirement for each implementation edit. Follow the repository [change contract](../../../../docs/development/change-contract.md); do not turn a tooling-only task into a rendered acceptance claim.

## Domain authority only

[`blog-ui-stage-policy.json`](../contracts/blog-ui-stage-policy.json) owns repository-domain and acceptance facts for Blog UI work: decision classes, verification classes, implementation ownership, acceptance requirements, forbidden consumer workarounds, required Skill IDs, and the digests that classification or acceptance receipts must bind.

Shared orchestration authority is external. This Skill and its policy must not select a Root/controller, permanent actor roster, model/profile/effort, execution route, runtime permission class, lease/resource/capacity policy, shared stage order, checkpoint/continuation behavior, retry/recovery policy, delivery, cleanup, or terminalization. Those decisions belong to the external scheduler.

A scheduler may map Blog domain classifications into its own execution machinery, but that mapping is not part of this Skill or its receipts. Missing Blog or FsusUI design authority cannot be replaced by a copied summary, and scheduler execution metadata cannot be promoted into Blog design truth.

## Versioned migration

Stage policy, classification, adjudication, and UX acceptance use v2 domain receipts. Each Blog receipt requires the deployed `domainPolicyDigest` of the exact policy file bytes. The FsusUI-owned baseline identity retains its existing version. Old Blog receipts that claim model/profile/effort equality, route tables, or dispatch ownership against this repository are rejected, not relabeled or silently re-signed.

An external scheduler may continue to record actor, model, profile, route, lease, checkpoint, or retry metadata in its own contracts. It must not require this repository Skill to own or freeze those fields.

Skill closure includes `SKILL.md`, applicable references, and its deployed contracts/scripts; a root-file-only hash cannot make changed guidance appear unchanged. Current task receipts must be invalidated when their consumed closure changes.

## Migration and rollback validation limits

Deploy a domain-policy migration as one closure: the policy bytes, four v2 receipt schemas, the checker, and the consumed Skill references must move together. The `domainPolicyDigest` binds each receipt to the exact deployed policy bytes. A rollback restores the complete previous closure and its exact policy digest; v2 receipts from the newer closure are not relabeled or re-signed, and the external scheduler must reissue any evidence it still needs under the restored digest.

The `ui-orchestration.mjs` CLI is intentionally bounded. It reads exactly four schema files, checks their `additionalProperties` and required `schema` declarations, checks the external-orchestration policy boundary, validates one in-memory contract fixture, and executes the 18 permanent negative controls. It accepts no receipt-file argument. The exported `validateBlogUiBundle` additionally checks the exact receipt shapes, policy and baseline identities, candidate bindings, independent acceptance, and absence of scheduler-owned fields. These checks do not validate or execute an external scheduler, qualify a provider/model/route/runtime, inspect a real FsusUI checkout, or certify rendered artifacts or remote CI.

Receipt validation consumes the existing `validateJsonSchema(document, schema)` API in `tools/test-matrix/schema-validator/validate.mjs` and its locked Ajv2020 dependency. It enforces the deployed schemas recursively, including required observation fields, nested closed objects, input modes, artifact kinds, and array uniqueness; a fresh receipt digest cannot admit malformed evidence. Every bundle input must be present, including an explicit boolean implementation-overlap declaration. Adjudication classification must reference the same issue, owner, affected surfaces, candidate, baseline, and design authorities as the implementation classification. The standalone `sealBlogUiAdjudication` API validates its supplied classification before consuming its digest. These are contract/input checks, not verification of artifact bytes, actual reviewer independence, or current rendered behavior.

The current baseline also has one unrelated document-authority limitation: `node --test tests/tools/public-design-document-authority.test.mjs` fails its `shell, composition, reading typography and page title rules have distinct authorities` assertion because it finds no `docs/design/page-title-scale.md` authority for `唯一 page-title authority`. The static `check-article-title-authority.mjs` probe and the focused `articleTitleAuthority.test.ts` Vitest test pass; this policy change does not alter that page-title contract.

## Verify

After a reviewed domain-policy change, run:

```bash
npm ci --ignore-scripts --prefix tools/test-matrix/schema-validator
node .agents/skills/fsusblog-design-conformance/scripts/ui-orchestration.mjs
node --test tests/tools/agent-context-routing.test.mjs tests/tools/blog-ui-orchestration.test.mjs
```

Check stale policy/receipt digests, legacy receipts, ownership boundaries, baseline drift, consumer workarounds, and absence of independent rendered evidence. Contract self-tests exercise fixtures only and never certify an external consumer, scheduler rollout, or model capability.
