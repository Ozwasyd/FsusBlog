# Independent diagnostic contract review

Refs #2517. Dependency: [PR #4531](https://github.com/Ozwasyd/FsusBlog/pull/4531).

- Reviewed base: `a52639b904335c5a70480fca1d2e59a23b21c1c6`.
- Reviewed head: `8fe951bd802f4907e90c33f57feef2d7d0e59a47`.
- Reviewed source tree: `798aa7c9db32899ec0a338fa9cdcce68fa93acf4`.
- Review branch starts at that exact head. Its additions are a standalone negative-control runner and review evidence. No reviewed implementation, original assertion, fixture, lock, policy, threshold or gate is edited.
- The source head and base were independently built and tested in separate clean worktrees. Author-reported results were not substituted for these runs.

## Finding requiring correction

**P2: Explicit core check IDs are not checked against manifest extension/contribution IDs.**

`AuthoringPrepublishDiagnosticRegistry.cs:56-66` incorporates `coreResults.CheckId` into reserved identities. At lines 85-92, only `DiagnosticId` is compared to this set. `ExtensionId` and `ContributionId` are checked for identifier syntax and manifest membership, without the additional core-result collision check. The original extension registry cannot reject these additional identities because it receives `CoreAuthorities`, not the separate diagnostic `coreResults` supplied later.

Two independent refusal controls fail against the exact head:

1. Keep a verified manifest contribution `review.check`, register category diagnostic `review.alias` against that contribution, and supply a core observation with `CheckId = review.check`. Registration succeeds.
2. Keep manifest extension `review.extension`, register its ordinary diagnostic, and supply a core observation with `CheckId = review.extension`. Registration succeeds.

The diagnostic category can therefore admit a core/plugin identity collision despite the required fail-closed non-overlap contract. This does not demonstrate an executed core override or a changed publication decision: this slice has no executor or combiner. Reject the intersection between the complete manifest identity roster and the newly supplied core check identities before accepting the diagnostic join. Keep both refusal controls; they deliberately remain failing in this review.

## Actual execution

| Run | Pass | Fail | Skip | Result |
| --- | ---: | ---: | ---: | --- |
| Exact-head original diagnostic + manifest contracts | 105 | 0 | 0 | Includes all 76 new diagnostic cases and 29 original manifest cases |
| Exact-head complete four-class regression | 258 | 2 | 0 | Original failures preserved |
| Exact-base complete same-filter regression | 182 | 2 | 0 | Same two failure identities and messages |
| Independent direct-assembly controls | 56 | 2 | 0 | Two core identity collision refusals fail |

The regression filter includes `AuthoringPrepublishDiagnosticContractTests`, `AuthoringExtensionContractsTests`, `AuthoringCommandContributionTests` and `AuthoringExtensionRpcTests`. The diagnostic class is absent at base; the original remaining 184 cases were all executed there. This is the complete requested related regression, not the entire backend suite.

The two existing failures are `TransactionAdapter_AppliesMutationThroughCanonicalRpcOnce` (mutation approval does not bind the exact plan/context) and the mixed Unicode row of `MutationPreview_ExactFramedMaterialMatchesIndependentLiteralVectors` (digest mismatch). The original RPC implementation and both original test files are byte-identical between reviewed base/head. These failures are not waived, fixed or counted as passes.

Independent controls exercise all severities and both requiredness values, every unavailable reason, decoded duplicate JSON keys, missing nullable members, unknown versions/completion/codes, nested host-policy/HTML/patch/executable injection, encoded HTML, duplicate/core facts, full/split-full reads, metadata scope, exact deadlines, epoch/config/text/core/requiredness binding, forbidden capabilities, and exact output-byte ceilings. See the accompanying JSON for individual outcomes and assembly digest. The original 105-case suite additionally covers 0/1/100/1000 registrations and all ten budget dimensions.

## Contract assessment

