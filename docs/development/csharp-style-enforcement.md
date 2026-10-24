# C# style enforcement

`docs/development/coding-conventions.md` remains the cross-language authority. This document defines how the C# mapping is executed by `.editorconfig`, Roslyn and `dotnet format`; it does not create a second style authority.

## Executable baseline

- Root `.editorconfig` fixes UTF-8 without BOM, LF, final newline, trailing whitespace, 4-space indentation, Allman braces, `using` placement/order/groups and Microsoft .NET naming rules.
- `Directory.Build.props` enables the built-in .NET analyzers and build-time code-style enforcement. IDE0055 and IDE1006 are warnings during the migration; compiler, security and reliability diagnostics keep their existing severities.
- Generated, vendor, lock, minified and intentional fixture paths are explicitly excluded. A tool may not infer a new exclusion from a filename or a failing diagnostic.
- The tracked generator output `src/core/Algorithms/AedsFrameType.cs` is an explicit exclusion; its source generator and protocol parity tests remain the authority for that file.
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

Import normalization has an explicit fix path. It writes only the leading `using` region, places the `System` root group first, sorts the remaining root namespace groups and their directives alphabetically, then groups static and alias directives. This mirrors Roslyn's separate-import-groups formatting instead of inventing a product-specific order:

```bash
node tools/dotnet/check-csharp-style.mjs --mode full --fix
```

The current mother-standard mapping requires `System`, third-party, then `FsusBlog` imports. The bounded declaration `config/development/csharp-import-compatibility.json` applies that order only to the complete thirteen-owner roster: `tests/backend/Unit/RedisOperationExecutorTests.cs`, `tests/migration/OfflineMigrationFingerprintCommandTests.cs`, `tests/migration/OfflineMigrationOwnedPlanningAuthorityReaderTests.cs`, `tests/migration/PgLegacyCurrentSchemaPreparationTests.cs`, `tests/migration/OfflineMigrationBackupAdmissionTests.cs`, `tests/migration/PgLegacyNonArticlePreparationTests.cs`, `tests/migration/PgLegacyNonArticleRecoveryTests.cs`, `src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs`, `src/migration/OfflineMigrationCurrentSchemaArtifactReader.cs`, `src/migration/ArticlePreservationStorageWriter.cs`, `src/migration/OfflineMigrationApplyNativeSession.cs`, `src/migration/OfflineMigrationExecutor.cs` and `tests/migration/PgCurrentSchemaCatalogNotNullTests.cs`; it does not change the repository-wide migration comparator. The existing checker requires every exact owner once, validates each supported order and meaningful reason, rejecting missing, duplicate, wildcard, noncanonical, foreign or unknown declarations. The selected owner must have exact path spelling and regular non-symlink file/directory identity. Other files, same-directory peers and symlink aliases receive no registration. The other eleven declared owners retain their existing root namespace subgroups. Only the two exact `PgLegacyNonArticlePreparationTests.cs` and `PgLegacyNonArticleRecoveryTests.cs` owners use the mother-standard shared third-party group: ordinary third-party imports are ordinally sorted together, with mandatory blank separation from `System` and `FsusBlog`. Static and alias imports keep their existing ordering and separation rules for every owner. `--fix` and the read-only gate share this comparator; this is executable compatibility, not a diagnostic suppression or historical baseline allowance. The declaration stays separate from the digest-bound style policy, so the existing policy and historical baseline are unchanged. No runtime or release acceptance gate is altered.

## Full-repository modes

The normal full scan is baseline-aware:

```bash
node tools/dotnet/check-csharp-style.mjs --mode full
```

An unchanged file may carry only the exact debt captured for its current content digest. Editing that file invalidates its allowance and requires all reported violations in the file to be fixed. `strict-full` ignores the baseline and is the migration-completion proof:

```bash
node tools/dotnet/check-csharp-style.mjs --mode strict-full
```

