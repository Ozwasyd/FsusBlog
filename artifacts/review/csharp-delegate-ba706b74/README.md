# Independent ordinary delegate declaration classifier review

Separate source candidate **`ba706b74c4d027b83c54a138ebf114e55fab992d`**, branch `codex/csharp-delegate-declaration-source-20261008`, starts at verified master **`c1c6d0d4f676b434e94eebaeec2bc8ccd27a0131`**. Root assigned this distinct defect to the same sole classifier owner. Closed3650 Miss and frozen e6/live4035 Access remain separate. No GPU production source, ABI, policy, baseline, producer, independent execution index or acceptance rule changes. This source candidate requires independent review; it is not policy/GPU/runtime/release acceptance.

## Complete candidate scope

Range `c1c6d0d4f676b434e94eebaeec2bc8ccd27a0131..ba706b74c4d027b83c54a138ebf114e55fab992d`. Six changed paths, all regular mode100644;195 additions/3 deletions. [Complete binary diff](complete-source.diff), SHA-256 `6b9cd01f9bdb524b1398872cb8d8298885c03a8c90789b27d00e46134f3fdef1`. [Exact machine-readable handoff](candidate-handoff.json).

| Changed path | Candidate Git blob | SHA-256 |
| --- | --- | --- |
| `artifacts/change-contract/csharp-delegate-declaration-external-naming.json` | `4346b342d0af7000bec90219c515ae8e269784d8` | `38f9bffb5eb4bc344ea6876a8f56dfbb04778cf93df11ad03299b3a2b42bdd46` |
| `artifacts/change-contract/csharp-delegate-declaration-generated-binding.json` | `661575218b6e3c5c3348fe233ce7326b673b1371` | `89f1f74923f58ae21a3cad613ecceca017d510375831e673740bcca9744d529e` |
| `docs/development/csharp-style-enforcement.md` | `74a5107730750d73d8fa9f9e0ff76c97439296f2` | `1344be5e2fbf7367802c9a5b0d4a87023b31d8b563d12185b08b4ebdbfbb3d55` |
| `tests/fixtures/test-matrix/release-final-execution-target-authority.json` | `4240783468d842f2d8802724ed1265e32e8206bd` | `1bfda2d8fda1513f6e227ec5536505acbea56d73f31ccf32f086d5b0fa94622c` |
| `tests/tools/csharp-style.test.mjs` | `8127aa4c48cb9f1bd188ecd833994d63aa7ed5f6` | `0ec0eb973613e854476d768b32aa09f47a803fa0082c521bc9d570d73285c334` |
| `tools/dotnet/check-csharp-style.mjs` | `239ea42e6fb8bf6bf2d997a935acae5b4b7e5e2c` | `7e7721b0fe57c5c6f95bfc04be0c98ad6c151ce5499f78ae44de5a2fa2a139e8` |

The original type regex captured the return token after delegate. The correction locates the actual name before the outer parameter list after its return type and optional generic type parameters. It distinguishes return tuples and generic/function-pointer signatures, preserves ref/readonly-ref/escaped/multiline forms, and ignores comparison operators inside generic parameter attributes. The actual identifier receives the existing PascalCase rule. There is no native path/symbol/delegate exemption, ABI rename, singular suffix change, baseline debt allowance or gate weakening.

## Current executable observations and exact input binding

Current actual execution core **`505ada2728740ffa21f25d452337a8279543f346`**; the packaged candidate keeps all three implementation/test/document inputs byte-identical:

| Input | Same Git blob at actual core and candidate |
| --- | --- |
| `tools/dotnet/check-csharp-style.mjs` | `239ea42e6fb8bf6bf2d997a935acae5b4b7e5e2c` |
| `tests/tools/csharp-style.test.mjs` | `8127aa4c48cb9f1bd188ecd833994d63aa7ed5f6` |
| `docs/development/csharp-style-enforcement.md` | `74a5107730750d73d8fa9f9e0ff76c97439296f2` |

The [positive ordinary allowlist](positive-test-scope.json) contains exactly15 test IDs. [Actual run](ordinary-15-current.json), [TAP log](ordinary-15-current.log): UTC14:54:45.292606 to14:54:59.992160 on2026-10-08,15/15 passed,zero skipped,exit0; log SHA-256 `a637f935a2b21657303576b8ad1a6a61c5bd5a3196e74476285f3fd7803e92f7`. The two new groups cover23 valid declaration forms, their23 lowercase counterparts, and four additional invalid identifiers. The13 original selected controls cover genuine types/records/Miss, existing regex/array/generic contracts and attributed-parameter refusals. No complete module or broad suite was run and filtered afterward.

