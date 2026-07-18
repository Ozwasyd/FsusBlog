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

The reviewed mechanical migration is commit `892489472e27c85d277fb98c2c35969851294b58`. It formats 762 solution-owned C# files with .NET 10 whitespace and import ordering only; generated, vendor and fixture sources remain excluded. The repeatable Microsoft formatter proofs are:

```bash
dotnet format whitespace FsusBlog.slnx --verify-no-changes --no-restore
dotnet format style FsusBlog.slnx --severity warn --exclude-diagnostics IDE1006 --verify-no-changes --no-restore
```

`IDE1006` remains controlled by the repository naming checker and the transparent baseline because automatic rename fixes can change public API, AEDS, database and security contracts. The generated baseline file is the only authority for the current remaining count; documentation must not copy a number that becomes stale after each module migration. It is migration debt, not a clean-style claim, and #1158 is not complete until `strict-full` reports zero. The Fast Static Governance lane calls the changed-file gate on every change, while the baseline-aware full scan remains the repository-wide authority during cleanup.

The text checker deliberately covers only syntax it can classify without contradicting Roslyn. Roslyn remains authoritative for continuation alignment, object and collection initializers, property patterns, compact automatic accessors, alias/static import groups, and content inside C# string literals. XML documentation is required for public types in every declared contract scope and for public members only in the narrower protocol, codec, analyzer, authentication, security and privacy member scopes; this avoids manufacturing empty comments for every self-describing POD field.

## Naming and external contracts

C# identifiers follow the repository mapping: PascalCase types/members/methods/local functions, `I` + PascalCase interfaces, camelCase parameters/locals, `_camelCase` instance fields, `s_camelCase` static fields, `t_camelCase` thread-static fields and PascalCase constants. Non-flags enums are singular; flags enums are plural; internal identifiers cannot contain consecutive underscores.

External spelling is preserved at the boundary instead of leaking into C# identifiers. For example, `[JsonPropertyName("user_id")] public string UserId` keeps the wire key while retaining a PascalCase property. The same adapter rule applies to ORM columns, HTTP headers, Redis keys, environment variables and ABI symbols. A rename that changes an API, AEDS, database or security contract is a semantic change and is never part of formatting migration.

## XML documentation scope

The gate requires meaningful XML documentation for public declarations in shared contracts, public core protocol/codec extension points, analyzer APIs, cross-assembly interfaces, and security/privacy/ownership/lifecycle types. Overrides and ordinary internal helpers are excluded. Do not add comments that only repeat a symbol name.

## Migration and blame hygiene

1. Land the rules, checker and transparent baseline without changing application logic.
2. After all active C# feature work has landed, run the formatter and commit only its mechanical output.
3. Review that commit for semantic changes, then add its real commit SHA to `.git-blame-ignore-revs` in a follow-up commit.
4. Regenerate the baseline with `node tools/dotnet/check-csharp-style.mjs --mode full --update-baseline`; each later module migration must reduce it, and the long-term target is an empty strict-full result.
5. Fix naming and documentation debt by module in reviewable commits; never mix broad renames with the mechanical format commit.

No placeholder SHA is accepted in `.git-blame-ignore-revs`. A formatting commit is ignored only after it exists and has been reviewed as purely mechanical.
