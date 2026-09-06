# Execution-policy maintenance and consumer integration

This reference is for Skill, policy, schema, checker, or scheduler changes. It is not an extra reading requirement for each implementation edit. Follow the repository [change contract](../../../../docs/development/change-contract.md); do not turn a tooling-only task into a rendered acceptance claim.

## One profile authority

[`blog-ui-stage-policy.json`](../contracts/blog-ui-stage-policy.json) owns implementation routes by decision class and execution shape, adjudication and UX routes, and exact model/effort bindings for UI receipt profiles. Profiles are opaque IDs; effort is not derived from a profile-name prefix. Documentation profiles are delegated to the shared scheduler and do not create a second UI receipt-model registry here.

The checked-in execution mappings retain the pre-migration provider IDs. Removing hard-coded model checks does not qualify a new model or prove its availability. An owner may register or remap a profile after capability/runtime verification, without changing checker code or hand-editing schema enums. There is no wildcard model, agent-selected policy, automatic promotion, or implicit fallback.

The local checker loads its policy from its own deployed checkout, never from a receipt. Consumers must load the owner-approved policy/checker revision, not let a candidate self-approve a different policy. The SHA-256 of the exact policy file bytes is `stagePolicyDigest`; it is separate from the shared scheduler's `routingPolicyDigest`.

## Versioned migration

Stage policy, classification, dispatch, adjudication, and UX acceptance now use v2. Each Blog receipt requires the deployed `stagePolicyDigest`. The FsusUI-owned baseline identity, checkpoint, recovery, and shared human-decision formats retain their existing versions. Old v1 Blog receipts are rejected, not relabeled or silently re-signed.

An external scheduler upgrading to v2 must load the matching policy and checker, register the generated profile schema by its `$id` alongside the baseline and receipt schemas, select a profile from the policy's route tables, and record the actual invoked model and effort. Rebuild classification, dispatch, adjudication, and acceptance against the new policy, Skill closure, authorities, and candidate. Retain the shared routing/context digests, writer isolation, independent verification, checkpoint and revalidation requirements.

Skill closure includes `SKILL.md`, applicable references, and its deployed contracts/scripts; a root-file-only hash cannot make changed guidance appear unchanged. Current task receipts must be invalidated when their consumed closure changes.

This repository cannot certify that a separately deployed scheduler has upgraded. Until it has, fail closed for formal UI dispatch rather than falling back to v1. Contract self-tests exercise fixtures only and never certify an external consumer or model capability.

## Generate and verify

The profile schema is a generated projection, not a second editable registry. After a reviewed policy change, run:

```bash
node .agents/skills/fsusblog-design-conformance/scripts/generate-execution-profiles.mjs --write
node .agents/skills/fsusblog-design-conformance/scripts/generate-execution-profiles.mjs --check
node .agents/skills/fsusblog-design-conformance/scripts/ui-orchestration.mjs
node --test tests/tools/agent-context-routing.test.mjs tests/tools/blog-ui-orchestration.test.mjs
```

Commit the source and generated projection together. Check route/model/effort mismatches, unknown profiles, stale policy/receipt digests, legacy receipts, readonly/write-scope boundaries, baseline drift, and absence of independent evidence. A test-only alternate mapping proves that runtime and schema consume policy; it does not establish that the alternate provider model exists or is approved.

`--write` also produces `contracts/generated/ui-execution-profiles.binding.json`, binding the changed policy, loader, generator, and schema output. Use this manifest for a profile-only PR. A multi-producer PR uses its own change-contract manifest to bind this manifest, the schema, and the other outputs together; neither manifest recursively binds itself. `--check` verifies byte equality for both the projection and manifest.
