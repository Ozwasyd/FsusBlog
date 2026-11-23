# Active FsusUI baseline

Use this reference when the task depends on current FsusUI design or rendered behavior. An editorial-only correction or isolated policy change does not require an upstream checkout.

FsusBlog V2 consumes the pinned `@ozwasyd/element-plus` npm package from GitHub Packages configured in [`src/Web/package.json`](../../../../src/Web/package.json), [`src/Web/pnpm-lock.yaml`](../../../../src/Web/pnpm-lock.yaml), and [`src/Web/.npmrc`](../../../../src/Web/.npmrc), documented in [`docs/fsusui.md`](../../../../docs/fsusui.md). Business code must import only public `@ozwasyd/element-plus` entry points and must not mask FsusUI defects with private selectors or forged tokens.

For the active package baseline, record the resolved package name, exact version, lockfile integrity digest, and matching upstream commit/tag when consulting upstream `docs/design.md` or `fsusui-design-conformance` (if a sibling checkout is present for design review).

The receipt format is [`fsusui-baseline-identity.schema.json`](../contracts/fsusui-baseline-identity.schema.json). Formal UI stages bind both Skill digests and required machine-readable authority digests, not a copied prose summary.

A verified context can be reused only while the checkout, alias inputs, dirty content, Skill and authority digests, and affected domain remain unchanged. A changed identity invalidates its dependent classifications and receipts. Resume an unchanged checkpoint from its recorded action instead of rereading the whole system.

Without authoritative upstream documents, report compatibility checks only. Do not claim current FsusUI conformance, invent token values, or weaken baseline requirements. Continue unrelated documentation/tooling work that does not depend on those missing authorities.
