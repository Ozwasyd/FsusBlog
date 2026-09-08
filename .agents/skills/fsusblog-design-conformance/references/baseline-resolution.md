# Active FsusUI baseline

Use this reference when the task depends on current FsusUI design or rendered behavior. An editorial-only correction or isolated scheduler-policy change does not require an upstream checkout.

The source resolver is [`fsusui-root.mjs`](../../../../src/frontend/scripts/fsusui-root.mjs), consumed by [`fsusui-local.ts`](../../../../src/frontend/scripts/fsusui-local.ts) and the active build configuration. Use their actual environment, override, and worktree-aware result; do not implement another resolver or infer the active alias from `package.json` alone. The resolver CLI locates source, while the calling configuration decides whether local consumption is enabled.

For active local source, record its absolute path, Git HEAD, package identity, dirty state and content fingerprint. The current files outrank the package version. For package consumption, record the exact installed/locked version or explicit CI pin. Consult the selected checkout's `fsusui-design-conformance` Skill and its relevant current contract; use its index only to locate an unknown authority. Follow applicable upstream instructions without unconditionally loading unrelated workflows and domain documents.

The receipt format is [`fsusui-baseline-identity.schema.json`](../contracts/fsusui-baseline-identity.schema.json). Formal UI stages bind both Skill digests and required machine-readable authority digests, not a copied prose summary.

A verified context can be reused only while the checkout, alias inputs, package pin, dirty content, Skill and authority digests, and affected domain remain unchanged. A changed identity invalidates its dependent classifications and receipts. Resume an unchanged checkpoint from its recorded action instead of rereading the whole system.

Without authoritative upstream documents, report compatibility checks only. Do not claim current FsusUI conformance, invent token values, or weaken baseline requirements. Continue unrelated documentation/tooling work that does not depend on those missing authorities.