Official Node24.16.0 and SDK10.0.302 were used. [Official syntax observation](official-syntax-68.json), [build log](official-syntax-68.log), [actual68-declaration C# input](official-syntax-inputs/Syntax.cs), [project](official-syntax-inputs/Syntax.csproj):45 original native declarations plus23 representative forms compiled successfully,exit0,zero warnings/errors. The two generic attribute constants using less-than/greater-than comparisons are real legal C# syntax. This is a compiler syntax probe, not GPU/native execution or ABI qualification.

## Real native positives and refusal controls

Root's original [portable45diagnostics/declarations](https://github.com/Ozwasyd/FsusBlog/blob/82731645f2ee2c61cb5d022cc333b06b00660f90/artifacts/memory/mem-3460-3462-current-master/native-delegate-classifier-diagnostics.txt) supplies original source identities. Exact supplied GPU candidate is `ec2187e4cb101257633beb4fda723992d0987b98`; its three native API blobs are recorded in candidate-handoff.json. The original files are unchanged from reviewed b8 source; this task never edits them in production source.

[Predeclared three-probe scope](positive-native-scope.json):

| Probe | Actual exit | Actual type-name findings | Artifact |
| --- | --- | --- | --- |
| Original c1 checker, unchanged three source files |1|45 (CUDA19/HIP14/Metal12)|[observation](native-original-45-current.json), [log](native-original-45-current.log)|
| Candidate checker, unchanged same files |0|0,selected3files|[observation](native-candidate-zero-current.json), [log](native-candidate-zero-current.log)|
| Candidate checker, only45 actual names made lowercase in disposable fixture |1|45|[observation](native-invalid-names-45-current.json), [log](native-invalid-names-45-current.log)|

The native path still rejects every invalid name. The original copied checker used for the first probe is byte-exact to the c1 Git blob; it can be retrieved from that commit. The negative mutation exists only in a disposable fixture and is not a GPU rename or runtime source change.

## Prior Access/other controls stay independent

A separate disposable fixture applies only the exact delegate checker patch from c1 to `505ada2728740ffa21f25d452337a8279543f346` on frozen e6 Access input. [Predeclared compatibility scope](positive-access-compatibility-scope.json) selects exactly four original ordinary tests: Miss, Access eight-control enum matrix and both delegate groups. [Actual observation](access-compatibility-4-current.json), [log](access-compatibility-4-current.log):4/4 passed,zero skipped. The abbreviated actual Git patch argument is explicitly resolved to the full observed core in [input identity record](access-compatibility-input-resolution.json).

This is a synthetic compatibility probe, not a public combined candidate, Access promotion or cross-chain conflict-resolution phase. Neither e6 nor separate4035 integration source was edited. No baseline rebind/history/receipt/cohort/Git-replacement test or held audit ran in this fixture.

## Canonical output and permitted source/metadata gates

The existing unmodified producer actually ran at `505ada2728740ffa21f25d452337a8279543f346`:

```sh
node tools/test-matrix/generate-release-final-execution-authority.mjs
```

[Actual observation](canonical-authority-producer-current.json), [log](canonical-authority-producer-current.log). The generated authority changes exactly these two fields;102 targets,1128closure files and every other JSON value are unchanged. The ordinary manifest SHA-256 is derived from actual output bytes. Policy and baseline are byte-identical to the c1 base; no producer/index/output hand edit occurs.

| Exact field | Base value | Candidate value |
| --- | --- | --- |
| `$.closureFiles[612].contentDigest` | `sha256:754a8bb0e2c5505c2b404746fb289c5740d39dc17b9f0274f1eba6368c620e4f` | `sha256:7e7721b0fe57c5c6f95bfc04be0c98ad6c151ce5499f78ae44de5a2fa2a139e8` |
| `$.closureFiles[612].indexDigest` | `sha256:754a8bb0e2c5505c2b404746fb289c5740d39dc17b9f0274f1eba6368c620e4f` | `sha256:7e7721b0fe57c5c6f95bfc04be0c98ad6c151ce5499f78ae44de5a2fa2a139e8` |

Final exact candidate [JS style](js-style-current.json) passes on both changed files, [trusted current-c1 commit range](trusted-range-current.json) passes, and [trusted prospective PR metadata](trusted-prospective-pr-final.json) passes all6paths. The current doc and lifecycle checks passed earlier at9797 and their inputs are unchanged; [doc observation](doc-style.json), [lifecycle observation](doc-lifecycle.json). [Source check scope](positive-source-check-scope.json), [changed-input rerun scope](positive-final-source-check-scope.json), [final metadata-only scope](positive-metadata-final-scope.json) record allowed invocations before execution. No full SOURCE receipt is claimed. Prepared event number0 is synthetic prospective metadata, not an actual PR/event or remote gate.

## Retained actually executed failures and scope limits

All failed ordinary attempts are preserved as executed failures:

- [Original defect reproduction](before-controls.log): both new test groups failed on the return token.
- [Intermediate multiline-header failure](after-controls.log), followed by repair.
- [Generic attribute lowercase refusal failure](attributed-generics-before-repair.log), followed by the actual bracket-context repair and passing controls.
- [Initial native fixture placement](native-original-45-invalid-fixture-placement.json):selected0files beneath a Git worktree. It was invalid as acceptance; [correction](native-fixture-placement-correction.json) moved the actual fixture outside Git before genuine45/0/45 checks.
- [First prospective metadata failure](history-9797/trusted-prospective-pr.log):wrong Digest/evidence label and missing Known limitations. [Second metadata failure](trusted-prospective-pr-current.log):missing Deferred work. The draft template fields were corrected; no gate changed. Both failed events/logs are retained.

Earlier21-signature/66-declaration observations remain under history-090; earlier9797 source/metadata checks remain under history-9797. They are not relabeled as current runs. The23-signature68-declaration probes were rerun because the implementation changed. Publication itself only verifies integrity and does not repeat passing suites.

**Not run:** complete103 delegate module, SOURCE/global aggregates, held audits/receipt/cohort/Git-replacement controls, GPU142/nativeGPU/runtime/product/qualification/release gates. No equivalent denied controls were created. Independent exact-diff review and required wider acceptance remain open; native/compiled runtime results supplied by the GPU owner are not inherited. No GitHub content API write, PR creation, issue closure, policy promotion, merge/auto-merge or deployment occurs.

## Public proposed PR metadata and portable review

Title: **fix(governance): classify delegate declaration names precisely**. [Complete proposed public body](prepared-pr-body.md); [synthetic prospective event](prepared-pr-event.json). The source owner has not posted either through GitHub.

All observations, raw logs, complete patch, syntax inputs and hashes are committed in this evidence branch; no access to temporary execution directories is needed. The historical argv paths remain factual original execution identities. Retrieve immutable source inputs with normal Git:

```sh
git fetch origin codex/csharp-delegate-declaration-source-20261008 codex/csharp-delegate-declaration-review-evidence-20261008
git diff --binary c1c6d0d4f676b434e94eebaeec2bc8ccd27a0131 ba706b74c4d027b83c54a138ebf114e55fab992d
git show ec2187e4cb101257633beb4fda723992d0987b98:src/backend/Infrastructure/Memory/Platform/GpuCudaNativeApi.cs
git show ec2187e4cb101257633beb4fda723992d0987b98:src/backend/Infrastructure/Memory/Platform/GpuHipNativeApi.cs
git show ec2187e4cb101257633beb4fda723992d0987b98:src/backend/Infrastructure/Memory/Platform/GpuMetalNativeApi.cs
```

[publication-integrity.json](publication-integrity.json) verifies the six path blobs, three tested input equalities, immutable policy/baseline/producer/index and two authority fields. [artifact-digests.json](artifact-digests.json) indexes all other artifacts using relative paths, lengths and SHA-256. Verbatim patches retain their required single-space unified-diff context lines; the actual candidate source whitespace check passes.

The evidence-branch whitespace scan also reports trailing spaces emitted in three raw failed TAP logs and the extra EOF blank line present in both actually compiled syntax inputs. These original bytes are retained for their recorded hashes and execution identity. The frozen implementation source range passes whitespace checking; all authored evidence text excluding raw patches/logs/compiled inputs passes. These serialization observations grant no source-gate exception.