The reviewed mechanical migrations are `892489472e27c85d277fb98c2c35969851294b58` (the initial .NET 10 whitespace/import pass across 762 solution-owned C# files), `b5c116cd54e7a0a86fd243059502a3e23f364074` (deterministic import sorting across 461 C# files), and `4839b4e1bc9f8c181fad14889414c729cba3108c` (Roslyn-compatible root-namespace group separation across 455 C# files). All contain only C# formatting changes and are registered in `.git-blame-ignore-revs`; generated, vendor and fixture sources remain excluded. The repeatable Microsoft formatter proofs are:

```bash
dotnet format whitespace FsusBlog.slnx --verify-no-changes --no-restore
dotnet format style FsusBlog.slnx --severity warn --exclude-diagnostics IDE1006 --verify-no-changes --no-restore
```

`IDE1006` remains controlled by the repository naming checker and the transparent baseline because automatic rename fixes can change public API, AEDS, database and security contracts. The generated baseline file is the only authority for the current remaining count; documentation must not copy a number that becomes stale after each module migration. It is migration debt, not a clean-style claim, and #1158 is not complete until `strict-full` reports zero. The Fast Static Governance lane calls the changed-file gate on every change, while the baseline-aware full scan remains the repository-wide authority during cleanup.

The text checker deliberately covers only syntax it can classify without contradicting Roslyn. Roslyn remains authoritative for continuation alignment, object and collection initializers, property patterns, compact automatic accessors, alias/static import groups, and content inside C# string literals. XML documentation is required for public types in every declared contract scope and for public members only in the narrower protocol, codec, analyzer, authentication, security and privacy member scopes; this avoids manufacturing empty comments for every self-describing POD field.

## Naming and external contracts

C# identifiers follow the repository mapping: PascalCase types/members/methods/local functions, `I` + PascalCase interfaces, camelCase parameters/locals, `_camelCase` instance fields, `s_camelCase` static fields, `t_camelCase` thread-static fields and PascalCase constants. Test and benchmark methods may retain a single underscore between PascalCase scenario segments because those names are test/evidence identifiers accepted by Roslyn; production methods do not receive that exception, and consecutive underscores remain forbidden everywhere. Non-flags enums are singular and flags enums are plural. The single `enumNaming.acceptedSingularSuffixes` directory includes `Miss`; `Misses` remains plural. Contextual `record with` inside an executable scope or expression continuation is a with-expression; declarations such as `record with;` and `record class with;` still require PascalCase. Roslyn and compilation remain the syntax authority.

External spelling is preserved at the boundary instead of leaking into C# identifiers. For example, `[JsonPropertyName("user_id")] public string UserId` keeps the wire key while retaining a PascalCase property. The same adapter rule applies to ORM columns, HTTP headers, Redis keys, environment variables and ABI symbols. A rename that changes an API, AEDS, database or security contract is a semantic change and is never part of formatting migration.

An existing public primary-constructor parameter can also be a source contract because callers may use named arguments. When such a name cannot be changed safely, or Roslyn cannot distinguish a `[ThreadStatic]` field from an ordinary static field, `IDE1006` may be suppressed only around the affected declaration. Every suppression must isolate `IDE1006` in its own pragma pair and register an exact path plus an ordered declaration/parameter or field contract with a meaningful compatibility reason in `naming.roslynCompatibilityExceptions`. The repository checker rejects bare or combined pragmas, missing or nested pairs, unregistered blocks, extra declarations and any block content not consumed by the registered contract. These entries are audited contract exceptions, not baseline debt, and they do not relax naming checks for any other symbol.

## XML documentation scope

The gate requires meaningful XML documentation for public declarations in shared contracts, public core protocol/codec extension points, analyzer APIs, cross-assembly interfaces, and security/privacy/ownership/lifecycle types. Overrides and ordinary internal helpers are excluded. Do not add comments that only repeat a symbol name.

## Migration and blame hygiene

1. Land the rules, checker and transparent baseline without changing application logic.
2. After all active C# feature work has landed, run the formatter and commit only its mechanical output.
3. Review that commit for semantic changes, then add its real commit SHA to `.git-blame-ignore-revs` in a follow-up commit.
4. Regenerate the baseline with `node tools/dotnet/check-csharp-style.mjs --mode full --update-baseline`; each later module migration must reduce it, and #1158 closes only after the baseline is empty and strict-full succeeds.
5. Fix naming and documentation debt by module in reviewable commits; never mix broad renames with the mechanical format commit.

No placeholder SHA is accepted in `.git-blame-ignore-revs`. A formatting commit is ignored only after it exists and has been reviewed as purely mechanical.

The read-only text checker follows the outer method parameter list across lines before extracting parameter identifiers. Parameter attributes, including `MarshalAs(UnmanagedType.LPUTF8Str)` and named attribute arguments, remain metadata; camelCase checks apply to the actual parameter names. This does not execute C# or replace Roslyn, compilation, runtime or release verification.

## Bounded policy digest rebind

`node tools/dotnet/check-csharp-style.mjs --mode full --rebind-baseline-policy` is the explicit producer for the `Miss` semantic-directory extension. It verifies the original policy and baseline regular Git objects at authority `b19b3dc715691b871f0e3cab598ec5da8f27633c`, including their pinned object IDs and SHA-256 digests with replacement refs disabled. Only the canonical policy bytes with `Miss` appended are admitted. The existing baseline must be byte-identical to that original or its exact rebound output. The producer updates only `policySha256`, preserving schema, generatedFrom, counts, paths, source/rule/violation digests and every other byte. Missing, corrupted or substituted inputs and combinations with fix, update-baseline or file selection are refused. Repeating the producer is idempotent. Normal checking still rejects a stale policy digest.

This producer does not create debt, rescan source, qualify the candidate policy, or replace full style, Roslyn, independent review and PR gates. The candidate must pass those gates before policy promotion; unchanged historical debt remains transparent.
