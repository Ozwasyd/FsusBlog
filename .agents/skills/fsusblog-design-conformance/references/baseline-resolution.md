# Active FsusUI baseline

Use this reference when the task depends on current FsusUI design or rendered behavior. An editorial-only correction or isolated policy change does not require an upstream checkout.

FsusBlog V2 consumes the sibling `../FsusUI` checkout through local source aliases configured in [`src/Web/vite.config.ts`](../../../../src/Web/vite.config.ts) and [`src/Web/tsconfig.json`](../../../../src/Web/tsconfig.json), documented in [`docs/fsusui.md`](../../../../docs/fsusui.md). Business code must import only public `@ozwasyd/element-plus` entry points and must never silently fall back to an npm release package.

For active local source, record its absolute path, Git HEAD, package identity, dirty state, and content fingerprint. The current files outrank the package version. Consult the active checkout's `fsusui-design-conformance` Skill and [`../FsusUI/docs/design.md`](../../../../../FsusUI/docs/design.md) as needed without unconditionally loading unrelated upstream workflows.

The receipt format is [`fsusui-baseline-identity.schema.json`](../contracts/fsusui-baseline-identity.schema.json). Formal UI stages bind both Skill digests and required machine-readable authority digests, not a copied prose summary.

A verified context can be reused only while the checkout, alias inputs, dirty content, Skill and authority digests, and affected domain remain unchanged. A changed identity invalidates its dependent classifications and receipts. Resume an unchanged checkpoint from its recorded action instead of rereading the whole system.

Without authoritative upstream documents, report compatibility checks only. Do not claim current FsusUI conformance, invent token values, or weaken baseline requirements. Continue unrelated documentation/tooling work that does not depend on those missing authorities.
