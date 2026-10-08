# PR4035 separate current-master integration handoff

The frozen e6 Access candidate remains unchanged. This is its separately authorized integration with exact master `c1c6d0d4f676b434e94eebaeec2bc8ccd27a0131`, with no delegate correction or GPU production changes. SAME independent reviewer must assess the entire new closure. This artifact grants no policy promotion, current full-suite acceptance or merge authorization.

- New source candidate: `6bce29c5b6c3986e877bb92c3ab9ba5b763db5f4`, branch `codex/csharp-access-current-integration-20261008`.
- Base: `c1c6d0d4f676b434e94eebaeec2bc8ccd27a0131`; range `c1c6d0d4f676b434e94eebaeec2bc8ccd27a0131..6bce29c5b6c3986e877bb92c3ab9ba5b763db5f4`.
- Original frozen source: `e6a273473b275dee0c4c2993ebd54e17a882ba33`.
- [Full eight-path source diff](complete-current-source.diff) SHA-256 `476b5b4871b0d085c184b6e98bb4f4fb9f4c6d4084dceead83097f5b65f6f44c`.
- [Entire delta from e6](complete-integration-delta.diff) SHA-256 `c2363bb160ae6ee5367d27b03765ec03e23edbf60a58c1b0c0737c32e69b0f9c` (includes actual master integration plus binding refresh).
- [Machine-readable exact handoff](current-handoff.json).

| Current-base changed path | Candidate blob | SHA-256 |
| --- | --- | --- |
| `artifacts/change-contract/gpu-access-csharp-external-naming.json` | `556fff135ce609af33a9c802293281be3bf79532` | `1d802f04e27469d6799b2020a862c8783edc24ee204ff0379145798c12ec456c` |
| `artifacts/change-contract/gpu-access-csharp-policy-binding.json` | `772f357dc86cf3171d368099990c6477a0354d6f` | `fa6ab58820bedc8613819288d2f63bb878ed99e2aab7e80d21a35a459387b0cf` |
| `config/development/csharp-style-baseline.json` | `7834677659ffbc7a3dd5edfaf90891e6210fff54` | `1fa5e85aaa16f4a1264f075dee5ecc181e799156ee4f791f96d4e55ae678ed6e` |
| `config/development/csharp-style-policy.json` | `822c2219d353530910527cc86d37ceb66bcbfa7a` | `1c8ded64fa6a603370a946ff5f21608847c2bd495089b620e23eb2f41fd1db2f` |
| `docs/development/csharp-style-enforcement.md` | `73e7871cb867d5e29f4f2ccf9983e6d441cd0934` | `b4ebfd3aca18c51f67349a594b6dff54785a3f7d92a58bbf81e4f28adaa87978` |
| `tests/fixtures/test-matrix/release-final-execution-target-authority.json` | `b841818e101e7d1bd68189a7f3d14d54cd1ebf5b` | `dad93142464ccff0eeafdb710d429f14e5ddb6489e213dc5444f6a136af65f5e` |
| `tests/tools/csharp-style.test.mjs` | `9067e263c6e385efd2975c0ffb51a7ac4232de41` | `7e2d3c07954ed8b0146a26f3a8eab92b118be0bb4788838b8df5f5d4fa51521e` |
| `tools/dotnet/check-csharp-style.mjs` | `3688b8fa26034bdc831bfe72518e34af32f30cc4` | `a01fb1fef6d468395b2e8c44e1ee219e7f962a8dd09f9538d36f2b35bf3d2d23` |

## Actual producer, binding and closure

The existing unmodified command `node tools/test-matrix/generate-release-final-execution-authority.mjs` actually ran at `b1fe2f988310ab5790abee6e0f9fe4e6c25dca9d`, UTC14:28:07.041265 through14:31:06.404651 on2026-10-08, exit0. [Observation](canonical-authority-producer.json), [log](canonical-authority-producer.log), log SHA-256 `157534d937de95ebf55a82dd28b4bc038db11618f3e884204af6f1a6310bad43`. The produced bytes already equaled the clean textual merge output. The active binding alone was stale; [output-derived refresh](binding-refresh.json) changes its authority SHA-256 from `7f97e75e739cb9c516fa455cd7dd8c3ddd5bd3c84f55e3bb8052ddc81bcb3bf6` to actual `dad93142464ccff0eeafdb710d429f14e5ddb6489e213dc5444f6a136af65f5e`. Baseline output digest remains `1fa5e85aaa16f4a1264f075dee5ecc181e799156ee4f791f96d4e55ae678ed6e`. No hash was hand-filled, output manually edited or producer/independent index modified.

Compared with current c1 master, the generated authority changes exactly the following two fields; 102 targets,1128 closure files and every other value remain unchanged. The earlier e6 four-field Discovery refresh belongs to its older base comparison, not this current diff.

