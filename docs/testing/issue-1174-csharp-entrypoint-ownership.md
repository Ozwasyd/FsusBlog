# C# entrypoint and protocol-fixture ownership

Issue #1174 removed `src/frontend/Program.cs` instead of turning it into a supported tool. The file was not part of `FsusBlog.Client.esproj`, no `.csproj` supplied its `FsusBlog.Core` and `FsusBlog.Shared` references, and no repository command, test, or fixture consumed either `/tmp/fsus-*.hex` output. Keeping or formalizing it would create a new contract without an active consumer.

## Ownership decision

`src/frontend` is a JavaScript project root. It may contain Vite, Vitest, TypeScript, Vue, JavaScript SDK project configuration, and frontend assets, but it must not contain C# source or a second application entrypoint.

Executable C# source follows one of two explicit ownership models:

1. A `Program.cs` is below a directory that owns a `.csproj`.
2. A file-based app is declared in `tests/governance/csharp-entrypoint-ownership.json` with an owner, reason, dependency declarations, invocation, tests, and output contract.

An undocumented source file is not retained as debugging material. If a future AEDS fixture consumer needs a generator, that work must introduce the generator, deterministic fixtures, semantic decoder tests, and CI contract together.

## Protocol fixture contract

Generated AEDS frames use caller-selected output directories; fixed `/tmp` or `/var/tmp` destinations are forbidden. Files ending in `.frame.bin` or `.frame.hex` under `tests/frontend/fixtures/aeds` require exactly one manifest declaration containing:

- an owned generator `.csproj`;
- stable `generate` and blocking `check` commands;
- a committed fixture manifest;
- the exact generated fixture inventory.

The current repository declares no generated frame fixtures because no active consumer exists. Handwritten C++ AEDS contract fixtures are outside this generated-frame suffix contract.

## Governance

Run:

```bash
node tools/check-csharp-entrypoint-ownership.mjs
node --test tests/tools/issue-1174-csharp-entrypoint-ownership.test.mjs
```

The checker aggregates violations in one run. It rejects C# under declared JavaScript roots, any C# source outside a project or complete file-based app declaration, direct global temporary writes, incomplete file-based app declarations, and generated protocol fixtures without a unique generator/check owner.

The canonical repository source-layout policy binds this policy/checker pair so the ownership gate cannot become an orphan tool itself. `frontend-static-governance` executes the checker in its blocking-prebuild stage; `static-governance` executes the complete negative fixture suite. Both tiers are registered under `csharp-entrypoint-ownership-governance` in the coverage registry.

This change affects repository ownership only. It does not modify AEDS framing, article contracts, frontend bundles, backend runtime behavior, or release artifacts.
