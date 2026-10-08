# Frozen singular Access source review handoff

This evidence branch publishes the frozen candidate and prior actual execution observations for independent review. It is an evidence delivery branch, not a replacement candidate or a request to merge. Independent policy review remains open. Closed/completed issue #3650 is not reopened; this is the separately authorized Access correction, related to #3444. No GPU production source was changed.

## Exact candidate and complete scope

- Base: `6e287562b3f861d3eb81dcb23f93e6243205abd8`.
- Core implementation/test execution: `0b0a976aedc8e677e099765581eefd91cd70ba1f`.
- Frozen candidate: `e6a273473b275dee0c4c2993ebd54e17a882ba33` (tree `4c39ed4d2d8a6cbe5b859a0b8b0d08e7cbb574c3`).
- Candidate branch: `codex/csharp-singular-access-source-20261008`.
- Evidence branch: `codex/csharp-singular-access-review-handoff-20261008`.
- Complete review range: `6e287562b3f861d3eb81dcb23f93e6243205abd8..e6a273473b275dee0c4c2993ebd54e17a882ba33`; two commits, eight changed paths (all mode `100644`), 229 additions and 20 deletions.
- [Complete original binary diff](complete-source.diff), SHA-256 `0a89f1e7ec617178573a979ec64ca17153cf43418ef1180c4ba9fb3594de4f36`.
- [Machine-readable handoff](candidate-handoff.json), SHA-256 `a393aa262f6503e231d930648d772e2173657812abbc73aed018df04c4cb3ce1`.

| Changed path | Candidate Git blob | Candidate SHA-256 |
| --- | --- | --- |
| `artifacts/change-contract/gpu-access-csharp-external-naming.json` | `556fff135ce609af33a9c802293281be3bf79532` | `1d802f04e27469d6799b2020a862c8783edc24ee204ff0379145798c12ec456c` |
| `artifacts/change-contract/gpu-access-csharp-policy-binding.json` | `80c207a1daf58264a53580cef491ecbf27e489a3` | `3667f69681037f9383221ec99e5ccd1870c0e6d7cde185903eb8accb8555b100` |
| `config/development/csharp-style-baseline.json` | `7834677659ffbc7a3dd5edfaf90891e6210fff54` | `1fa5e85aaa16f4a1264f075dee5ecc181e799156ee4f791f96d4e55ae678ed6e` |
| `config/development/csharp-style-policy.json` | `822c2219d353530910527cc86d37ceb66bcbfa7a` | `1c8ded64fa6a603370a946ff5f21608847c2bd495089b620e23eb2f41fd1db2f` |
| `docs/development/csharp-style-enforcement.md` | `73e7871cb867d5e29f4f2ccf9983e6d441cd0934` | `b4ebfd3aca18c51f67349a594b6dff54785a3f7d92a58bbf81e4f28adaa87978` |
| `tests/fixtures/test-matrix/release-final-execution-target-authority.json` | `75f2dd2b5de984550ba6f43604e2f71228a75be1` | `7f97e75e739cb9c516fa455cd7dd8c3ddd5bd3c84f55e3bb8052ddc81bcb3bf6` |
| `tests/tools/csharp-style.test.mjs` | `9067e263c6e385efd2975c0ffb51a7ac4232de41` | `7e2d3c07954ed8b0146a26f3a8eab92b118be0bb4788838b8df5f5d4fa51521e` |
| `tools/dotnet/check-csharp-style.mjs` | `3688b8fa26034bdc831bfe72518e34af32f30cc4` | `a01fb1fef6d468395b2e8c44e1ee219e7f962a8dd09f9538d36f2b35bf3d2d23` |

The policy appends only singular `Access`. Ordinary `GpuPeerAllocationAccess` is accepted; ordinary `Accesses` is rejected; `[Flags] Accesses` is accepted; `[Flags] Access` is rejected. The original Miss/Misses and Permission/Permissions controls remain. There is no broad `ss` exception, symbol/path exemption, GPU rename, or policy promotion.

