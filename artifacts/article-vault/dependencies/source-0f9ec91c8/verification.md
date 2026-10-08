# Dependency and committed upload continuation: WIP

## Immutable delivery

- Draft PR: <https://github.com/Ozwasyd/FsusBlog/pull/3979>.
- Branch: `codex/issues-2124-2125-portable-assets-20261008`.
- Existing graph implementation fix: `00eeaf705dcc03a5412b36002df0b166e7442f3a`.
- Expanded Build/VerifyCurrent controls: `08034e84edfca42c6fcf14fcc629110adc20906c`.
- Canonical upload capability: `982430c1c696e51715e1fb9587acbc2f61ec8902`,
  consumed unchanged as `8b1679519ee8881763579eb752b68426b848f354`.
- New upload observation adapter: `0f9ec91c8a4c8237d096fa306d9403560e92c567`.
- Exact isolated original-project composition: `e52df80ebe4ae636edd8902b9f8fff63f05021c7`.
  Its prior canonical lock/source prerequisites remain documented in the preceding evidence.
- `source-binding.json` confirms the fourteen owned source files have identical
  bytes in the published and isolated original-project compositions.

## Observed checks

Source the configured `/workspace/.setup/activate.sh` before .NET commands.

| Command | Actual result |
| --- | --- |
| `dotnet test /tmp/issues-2124-2125/focused/DependencyFocused.csproj --no-restore --logger 'trx;LogFileName=fresh-server-binding.trx' --results-directory /tmp/issues-2124-2125/results -v:q` | 32/32 portable diagnostic tests, zero skips, exit 0 |
| `dotnet test /tmp/issues-2124-2125/assets-current/AssetCurrent.csproj --no-restore --logger 'trx;LogFileName=assets-upload-observer.trx' --results-directory /tmp/issues-2124-2125/results -v:q` | 42 asset controls plus 20 new observer controls, 62/62, zero skips, exit 0 |
| `dotnet build /tmp/issues-2124-2125/canonical/src/backend/FsusBlog.Server.csproj --no-restore -v:q` | Actual complete backend, zero errors, 323 inherited warnings, exit 0 |
| Original backend test project with filter `PortableDependencyManifestTests|ArticleVaultAssetValidationTests|ArticleVaultCommittedUploadObserverTests` | Compilation exit 1 before tests: four existing CS0182 at LifecycleHostedBootstrapServiceTests.cs:23–26 |
| `node tools/governance/check-article-vault-dependency-boundary.mjs` | Exit 0 |
| `node --test tests/tools/article-vault-dependency-boundary.test.mjs` | 8/8, zero skips, exit 0 |
| Owned C# whitespace formatting and native-tooling doc style | Exit 0; no violations |
| `git diff --check` | Exit 0 |
| Change-contract range `00a6af1..0f9ec91` | Exit 1: consumed 8b1679519 has `-x` attribution after Refs footer; retain failure, do not claim merge qualification |

The portable diagnostic references the original Shared project. The asset
diagnostic compiles the unchanged new test files against the actual complete
backend DLL from the isolated composition. The twenty observer controls use an
explicit synthetic test proxy; they do not establish live ledger or native IO
qualification. The upstream original upload tests were not executed here.

## Independently authored graph QA

Fetched the unchanged QA harness `d21665cc921df8a0ed5dc54102b244f7a7bfb85d`
from `codex/qa-vault-graph-authority-20261008` and the actual consumer
`7117889cec02509f14099f28477f673a8cf5795b` from
`codex/vault-dependency-candidates-2126-2129`.

```bash
dotnet run --project /tmp/issues-2124-2125/graph-qa/tests/risk/vault-graph-authority/VaultGraphAuthorityRisk.csproj -c Release -p:Compose=false -p:GraphSource=/workspace/FsusBlog
dotnet run --project /tmp/issues-2124-2125/graph-qa/tests/risk/vault-graph-authority/VaultGraphAuthorityRisk.csproj -c Release -p:Compose=true -p:GraphSource=/workspace/FsusBlog -p:LinkSource=/tmp/issues-2124-2125/link-7117889
```

- Graph mode: 18/18 controls, exit 0. Ready/PullUpdate uses stored revision 8
  and fresh revision 9; fresh graph builds/verifies, old graph and bytes both
  refuse with `portable_dependency_article_or_relation_drift`.
- Composite mode: 4/6, exit 1. Fenced range 42..70 and a projected route collision
  still incorrectly permit and verify the sibling link refactor candidate. Raw
  source traces and refused-admission assertions remain unchanged in the log.
  QA identifies #2126 owner `01a119f3-2d20-7274-83f9-b54866b0800b` and the missing
  #1868/#1808 canonical occurrence-to-target binding. This graph/asset owner did
  not modify the sibling resolver or invent a parser/mapper/route winner.
- Original root predecessor `50068eb43939be73e72054f8d7a662184d2497a1`
  still returns `not our ref`; its exact original probe remains requested through
  the coordinator. These current QA controls do not claim independent execution
  of that unavailable predecessor/probe.

## Status and next capability

- #2124: implemented WIP, accepted 0. Fresh active-plan server binding is published
  and checked by both our regression and the unchanged independent graph harness.
  Real package mapper/extension, shared registrations and full acceptance remain.
- #2125: implemented WIP, accepted 0. The new adapter calls only the real canonical
  committed-upload observer, checks AssetId/digest/media/owner, preserves original
  failures and returns the original observation/version/reference digests. It
  grants no Vault rights or revision binding and issues no Vault receipt.
- Pull, intended-AssetId idempotent plan/operation-bound upload, reuse, safe local
  materialization, recovery/base advancement and ledger/reference receipts remain
  blocked on actual canonical capability bytes/APIs. No second ledger, direct
  storage/database access, remote URL download or production mock was added.
- Root integration must register the additional observer test with its original
  backend/matrix/coverage owner alongside the prior exact integration request.
  Consume upstream original `982430c1` independently and the narrow `0f9ec91`
  adapter commit; preserve a final Refs footer if adding cherry-pick attribution.
  No shared registry/project/ArticleWrite/generated authority edits were made.
- No full matrix, remote CI, live ledger, native device, package roundtrip,
  publication/security terminal qualification, merge or issue closure is claimed.
