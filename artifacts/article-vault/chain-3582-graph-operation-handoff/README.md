# Current graph and operation handoff

Tested production/test source: `36023e2c1726734c74ef9e0dc21eb89d55f57e50` on `codex/chain-3582-current-acceptance-20261008`, draft [PR #3900](https://github.com/Ozwasyd/FsusBlog/pull/3900). Latest origin/master was fetched and verified as `3466db03e0421f4e90d36528b9062cdf7446abda` and merged without conflicts. Later ordinary naming/evidence changes do not change these tested compilation inputs. All 49 issue statuses, including the 21 retained root responsibilities and 28 transferred implementations, are in [issue-accounting.md](issue-accounting.md). No issue is accepted or closed.

## Usable canonical APIs

`ArticleVaultMaterializationPreflightVerifier.Prepare(bundle, result, operation)` consumes the existing canonical bundle/result/operation verifiers and produces source instructions bound to the exact plan/result, root-manifest digest, projection, old/new source byte identities and original local metadata digest. Original owner commits `24d9a347caf14ca051291b8e5c54a3b067ddf433` and `5d4d6358ed57945e6e0ec5ca6ea0744b3d8e5df8` are represented by `930a1292c` and `a3a3612fa` in this branch. Native snapshot/materialization owners can consume this API and the existing root-relative descriptor APIs. Preflight does not authorize native writes, supply complete accepted portable metadata or commit base.

`PostgresArticleVaultOperationCheckpointStore` now consumes the original durable replay/expiry controls from `37015c5148dfadfbaefd6d605caea6826cdd236e`. The existing checkpoint-history implementation from `4f0ed31055e3d8707404f9814a4f82e1fd1c3b0a` was already present; its empty cherry-pick was skipped. The original migration is still outside runtime admission. The canonical ArticleService group writer and real `IRevisionComparePackageReader` remain the sole existing writer/reader owners.

The supplied accepted-source tip `9cd6ae50b233eee35f291c9690d316bbfee37941` contains the real `ArticleVaultAcceptedSourceAdapter`. Its prerequisite commit `5b5d0204f4ffddbef634504ee9e659051869d79e` encountered a modify/delete conflict in `artifacts/change-contract/article-vault-operation-external-naming.json`: this branch had folded ordinary naming declarations into the root aggregate and deleted that separate file. Source/test additions applied cleanly, but the cherry-pick was aborted and this dependent consumption is paused for coordinator disposition. No replacement reader was implemented. The requested disposition is whether to consume only the canonical adapter/test changes and add their exact paths to the existing aggregate. Subsequent trusted-site/configuration-drift fix `8e9fda7b3f051a599512e79604da85adf7622f87` has not been consumed.

Even after that conflict is cleared, server composition must provide the trusted Vault site identity independently of requests. The actual historical revision reader returns its own closed metadata and rights/responsibility/release snapshots. It does not supply V1 portable metadata bytes, a persisted typed-property snapshot/current definition bridge, slug or portable taxonomy mappings. These real contract limits keep the retained metadata/automatic admission gates closed.

## Current executable evidence

Official SDK 10.0.302 and Node 24.16.0 executed the original controls against the exact source above. Commands, timestamps, exits, source hashes, TRX and raw lossless logs are in `tested-360/`.

| Check | Result |
| --- | --- |
| Related original backend union | 937 passed, 0 failed, 0 skipped |
| Root execution / closed export boundary / compiled inspector | 37 / 70 / 18 passed |
| Real disposable PostgreSQL writer/checkpoint cases | 6 passed; task fixtures cleaned up |
| Canonical production reader unit controls | 21 passed; substituted authority ports are not persisted-reader acceptance |
| Portable graph / asset byte controls | 32 / 42 passed |
| Typed property proposal / canonical mapper | 27 / 69 passed |
| Original Node/scanner and diagnostic controls | 145 passed, 0 skipped |
| Root source-lock scan | Execution and export boundary: 0 findings |
| Root C# style / registration style | 3 / 6 files passed |
| Correctness producer and testing-doc generators | Both original `--check` commands exited 0 |
| Original full matrix / convergence | Failed: finite authority bindings / two replacement declarations |
| Complete supplied-owner C# / Node style | Failed; raw owner diagnostics retained |

Current actual PR metadata initially failed because the root ordinary naming declaration missed six newly consumed paths. The exact six-path repair passed the actual remote-head PR contract at `b6e7f62e7a7f8cc4e14fae1adcefc391c79ce918`: 282 files, exit 0, actual base `3466db03e0421f4e90d36528b9062cdf7446abda`. It changes no naming policy or frozen authority. Immutable earlier commit-range failures remain historical blockers; history was not rewritten. API content writes remain paused, so the remote PR description has not been changed.

## Graph counterexample before and after

The [previous archive](../chain-3582-source-review/graph-counterexample/result.json) remains unchanged at its genuine `9eab25e3383ea8a5adf5221d42d6b8a5fb32c45b` source identity: stale saved-server graph/bytes were accepted by Build and VerifyCurrent, diagnostic exit 3.

The sole owner's supplied fix `00eeaf705dcc03a5412b36002df0b166e7442f3a` and regression `08034e84edfca42c6fcf14fcc629110adc20906c` are consumed as `e09b5cc53` and `88ef4d994`, with required canonical source `7cea1aa1704654f306eb6aee992e936b2224c179`. The current private executable directly references the actual Shared project. It adds the owner's required current-edge argument and an independently sealed legacy-extension witness; no authority/provider/receipt is fabricated.

At the tested current source, diagnostic exit is 0: stale Build is refused, the structurally valid resealed legacy extension is refused by the actual VerifyCurrent call, and fresh graph/bytes on the original plan retaining its old saved-server manifest are accepted by both Build and VerifyCurrent. Existing fresh-manifest positive and byte/relation drift negatives also retain their outcomes. See `graph-after/result.json`, original inputs, source text and before/after assembly/source bindings. This is consumer contract verification, not dependency-provider or runtime/product qualification. Parent-reported graph QA passes remain bound to that owner's actual candidate; no old occurrence/identity failure is carried forward as a new failure here.

Later committed-upload APIs from the supplied PR3979 tip were outside this narrow graph-fix batch and were not consumed. Protected lease/native QA restrictions, real supported Linux filesystem/mount capability, Windows NTFS, Darwin SDK/APFS, native readback/base commit, genuine backup/restore/recovery and independently rendered product qualifications remain outstanding. Source and tracking coverage cannot replace those gates.