## Original 103-test execution and blob equivalence

The original complete suite ran at **core `0b0a976aedc8e677e099765581eefd91cd70ba1f`**, using official Node `24.16.0`:

```sh
node --test tests/tools/csharp-style.test.mjs
```

Actual UTC interval: `2026-10-08T13:24:39.168039+00:00` to `2026-10-08T13:26:12.338923+00:00`; exit `0`, 103 passed, zero failed/skipped. [Original observation](original-complete-103.json), [original TAP log](original-complete-103.log); log SHA-256 `c166e5f64c399ce4d3ff36143032df3ab17129158308bd98dfa8e7af067ed5fe`.

This is not represented as a new run at e6a273. The following five relevant source/input blobs are byte-identical at core and frozen candidate:

| Input | Identical Git blob at both commits |
| --- | --- |
| `tools/dotnet/check-csharp-style.mjs` | `3688b8fa26034bdc831bfe72518e34af32f30cc4` |
| `tests/tools/csharp-style.test.mjs` | `9067e263c6e385efd2975c0ffb51a7ac4232de41` |
| `config/development/csharp-style-policy.json` | `822c2219d353530910527cc86d37ceb66bcbfa7a` |
| `config/development/csharp-style-baseline.json` | `7834677659ffbc7a3dd5edfaf90891e6210fff54` |
| `docs/development/csharp-style-enforcement.md` | `73e7871cb867d5e29f4f2ccf9983e6d441cd0934` |

The eight ordinary/flags controls are Access `0`, Accesses `1 enum-name`, flags Accesses `0`, flags Access `1 flags-enum-name`, Miss `0`, Misses `1 enum-name`, flags Permissions `0`, flags Permission `1 flags-enum-name`. [Focused control run](focused-controls.log) also passed four selected tests. The Access rebind test preserves debt and checks idempotence, stale-policy refusal, substituted baselines/policies, mixed-operation/argument refusal, absent/symlink inputs and refusal of the legacy operation on an Access policy. The legacy Miss fixture remains Miss-only; its original negative controls were retained.

## Every baseline invariant and original producer

New operation, selected separately:

```sh
node tools/dotnet/check-csharp-style.mjs --mode full --rebind-access-baseline-policy
```

Its immutable original authority is merged Miss commit `b9c076e4b763130075218ff9d50f9a6c36784f59`, policy blob `bd9f1fef0fbc4c1cca02037df7800f0bddd31f21` (SHA-256 `b341da309ee50cdc61626212053b8a5b2548309294051bf59e9e6927b4baf292`), baseline blob `17ff74d0e03920f582c59ae1e870311d9d5105fd` (SHA-256 `4351155657a6f448d27f2e7eb54dfd430d2a9246b8e0b4f463f5143ace6b204e`). The proposed policy must equal that authority policy plus only `Access`.

The original Miss operation `--rebind-baseline-policy` remains pinned to `b19b3dc715691b871f0e3cab598ec5da8f27633c`, original policy blob `5cc03bb337ddcba71cb049e8f9ca47637d7ecb26` (SHA-256 `29f9d010d5221b393164526fc6203dc555f453b83e26b77552617a13beb23200`), original baseline blob `44931fca7b3950cbaa54ba0a8f13097174c8cd42` (SHA-256 `0ab4b1ebfecbba054015209fcb30f62dbd6395a1390da67a87b9e9fd057fd011`). It permits only its original policy plus `Miss`; it refuses Access and mixed operations.

Both bounded operations require canonical regular policy/baseline files and ancestors, immutable Git modes/objects/digests (`GIT_NO_REPLACE_OBJECTS=1`), full mode, and no fix, update, base or explicit-file operation. Inputs must be the exact respective authority baseline or its exact digest-only rebound. Ordinary stale-digest refusal stays intact. No rescan or debt increase is allowed.

