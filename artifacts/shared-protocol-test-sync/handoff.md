# Ordinary protocol-test synchronization handoff

Related to #3735, #3736, #3738 and #2325. All issues remain open.

## Exact source and ownership

The coordinating parent supplied consumer `7b374e71f89433cf04e5e315fdd1d43816728f85` for this repair. Latest fetched master is `a281fb6e9802471c3a44569c3ccab84f88c8d816`. Isolated branch `codex/shared-protocol-test-sync-20261009` uses the supplied consumer base; it does not claim to descend from this later master.

Smallest compatible source commit: `60c03fa44b7fa090bc1a6b227596943e19c3c3b8`. Its only changed source is `tests/tools/aeds-protocol-generation.test.mjs` (17 insertions, 3 deletions). The prior canonical correction exists in `71179da783bae459b665b1ca168a97b718b4b01b`, published through `39589ec1c4b662db1049c7f223e182ed5f87e00c`, but importing that entire commit or test file would bring the later 273-frame registration closure into the 263-frame consumer. This source commit extracts the compatible corrections without importing those registrations or producer changes.

The four corrections pin the actual 263-frame roster, project the two new evidence entries out of the historical 236-frame source, bound the existing Canvas/article-link assertion to 253–268, and append FutureFrame using the current frame count. A fifth hunk explicitly asserts the registered names, IDs and families of property/workspace frames 269–271. These frames already existed in the supplied consumer; no allocation or wire semantics change.

The five fixed historical SHA-256 assertions are unchanged. Every original malformed/unknown/duplicate/retired registration negative control remains byte-for-byte identical. The canonical manifest, original producer and all five generated products are byte-exact consumer base. This repair does not alter d61 transport, sibling implementation, Shared contracts, configuration, fixture hashes, evidence gates or test admission.

## Current executable evidence

Exact tested source is `60c03fa44b7fa090bc1a6b227596943e19c3c3b8`; later evidence-only commits do not extend the test binding.

- Original Node24.16.0 `node:test` runner, original test file and imported original producer: **36 passed, 0 failed, 0 skipped, exit 0**. Exact positive names, command and source digest are in `selection-preflight.json`; actual names and counts are in `original-node-test-result.json`; raw TAP is `original-node-test.tap`.
- Original `tools/frontend/generate-aeds-protocol.mjs --check`: **exit 0**, all five generated outputs in sync. Original command and raw output are retained.
- Both historical-golden preservation tests pass against their unchanged fixed hashes. Twenty-one original rejection controls pass, including unknown catalog metadata/version, incomplete future registration, duplicate identity/order/evidence and retired-value reuse.
- Source `git diff --check 7b374e71f89433cf04e5e315fdd1d43816728f85 60c03fa44b7fa090bc1a6b227596943e19c3c3b8`: **exit 0**.

Before execution, static selection verified all nine test call sites, both data loops, 36 distinct fully qualified positive case names and expected count. There are no lifecycle hooks, DB/browser/network/native-process requirements or held tests. Importing the producer does not invoke its guarded CLI. The first static array-selection attempt stopped with exit 1 before any test body; the delimiter was corrected and a complete positive preflight succeeded. That failure is retained in `preflight-failure-1.txt`.

## Consumer action and limits

Consume only the exact one-file source commit above, or its GitHub commit patch, into the original consumer. GitHub content mutations and draft PR creation belong to the parent coordinator. No sibling branch or frozen owner branch was edited. The parent can incorporate this compatible source increment into the original consumer PR and rerun the original selection against its resulting commit; source evidence here cannot be rebound to that result.

A separate PR targeting current master from this consumer-specific branch would include **144 inherited changed paths before these evidence files**. `run-evidence.json` enumerates that full inherited diff; it is not a one-file master PR, and those inherited changes have not received new full acceptance here. Review or use the commit delta explicitly; do not hide the inherited scope.

No 419-case consumer rerun, full frontend types/build, HTTP/Postgres/rendered UX, CI, held audit or independent qualification was performed. This ordinary test synchronization is complete; #3735, #3736 and #3738 retain their prior open acceptance gates, and the expanded Shared assignment is not complete. Pending property provider and coordinate/generation workers remain their sole implementations; integration awaits their exact supplied APIs, SHAs and evidence.
