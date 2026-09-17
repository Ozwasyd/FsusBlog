# AGENTS.md: FsusBlog

FsusBlog is a deployment-oriented content system built around AEDS binary reads and verifiable runtime contracts. Prefer Chinese in conversation with the user; keep code identifiers, paths, and commands in English.

## Scope and completion

Respect the user's task scope and any existing working-tree changes. Check `git status` before the first write. Do not overwrite, revert, reformat, or commit unrelated changes. Review-only or planning tasks do not automatically become implementation tasks.

For an implementation task, close the loop inside the requested scope: make the change, verify it, fix regressions introduced by this change, and update the necessary current documents. Do not wait for routine approval after a first pass. Use planning and progress notes only when the task complexity warrants them; do not invent process for small edits.

In a local environment that is confirmed isolated, has no production access, and only touches resources owned by this task, you may build, run the relevant checks, fix failures, and rerun on your own. Still honor the task's write permissions and resource-lifecycle contracts. For production or non-task data, secrets, destructive migrations, releases, or other outward writes, confirm the action is already authorized; if it is not, do not run it. When a real permission, environment, or product decision blocks progress, pause only the blocked part, continue independent work, and state the gap.

## Load context on demand

Use the [document index](docs/index.md) to locate sources; it is not a required reading list. Load only the sections, implementations, tests, and Skills that apply to the current question. Do not reread unchanged context.

Judge document authority with the [document lifecycle](docs/development/document-lifecycle.md) and `config/development/document-lifecycle.json`. `current` means the maintained authoritative location; it does not guarantee the text already matches the implementation. Proposed, historical, and retired material cannot replace current norms. Generated indexes and evidence are for navigation or verification; trace them to their producer and do not hand-edit the outputs. When norms, implementation, and tests disagree, determine the intended behavior; do not rewrite the contract because something is newer or currently passing.

| Task involves | Context entry |
| --- | --- |
| API, DTO, AEDS, POD, cross-stack ABI | [API contracts](docs/api/contracts.md), [AEDS v2 protocol](src/core/Algorithms/AEDS_V2_PROTOCOL.md) |
| Auth, session, privacy, security | [Security](docs/security.md) and the matching current subdocuments |
| Cache, middleware, startup, or runtime architecture | [Architecture](docs/architecture.md) and the matching current boundary docs |
| Non-visual frontend runtime, Wasm glue | [Architecture overview](docs/architecture/overview.md) and the matching current frontend docs |
| Observable UI, interaction, visual acceptance, or design contracts | [fsusblog-design-conformance](.agents/skills/fsusblog-design-conformance/SKILL.md) |
| Database migration | [Migration](docs/database-migration.md), [Online migration](docs/online-database-migration.md) |
| Coding, source/generated/vendor ownership | [Coding conventions](docs/development/coding-conventions.md), [Repository ownership](docs/architecture/repository-layout.md) |
| Document changes, commits, or PRs | [Document lifecycle](docs/development/document-lifecycle.md), [Change contract](docs/development/change-contract.md), chosen for this task |

## Boundaries that must not be bypassed

- The public runtime accepts AEDS v2 only. Do not restore legacy text APIs, JSON fallbacks, or generic stream reassembly of already-encoded frames. Protocol changes must keep wire/ABI parity across C#, shared contracts, POD, the C++ decoder, TypeScript glue, and tests.
- Preserve `X-Fsus-*`, PoW, unified response and error semantics, and fail-closed security behavior. Do not bypass auth or privacy for compatibility, degradation, or test convenience.
- `src/shared/Contracts/` owns cross-stack contracts. `src/core/` must not introduce HTTP, Cookie, or routing semantics. Cache invalidation, middleware/startup, and Wasm glue follow existing owners; do not add side paths or parallel implementations.
- UI follows the actually active FsusUI baseline, not package version alone. Shared components and common tokens belong to FsusUI; product composition belongs to FsusBlog. Do not hide upstream defects with private selectors, forged tokens, or compatibility wrappers. Design judgment and evidence requirements are routed by the design Skill to current authoritative documents.
- Treat generated, vendor, fixture, and lockfile surfaces under existing ownership rules. Change generated outputs through their source and producer; do not treat products as hand-written source.

## Verification and delivery

Check entry points are `./tools/test.sh help`, `tests/matrix.yml`, and the relevant sections of [Testing](docs/testing.md). Run checks that directly cover the change first, then widen by impact and risk. That does not waive required matrix coverage, independent acceptance, or commit/merge gates. Orchestration work still follows the current domain stage policy, implementation-ownership isolation, and candidate binding. Shared orchestration such as model and route selection belongs to an external scheduler when one is present; autonomous local execution is not a reason to skip domain acceptance.

Verify the current candidate and the behavior it actually affects. When visual acceptance is required, inspect real rendered results. Do not treat compilation, static checks, mocks, historical screenshots, or checker self-tests as current end-to-end or UX acceptance. Do not weaken tests, fixtures, thresholds, or gates to force a green result. When the expected contract must change, update it through the matching governance process.

When a public contract, architecture, security, or operations semantic changes, update the matching current documents. Maintain document lifecycle, indexes, and generated outputs through existing producers and checkers; do not create a second source of truth.

Commit, push, open a PR, or merge only inside the task's authorized scope. Follow the [Change contract](docs/development/change-contract.md) and the ruleset/checks in force at execution time. A missing remote check is not a pass. Local green results do not by themselves authorize a merge.

On delivery, state what was completed, the verification commands and results, what was not verified, and any blockers. When compatibility or data risk is involved, state the rollback conditions. Separate regressions introduced here from pre-existing failures and missing environment. Do not claim completion beyond the evidence.

## Maintaining this file

Add only decision boundaries that stay stable across tasks, cannot be reliably recovered from existing entry points, and are worth keeping resident, with a link to their authoritative source. Do not copy implementation symbol tables, full command catalogs, design numeric values, the complete test matrix, model tiers, or temporary issue/orchestration state into this file.