For Access, candidate baseline is **byte-for-byte** the authority baseline with its single policy SHA-256 replaced by `1c8ded64fa6a603370a946ff5f21608847c2bd495089b620e23eb2f41fd1db2f`. Schema `fsusblog.csharp-style-baseline.v1`, `generatedFrom` `56511df07ea301a23fcc055114c9369660954b4e`, 33 violations across 16 files, and every path/source SHA/rule/count/violation digest/other byte are unchanged. Candidate baseline SHA-256 is `1fa5e85aaa16f4a1264f075dee5ecc181e799156ee4f791f96d4e55ae678ed6e`.

The exact frozen-head idempotence run exited `0` with a clean tracked worktree before/after: [observation](exact-bounded-access-rebind.json), [log](exact-bounded-access-rebind.log). This remains a bounded source/policy capability, not independent policy acceptance.

## Generated authority: precise four-field attribution

The unchanged canonical producer actually ran at the core commit:

```sh
node tools/test-matrix/generate-release-final-execution-authority.mjs
```

UTC `2026-10-08T13:25:31.680038+00:00` to `2026-10-08T13:28:41.106749+00:00`, exit `0`; producer Git blob `3a94146cb8d98aa9ceac65bedcb9e8e183e3aa8d`. [Original observation](original-canonical-authority-producer.json), [original log](original-canonical-authority-producer.log), log SHA-256 `c35ea69e67f89c5ae982717bad3398f108a77b9fc16cf2f2684b4f35a7344ff1`.

Only these four JSON fields changed; all other values, 102 targets and 1128 closure files are identical:

| JSON fields | Source path | Old SHA-256 (both fields) | New SHA-256 (both fields) |
| --- | --- | --- | --- |
| `closureFiles[612].contentDigest`, `.indexDigest` | `tools/dotnet/check-csharp-style.mjs` | `754a8bb0e2c5505c2b404746fb289c5740d39dc17b9f0274f1eba6368c620e4f` | `a01fb1fef6d468395b2e8c44e1ee219e7f962a8dd09f9538d36f2b35bf3d2d23` |
| `closureFiles[838].contentDigest`, `.indexDigest` | `tools/test-inventory/discovery.mjs` | `305c6ee5b38118f90443afb99abe8e2f8743d734b20f939f5d42d09f4ea66665` | `721dc0a76f3aa80b9a4c5f60e51dac07c7f31fd58a6038bd396cbe0851ec39aa` |

Discovery was already changed in the actual base by earlier PDF work; its base/head source blob is identical here. The producer refreshed that inherited stale digest alongside the checker. No Discovery source was edited, no source was reverted, and no generated output was hand-edited. An initial checker-only attribution assertion failed; that attribution was corrected, rather than editing producer output. The published metadata commit description originally omitted this inherited refresh; this complete diff, [binding invariants](binding-invariants.json), and public proposed body disclose it. The ordinary binding manifest correctly names the two actually changed sources (checker/policy) and two generated outputs (baseline/authority); unchanged Discovery is not falsely declared as a changed source.

## Exact-candidate checks, failures and limits

At frozen `e6a273473b275dee0c4c2993ebd54e17a882ba33`, the original source integration command ran:

```sh
node tools/run-test-matrix.mjs ci-pr-smart --stage source-integration --base-ref 6e287562b3f861d3eb81dcb23f93e6243205abd8
```

The [initial run](exact-source-stage.json) failed, exit `1`, because configured frontend style tooling/module dependencies were missing; [failure log](exact-source-stage.log) is retained. The documented locked style-toolchain install then succeeded. The [actual same-head rerun](exact-source-stage-installed-tools.json) exited `0`, with JavaScript/doc/lifecycle checks and five pure regressions totaling 93/93 passed, zero skipped. [Rerun log](exact-source-stage-installed-tools.log) SHA-256 `2d7f13c3d2b95d633b75c45d416c86f3d8c5468c71e892c1b50314435db53d40`. [Sealed source governance](sealed-source-governance.json) is bound to e6a273, success, **qualificationEligible=false**.