| Exact JSON field | Current-base value | Candidate value |
| --- | --- | --- |
| `$.closureFiles[612].contentDigest` | `sha256:754a8bb0e2c5505c2b404746fb289c5740d39dc17b9f0274f1eba6368c620e4f` | `sha256:a01fb1fef6d468395b2e8c44e1ee219e7f962a8dd09f9538d36f2b35bf3d2d23` |
| `$.closureFiles[612].indexDigest` | `sha256:754a8bb0e2c5505c2b404746fb289c5740d39dc17b9f0274f1eba6368c620e4f` | `sha256:a01fb1fef6d468395b2e8c44e1ee219e7f962a8dd09f9538d36f2b35bf3d2d23` |

The original producer execution checkpoint is published on `codex/csharp-access-current-producer-checkpoint-20261008`. The initial range check rejected the default merge commit header ([actual failed log](trusted-range.log)); the unpublished integration commit messages were corrected to the required conventional form, preserving complete trees. Actual producer checkpoint b1 equals corrected merge `3346f6a7821e0b3c7c007aa6d358e57411815015` byte-for-byte. Earlier source-check checkpoint `4c7a84202d35ab3b4ae3c501e120d05b1f61c5ac` is published on `codex/csharp-access-current-source-checkpoint-20261008`, and its entire tree equals the new source candidate. [Exact correction/equivalence record](unpublished-commit-header-correction.json). Observations retain actual execution heads; no Git replacement ref or held control was used.

## Original103 input preservation

The original103 actual run remains at core `0b0a976aedc8e677e099765581eefd91cd70ba1f`. No103 suite was rerun here. All five relevant input blobs are exactly identical at core, frozen e6 and the current candidate:

| Input | Identical blob at all three commits |
| --- | --- |
| `tools/dotnet/check-csharp-style.mjs` | `3688b8fa26034bdc831bfe72518e34af32f30cc4` |
| `tests/tools/csharp-style.test.mjs` | `9067e263c6e385efd2975c0ffb51a7ac4232de41` |
| `config/development/csharp-style-policy.json` | `822c2219d353530910527cc86d37ceb66bcbfa7a` |
| `config/development/csharp-style-baseline.json` | `7834677659ffbc7a3dd5edfaf90891e6210fff54` |
| `docs/development/csharp-style-enforcement.md` | `73e7871cb867d5e29f4f2ccf9983e6d441cd0934` |

[Original portable evidence](https://github.com/Ozwasyd/FsusBlog/blob/dfbbfd8d24d51ee82bdeb2661f70613f39b813b7/artifacts/review/csharp-access-e6a273473/README.md) contains the original103 logs, official toolchain observation and every baseline invariant. The current baseline remains byte-identical to frozen e6:33violations/16files, schema/generatedFrom/source/rule/violation digests unchanged. Access and original Miss authorities remain separate; closed3650 stays completed.

## Executed allowed scope and limits

[Positive pre-execution scope](positive-execution-scope.json) lists five ordinary invocations and zero Node test cases: two JS-file style checks, one current-doc style check, lifecycle check, trusted ordinary commit-range and prospective PR contract validation. Each was actually attempted; the initial range failed only its default merge header. The corrected range and corrected prospective event were then explicitly rerun after those inputs changed, both exit0. Earlier JS/doc/lifecycle checks passed at4c; their exact full-tree equivalence to6b is recorded. All raw observations/logs are committed here, including the initial failure. Current trusted checker/parser came from the separate exact c1 base checkout and locked official dependency installation. Prospective event number0 is synthetic, never an actual GitHub PR/event.

**Blocked/not run:** current complete103, new SOURCE aggregate, held receipt/cohort/Git-replacement controls and held audits. No broad suite was run and filtered afterward. No equivalent denied controls were recreated. Historical aggregate logs are not current acceptance. SAME independent review, Access policy qualification, GPU/native/runtime and release gates remain open. No GitHub content API write, PR metadata update through the API, issue closure, merge/auto-merge or deploy was performed.

## Public metadata update for root

Proposed title remains **fix(governance): classify singular access enums precisely**. [Complete proposed public body](prepared-pr-body.md) binds the new source/base and explains unchanged semantics, actual evidence identities, current closure and remaining gates. It is prepared for root to update PR4035; this task has not posted it.

All artifacts use relative links. Historical argv may contain original temporary paths, but no temporary workspace is needed to retrieve the evidence. [artifact-digests.json](artifact-digests.json) indexes every other committed artifact with byte length/SHA-256. The verbatim patches retain unified-diff context spaces; whitespace checking those embedded context lines is a serialization warning, not source trailing whitespace. The actual current source range passed its whitespace check.