- Input is built through the actual `CreateInput` API from host-admitted reads. `ValidateResult` reconstructs its binding; no input parser, live grant verifier or extra API is assumed. Digests identify content and context; they do not authenticate a caller or establish current permission.
- Output parsing rejects unknown, missing and duplicate members. Schema/completion, diagnostic/input identity, facts, code/severity, namespace, ranges/evidence and inert fix references are checked. Explicit `NoFindings` never claims core pass.
- Requiredness, exact per-code severity and effective budgets come from host policy. Manifest/category budgets are ceilings; plugin response JSON cannot supply host policy. Admission/payload checks do not measure runtime CPU/memory/concurrency or implement cancellation/retry.
- Core observations remain unchanged and only their digest is sent in diagnostic input. The identity collision finding concerns admission. Runtime monotonic combination and receipt integration are outside this head.
- The existing combiner handoff about a canonical complete expected diagnostic roster remains unresolved. This review assumes no enumeration or policy getter beyond the actual API and adds no shadow registry.

## Other verification

- Original exact-head SOURCE stage: PASS, including original strict C# style (3 files, 0 violations), documentation lint and lifecycle. Its output explicitly states no runtime/release qualification.
- Original exact-head document lifecycle/current-authority checks and commit-range Change Contract: PASS.
- Official Node `24.16.0` archive checked against official SHA-256 sums; parser/schema tools installed from original locks; original Markdownlint `0.23.1` used. No checker/policy was changed.
- Real local FsusUI alias typecheck: PASS, using `/workspace/FsusUI` at `f2d929a5d045439c35e93b4771f912ce50ec2337`, with the saved public locked dependency installation. No registry FsusUI substitute or type shim was introduced.
- Re-running the one-shot local-install verifier: FAIL because `vue/packages/node_modules` already exists from saved setup. This refusal is retained; existing shared links were not removed. The real alias typecheck was executed separately and passed.
- NuGet audit warnings for existing MessagePack/SQLite dependencies remain visible.
- The review runner's own locked restore, Release build (0 warnings/errors) and strict C# check pass. Review-branch SOURCE is **FAIL/unsupported** because the original source-stage dispatcher has no handler for the newly added `.csproj`; its C# check passes and its documentation selection checks zero files under the existing artifact exclusion. This is not a passing review-branch gate; the checker and exclusions were not changed. The review commit-range Change Contract passes.
- An extra direct Markdownlint invocation expanded the repository's configured globs to 367 files and failed with 711 diagnostics in 33 files. The identical command in the exact base produces the exact same ordered 711 diagnostic lines. This broad failure is preserved separately from the applicable exact-head SOURCE documentation check, which passes.

## Reproduction

From an independent checkout of the reviewed head, with saved environment activation:

```sh
source /workspace/.setup/activate.sh
dotnet restore tests/backend/FsusBlog.Server.Tests.csproj --locked-mode -p:NuGetAudit=true -p:NuGetAuditMode=all -p:NuGetAuditLevel=low
dotnet test tests/backend/FsusBlog.Server.Tests.csproj -c Release --no-restore --filter 'FullyQualifiedName~AuthoringPrepublishDiagnosticContractTests|FullyQualifiedName~AuthoringExtensionContractsTests'
dotnet test tests/backend/FsusBlog.Server.Tests.csproj -c Release --no-build --no-restore --filter 'FullyQualifiedName~AuthoringPrepublishDiagnosticContractTests|FullyQualifiedName~AuthoringExtensionContractsTests|FullyQualifiedName~AuthoringCommandContributionTests|FullyQualifiedName~AuthoringExtensionRpcTests'
```

Run the same four-class filter in a separately restored/built exact-base checkout. To replay the independent controls from this review branch, pass the absolute server assembly path built from the exact reviewed head:

```sh
dotnet restore tests/diagnostic-contract-review/DiagnosticContractReview.csproj --locked-mode
dotnet build tests/diagnostic-contract-review/DiagnosticContractReview.csproj -c Release --no-restore -p:DiagnosticAssemblyPath=/absolute/exact-head/src/backend/bin/Release/net10.0/FsusBlog.Server.dll
dotnet tests/diagnostic-contract-review/bin/Release/net10.0/DiagnosticContractReview.dll
```

The runner returns **exit 1** for the two confirmed admission defects and prints actual per-control results. This is intentionally red evidence, not a green acceptance suite. Raw TRX and logs remain under `/workspace/diagnostic-independent-results`; the JSON records their hashes without uploading raw logs.

No merge, package publication, implementation fix or issue closure is authorized by this review. Full backend/native/runtime/security/browser/release qualification and live diagnostic/receipt acceptance were not executed. Issue #2517 stays open.
