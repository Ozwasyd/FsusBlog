# AGENTS.md - FsusUI

FsusUI is a fork and compatibility-focused Vue 3 component library based on Element Plus, with a WASM-capable runtime, Markdown components, theme/motion tokens, icons, and an Avalonia/.NET cross-platform surface. It is in public preview; the public npm package is `@ozwasyd/element-plus`.

This file keeps only repository-specific decision boundaries and entry points that code cannot express. It is not a map, a style guide, or a command index. Long-term facts live under [`docs/index.md`](docs/index.md) and follow [`docs/governance/documentation-architecture.md`](docs/governance/documentation-architecture.md).

Write in English. The authoritative [`docs/index.md`](docs/index.md) and [`docs/design.md`](docs/design.md) are Chinese and `spec/` is English - link to them rather than restating their values.

## Working style

- Understand the goal, adjacent implementation, and existing tests before choosing the smallest complete change; do not expand into opportunistic refactors.
- Match surrounding code: naming, comment density, error handling, and abstraction level. Generic style follows the repo tooling, not this file.
- Load context progressively; read only the fact source relevant to the change. A more specific current doc, test, or contract wins.
- Check `git status` before editing. Existing working-tree changes belong to the user; do not overwrite, revert, reformat, or commit unrelated files.

## Load context by change

| Change | Read first | Cross-check |
| --- | --- | --- |
| Web/Vue component | [`docs/components/overview.md`](docs/components/overview.md), component doc | [`docs/api-stability.md`](docs/api-stability.md), `spec/components/`, focused unit + visual tests |
| Theme / token | [`docs/theme/tokens.md`](docs/theme/tokens.md), [`spec/tokens/README.md`](spec/tokens/README.md) | [`docs/theme/customization.md`](docs/theme/customization.md), `tokens:check` |
| Motion | [`docs/theme/motion.md`](docs/theme/motion.md) | `spec/motion`, `governance:motion` |
| Visual / UX | [`docs/design.md`](docs/design.md), [`docs/design/change-classification.md`](docs/design/change-classification.md) | [`docs/workflows/visual-change.md`](docs/workflows/visual-change.md), `.agents/skills/fsusui-design-conformance/` |
| Markdown / WASM | nearest `docs/api/markdown-*.md`, `vue/packages/wasm` | `check:markdown-wasm*`, `check:markdown-xss`, `ensure:wasm` |
| Avalonia / .NET | [`docs/avalonia/README.md`](docs/avalonia/README.md) | `spec/avalonia/`, `dotnet:verify` |
| API / package surface | [`docs/api-stability.md`](docs/api-stability.md), `docs/api/` | `test:consumer-install`, `package:candidate:*`, `check:npm-*` |
| Docs / release | [`docs/governance/documentation-architecture.md`](docs/governance/documentation-architecture.md) | `check:documentation-architecture` |

## Non-negotiable boundaries

- Public API is documented imports only. `es/*`, `lib/*`, wildcard exports, `packages/*`, `internal/*`, generated WASM, build scripts, and test fixtures are not public API. `@ozwasyd/element-plus` is the FsusUI compatibility build, never upstream Element Plus.
- Documentation authority is fixed, high to low: `spec/` -> [`docs/design.md`](docs/design.md) (the sole human-readable visual contract) -> domain contracts -> governance/workflow -> guides -> records/archive. A lower layer may apply a higher layer, never redefine it. Do not add new root-level `docs/*.md` files; place documents in their domain and run `check:documentation-architecture`.
- Do not copy token values, geometry, motion budgets, or design prohibitions into workflows, skills, or this file; link to the contract. Generated documents must identify their generator and must not be edited by hand.
- UI/UX work uses `.agents/skills/fsusui-design-conformance/SKILL.md` only for FsusUI-specific ownership, design classification, evidence requirements, and UX acceptance semantics. The Skill and repository instructions must not choose shared Root/controller behavior, permanent actor roles, model/profile/effort, routes, runtime permission classes, leases/resources/capacity, shared stage order, checkpoint/continuation, retry/recovery, delivery, cleanup, or terminalization. Those belong to an external scheduler when one is present. Never claim UX/visual acceptance without inspected rendered evidence.
- The design language is "The Intellectual Minimalist" ([`docs/design.md`](docs/design.md)). Preserve information architecture, primary focus, and existing restraint. Do not add decorative cards/badges/icons/copy, redesign adjacent components, mint new tokens/wrappers/variants, or use generic SaaS patterns as design evidence.
- Runtime state boundaries ([`docs/runtime-state-boundaries.md`](docs/runtime-state-boundaries.md)): core components must not persist user data to `localStorage`, `sessionStorage`, IndexedDB, or cookies by default; durable persistence belongs to the consuming app, and library caches must be reconstructable from props/slots/injected config.
- WASM changes must keep the JavaScript fallback intact and must not publish debug-only artifacts or source maps.
- Never report vulnerabilities in public issues, PRs, discussions, or screenshots; use GitHub private vulnerability reporting per [`SECURITY.md`](SECURITY.md). Do not expose private data, tokens, internal paths, or registry config in build/demo content.
- Do not claim Element Plus compatibility unless behavior is covered by local tests or explicit FsusUI docs. Prefer `--el-*` variables; use `--fsus-*` only for a real semantic layer.
- Changesets are required for any consumer-visible change; mark breaking changes `BREAKING:` with migration docs. Internal-only changes state "changeset not needed" and why.

## Implement and verify

1. Form a short change list: add, remove, rename, semantic, or parameter changes.
2. Close the smallest loop inside the existing service/component/adapter boundary. When a contract crosses Web/Vue and Avalonia/.NET, sync every owner - no parallel implementation.
3. Run focused checks first, then broaden by risk. Test tiers come from [`docs/visual-testing.md`](docs/visual-testing.md) and the root `package.json` scripts.
4. For security or public-API changes, evaluate the affected runtime/consumer paths explicitly and report per-path results or a reason, not a blanket "all pass".
5. Update the nearest current document when a public contract, visual contract, architecture, or security semantic changes. Do not create documents to pad count.
6. On delivery, list actual commands, results, un-run items, risks, and a rollback path. Do not describe historical evidence, mocks, static checks, or a missing external environment as current end-to-end verification.

Common gates: `pnpm run lint`, `typecheck`, `test`, `build`, `verify`, `verify:strict`, `verify:release`, `verify:pr-fast`, `governance:check`, `check:fsusui-design-conformance`, `check:documentation-architecture`, `test:consumer-install`, `dotnet:verify`.

Git and delivery: prefer `gh` for GitHub operations (PR and issue workflows). Work on an issue-scoped branch (issues on the same dependency chain may be combined into a single branch) and open a PR that completes the impact and release-note checklist; verify checks and the exact head before merging. After merging, delete the branch on both origin and locally. After an issue is completed, comment the evidence (exact test command and captured output) on each resolved issue. When GitHub Actions is unavailable, only local equivalent CI all-green plus recorded commands and results justify a merge; never describe a missing remote check as passing.

## When to edit this file

Extend `AGENTS.md` only when:

- an agent repeatedly hits a non-obvious FsusUI-specific boundary;
- a new authoritative entry point must route context across tasks;
- a high-risk action must be blocked before reading detailed docs.

Each addition should be one judgment rule plus one precise link. Anything expressible from code, directories, tool descriptions, or current docs stays out of this file.
