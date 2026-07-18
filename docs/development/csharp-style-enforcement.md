# C# style enforcement

`docs/development/coding-conventions.md` remains the cross-language authority. This document defines how the C# mapping is executed by `.editorconfig`, Roslyn and `dotnet format`; it does not create a second style authority.

## Executable baseline

- Root `.editorconfig` fixes UTF-8 without BOM, LF, final newline, trailing whitespace, 4-space indentation, Allman braces, `using` placement/order/groups and Microsoft .NET naming rules.
- `Directory.Build.props` enables the built-in .NET analyzers and build-time code-style enforcement. IDE0055 and IDE1006 are warnings during the migration; compiler, security and reliability diagnostics keep their existing severities.
- Generated, vendor, lock, minified and intentional fixture paths are explicitly excluded. A tool may not infer a new exclusion from a filename or a failing diagnostic.
- `config/development/csharp-style-policy.json` defines the CLI modes, documented public-API scopes and narrow exclusions. `config/development/csharp-style-baseline.json` records existing debt by file content digest; it is not a statement that the debt is acceptable.

Run the changed-file gate while developing:

```bash
node tools/dotnet/check-csharp-style.mjs --mode changed
```

Choose an explicit comparison base in CI or a stacked branch:

```bash
node tools/dotnet/check-csharp-style.mjs --mode changed --base origin/master
```

The checker aggregates physical format, `using`, naming and XML-documentation violations before failing. It also invokes Roslyn-backed `dotnet format whitespace` and `dotnet format style` for selected files, so IDE, CLI and CI consume the same `.editorconfig`.

## Full-repository modes

The normal full scan is baseline-aware:

```bash
node tools/dotnet/check-csharp-style.mjs --mode full
```

An unchanged file may carry only the exact debt captured for its current content digest. Editing that file invalidates its allowance and requires all reported violations in the file to be fixed. `strict-full` ignores the baseline and is the migration-completion proof:

```bash
node tools/dotnet/check-csharp-style.mjs --mode strict-full
```

The direct Microsoft formatter proof is:

```bash
dotnet format FsusBlog.slnx --verify-no-changes --no-restore
```

The Fast Static Governance lane must call the changed-file gate on every change and schedule the full scan. The shared lane wiring is performed only after active C# feature branches have landed, so the lane never points at a temporarily formatted worktree.

## Naming and external contracts

C# identifiers follow the repository mapping: PascalCase types/members/methods/local functions, `I` + PascalCase interfaces, camelCase parameters/locals, `_camelCase` instance fields, `s_camelCase` static fields, `t_camelCase` thread-static fields and PascalCase constants. Non-flags enums are singular; flags enums are plural; internal identifiers cannot contain consecutive underscores.

External spelling is preserved at the boundary instead of leaking into C# identifiers. For example, `[JsonPropertyName("user_id")] public string UserId` keeps the wire key while retaining a PascalCase property. The same adapter rule applies to ORM columns, HTTP headers, Redis keys, environment variables and ABI symbols. A rename that changes an API, AEDS, database or security contract is a semantic change and is never part of formatting migration.

## XML documentation scope

The gate requires meaningful XML documentation for public declarations in shared contracts, public core protocol/codec extension points, analyzer APIs, cross-assembly interfaces, and security/privacy/ownership/lifecycle types. Overrides and ordinary internal helpers are excluded. Do not add comments that only repeat a symbol name.

## Migration and blame hygiene

1. Land the rules, checker and transparent baseline without changing application logic.
2. After all active C# feature work has landed, run the formatter and commit only its mechanical output.
3. Review that commit for semantic changes, then add its real commit SHA to `.git-blame-ignore-revs` in a follow-up commit.
4. Regenerate the baseline with `node tools/dotnet/check-csharp-style.mjs --mode full --update-baseline`; the target is an empty strict-full result.
5. Fix naming and documentation debt by module in reviewable commits; never mix broad renames with the mechanical format commit.

No placeholder SHA is accepted in `.git-blame-ignore-revs`. A formatting commit is ignored only after it exists and has been reviewed as purely mechanical.
