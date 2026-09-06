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

## Verify

After a reviewed domain-policy change, run:

```bash
node .agents/skills/fsusblog-design-conformance/scripts/ui-orchestration.mjs
node --test tests/tools/agent-context-routing.test.mjs tests/tools/blog-ui-orchestration.test.mjs
```

Check stale policy/receipt digests, legacy receipts, ownership boundaries, baseline drift, consumer workarounds, and absence of independent rendered evidence. Contract self-tests exercise fixtures only and never certify an external consumer, scheduler rollout, or model capability.
