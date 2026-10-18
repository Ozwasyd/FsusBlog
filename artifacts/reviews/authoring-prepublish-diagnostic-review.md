# Independent diagnostic contract review

Final audited target: **`9c1ac40204aa3e697345b981e7bba57fb0d9e757`**. Original contracts pass 134/134; complete related regression is 287 pass / 2 confirmed base failures; independent controls are 68 pass / 2 core identity collision refusals failing. The historical revisions and failed intermediate assertions below remain evidence, not the final verdict.

Refs #2517. Dependency: [PR #4531](https://github.com/Ozwasyd/FsusBlog/pull/4531).

- Reviewed base: `a52639b904335c5a70480fca1d2e59a23b21c1c6`.
- Reviewed head: `8fe951bd802f4907e90c33f57feef2d7d0e59a47`.
- Reviewed source tree: `798aa7c9db32899ec0a338fa9cdcce68fa93acf4`.
- The initial review branch started at that head. The final evidence branch is replayed onto `9c1ac40204aa3e697345b981e7bba57fb0d9e757` and preserves the original results below. Its additions are a standalone negative-control runner, review evidence and the original checker-required NuGet lock naming declaration. No reviewed implementation, original assertion, fixture, lock, policy, threshold or gate is edited.
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

## Follow-up for the changed remote head

Before publication the dependency advanced to **`4d988fb19d637d3bc0c6f71d187f95bc39e623c8`**, with the same base `a52639b904335c5a70480fca1d2e59a23b21c1c6`. Its single-commit delta from the original reviewed head adds 413 lines across the two contracts, original tests and current host-boundary document. This entire delta was read; a separate clean checkout was restored, compiled and tested. The previous rows remain evidence for `8fe951bd802f4907e90c33f57feef2d7d0e59a47` only.

| New-head run | Pass | Fail | Skip |
| --- | ---: | ---: | ---: |
| Original diagnostic + manifest contract classes | 132 | 2 | 0 |
| Complete same four-class regression | 285 | 4 | 0 |
| Independent controls, including 12 new roster/coverage checks | 68 | 2 | 0 |

The old two mutation-preview failures remain; **two additional failures are introduced by the new roster test assertions**. Exact-head SOURCE and the real local FsusUI alias typecheck both pass. Independent runner Release compilation has 0 warnings/errors.

**P2: Preserve elementwise roster equality checks while fixing the two new failing assertions.** `AuthoringPrepublishDiagnosticContractTests.cs:655` and `:725` call `Assert.Equal` with two `ImmutableArray<AuthoringDiagnosticExpectedRegistration>` values backed by different arrays. Both actual tests fail with `Assert.Equal() Failure: Collections differ`, even though printed ordered records/digests match. The overload uses immutable-array value equality rather than the intended elementwise roster comparison. Preserve the order and every registration field in an explicit sequence comparison; do not remove or skip these checks. This is a test regression, not evidence that runtime roster entries were reordered. The failing methods are `ExpectedRoster_IsCompleteCanonicalAndBoundToHostPolicy` and `Coverage_CompleteResultsAreCanonicalAndPresenceDoesNotMeanSuccess`.

The original P2 core identity collision remains reproducible against this new head, with the same two refusing controls failing. Both findings require owner correction before acceptance.

The actual new `ExpectedDiagnostics` and `ValidateOutcomeCoverage` APIs supply the canonical membership contract requested in the previous combiner handoff. Twelve independent controls pass for missing required/optional outcomes, empty membership, present findings, present unavailability, omitted/tampered/foreign rosters, default/null outcomes, expired success and foreign-policy outcomes. Presence remains distinct from successful evaluation. The earlier observation about the missing roster API is historical and is superseded by this delta; live invocation binding, grants, sandbox, combiner, cache and receipts remain outside the reviewed slice.

Replay the new-head controls using its independently built server assembly:

```sh
dotnet build tests/diagnostic-contract-review/DiagnosticContractReview.csproj -c Release --no-restore -p:DiagnosticAssemblyPath=/absolute/new-head/src/backend/bin/Release/net10.0/FsusBlog.Server.dll -p:DiagnosticRosterReview=true
dotnet tests/diagnostic-contract-review/bin/Release/net10.0/DiagnosticContractReview.dll 4d988fb19d637d3bc0c6f71d187f95bc39e623c8
```

The result is 70 controls with exit 1 for the two preserved admission defects. `DiagnosticRosterReview` is a test-runner compilation option for APIs absent from the old head; it changes no host contract, security policy or test assertion.

## Final assertion-fix revision

The author then advanced to **`9c1ac40204aa3e697345b981e7bba57fb0d9e757`**, changing only the two roster assertions (3 insertions and 3 deletions). Explicit element types select ordered sequence comparison and preserve every registration field; the implementation, scopes, thresholds and expected values are unchanged. That complete diff was independently read and executed, without editing it.

| Final exact-head run | Pass | Fail | Skip |
| --- | ---: | ---: | ---: |
| Original diagnostic + manifest contracts | 134 | 0 | 0 |
| Complete related four-class regression | 287 | 2 | 0 |
| Independent controls | 68 | 2 | 0 |

Both intermediate assertion failures are **resolved at this SHA**. The remaining original regression failures have the same identities and messages as the exact base's two failures. The admission collision finding remains open; both refusing controls still fail against the freshly built exact-head server assembly, SHA-256 `afca0b952c38176d9634d23ff68d84304a9c6f889150db6694207e760a73d9b1`. Exact-head SOURCE and the actual local FsusUI alias typecheck pass. The independent runner's final Release build has 0 warnings/errors.

The final evidence branch is replayed onto parent `9c1ac40204aa3e697345b981e7bba57fb0d9e757`; audited final tests ran in the separate clean checkout at that same revision. Review commits add only their own six files and do not alter the author's test correction. Replay final controls with the same new-head command above, substituting the final assembly and final SHA argument. No result from one revision is relabeled as a run at another revision.

The initial published PR metadata check refused a test PR claiming product behavior change and required the original naming declaration for its new NuGet lock. The published SOURCE attempt also refused a non-ancestor base while the evidence branch still started before the author's assertion correction. These attempts are preserved in local logs. Only the evidence branch ancestry and its metadata/declaration are corrected; no policy or reviewed assertion is changed. The remaining review SOURCE limitation is the original dispatcher's unsupported new `.csproj` type.