Official .NET SDK `10.0.302` compiled the ordinary Access / flags Accesses syntax fixture at the core commit: [actual observation](official-access-syntax.json), [log](official-access-syntax.log), exit `0`, zero warnings/errors. This is a syntax probe, not GPU compilation/runtime acceptance.

The unmodified entire `GpuPeerTransfer.cs` taken from supplied GPU candidate `5b4305a92a015e17768bd2b37098f638b2ce8f1e` was checked with the exact frozen checker in a disposable canonical-policy fixture: [actual observation](unchanged-gpu-whole-file-lexical.json), [log](unchanged-gpu-whole-file-lexical.log), exit `0`, no lexical findings. It grants no GPU tests/native/runtime acceptance.

The original checker from the pinned trusted base accepted both the [actual commit range](trusted-actual-commit-range.json) (exit `0`, eight paths) and the [prospective PR metadata](trusted-prospective-pr-contract.json) (exit `0`). [Prepared event input](prepared-pr-event.json) is explicitly synthetic prospective metadata, number zero; it is not an actual PR/event, live gate, or posted content.

The private frontend registry attempt returned `401`; no access bypass was attempted. The repository's existing local-FsusUI preparation script created a disposable public-locked install projection from the actual local FsusUI. Tracked frontend manifest and lockfile stayed unchanged; there were no FsusUI writes. [Toolchain binding](local-source-toolchain-binding.json) records this. This grants no frontend/FsusUI qualification.

**Not run/accepted:** a new 103-test execution at e6a273, full CSharp/global matrix or qualification, GPU116/native GPU tests, security-held audit, new independent exact-diff review, policy promotion or merge. No passing suite was repeated for this portable publication. No GitHub API content was written and no PR created, issue closed, merge/auto-merge/deploy performed.

## Public proposed PR title and body

Title: **fix(governance): classify singular access enums precisely**.

The full public proposed body is [prepared-pr-body.md](prepared-pr-body.md), SHA-256 `0bebd454fcdda5360238241e326acefc8ad14ab9b8074677f05fa7a32976a67f`. It contains the standard contract and non-closing `Refs: #3444`, and discloses source-only limits and Discovery attribution. It has not been submitted as a PR.

## Portable retrieval and integrity

All referenced artifacts are committed alongside this README; historical receipt argv contains the original execution paths but reading/verifying this handoff needs none of those temporary directories. Fetch the published evidence branch and inspect this directory. The candidate remains frozen on its separate branch.

```sh
git fetch origin codex/csharp-singular-access-source-20261008 codex/csharp-singular-access-review-handoff-20261008
git diff --binary 6e287562b3f861d3eb81dcb23f93e6243205abd8 e6a273473b275dee0c4c2993ebd54e17a882ba33
git show 0b0a976aedc8e677e099765581eefd91cd70ba1f:tests/tools/csharp-style.test.mjs
git show e6a273473b275dee0c4c2993ebd54e17a882ba33:tests/tools/csharp-style.test.mjs
```

[artifact-digests.json](artifact-digests.json) indexes all 27 original artifacts with relative paths, byte lengths and SHA-256. [publication-integrity.json](publication-integrity.json) records a read-only verification of every original artifact, complete diff, eight candidate blobs, five core/candidate equal inputs, exact baseline replacement, four authority fields and unchanged Discovery/producer. This verification is integrity checking only, not a new execution/qualification receipt. [portable-artifact-digests.json](portable-artifact-digests.json) additionally indexes this README and that integrity result; it excludes itself to avoid a self-reference.

The evidence-branch whitespace scan returned `2` for six single-space context lines in the verbatim patch (`complete-source.diff`, lines 90, 92, 95, 97, 100 and 323). Those spaces are required unified-diff context markers, so the original patch bytes and digest were preserved. The frozen source range whitespace check passed, and all evidence files other than the raw patch passed the whitespace check. No source gate was changed.
