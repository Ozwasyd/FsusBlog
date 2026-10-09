# Actual Export remote source branch inventory

Immutable intended base: master `537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea`. Read-only exact remote identity and complete inherited diff inventory. No tests dispatched for inventory or GitHub content writes.

20 actual source-bearing branches have full draft templates in [public-pr-proposals](./public-pr-proposals); one already has PR3876. Every complete name/status/rename endpoint, exact unmerged source variant and source absorption result is in [inventory.json](./inventory.json). Source absorption is byte equality, not acceptance, ancestry or merge approval.

| Branch | Exact remote head | Records / affected paths | Existing PR | Source disposition |
|---|---|---:|---|---|
| codex/chain-3653-20261008 | 43633346da5b203587a9ce788884c49641759f80 | 62 / 62 | [3876](https://github.com/Ozwasyd/FsusBlog/pull/3876) | exactly absorbed by codex/chain-3653-20261008-handoff |
| codex/chain-3653-20261008-handoff | e0175e6708af37744240fa749c652b4d8da9c5d0 | 62 / 62 | none found | exactly absorbed by codex/chain-3653-20261008 |
| codex/chain-3653-20261008-ready | b0e31fff6dfbc6debb4bf6c23df082139f26fb78 | 81 / 81 | none found | unique source variants remain |
| codex/chain-3653-budget-20261008 | de4ded917e11d9baab7e5eba1cbd28ea732e81a9 | 82 / 82 | none found | exactly absorbed by codex/chain-3653-wall-20261008 |
| codex/chain-3653-canonical-adapter-format-20261008 | 88c8cec272e597f09e07e0775abc1792507dc758 | 24 / 24 | none found | unique source variants remain |
| codex/chain-3653-canonical-freezer-20261008 | c4bfd8dca103cb59f41f58a2e9618b2e3650073e | 513 / 516 | none found | unique source variants remain |
| codex/chain-3653-di-preflight-20261009 | dec33cb67ec41424abd1226efaec6113105f2860 | 523 / 526 | none found | unique source variants remain |
| codex/chain-3653-frozen-embeds-20261008 | b65110463a5c50e133ecf0505546d95ccd2584a2 | 92 / 92 | none found | unique source variants remain |
| codex/chain-3653-frozen-embeds-reviewed-20261008 | d74d423c9635757455765df72be0f1c443061195 | 94 / 94 | none found | unique source variants remain |
| codex/chain-3653-html-svg-title-fixed-20261008 | 3b41bc28716a23d351e6244354f7f4e5bd8f107a | 98 / 98 | none found | unique source variants remain |
| codex/chain-3653-private-delivery-20261009 | cd73cccf184667b3300531b168a859669f0bbeda | 522 / 525 | none found | exactly absorbed by codex/chain-3653-private-delivery-20261009-r1 |
| codex/chain-3653-private-delivery-20261009-r1 | c65f3da6d98a9495a90a54be69dea9601f1b779c | 523 / 526 | none found | exactly absorbed by codex/chain-3653-private-delivery-20261009 |
| codex/chain-3653-shared-jobs-master-20261008 | cdf63489847a7dd3a6a1060564293f8ca7ddfc5e | 22 / 22 | none found | exactly absorbed by codex/chain-3653-html-svg-title-fixed-20261008, codex/chain-3653-site-scope-contracts-20261008 |
| codex/chain-3653-shared-prerequisites-master-20261008 | 132a5a25ef0d8a87d98715b1bcb24b818c6d3264 | 9 / 9 | none found | exactly absorbed by codex/chain-3653-canonical-adapter-format-20261008, codex/chain-3653-html-svg-title-fixed-20261008, codex/chain-3653-shared-jobs-master-20261008, codex/chain-3653-site-scope-contracts-20261008 |
| codex/chain-3653-shared-test-diagnostics-20261008 | 7bd32f92ec16dcb1f31d65649eb4aabbbc3e7d58 | 15 / 15 | none found | unique source variants remain |
| codex/chain-3653-site-scope-20261008 | c576838198b8a1a2034119cb3171f379b10302f7 | 83 / 83 | none found | unique source variants remain |
| codex/chain-3653-site-scope-contracts-20261008 | 33e6e41d99cdb54bba707d8bc6eefb43da645772 | 97 / 97 | none found | unique source variants remain |
| codex/chain-3653-wall-20261008 | 7d12a4a66e184cddb25fcff99d9b63098cb6bd5e | 82 / 82 | none found | exactly absorbed by codex/chain-3653-budget-20261008 |
| codex/chain-3653-shared-registration-integration-20261009 | cceeb55819ae2bbf02100b7a30081d488aeb7fa3 | 165 / 168 | none found | exactly absorbed source bytes by codex/chain-3653-shared-registration-integration-20261009-r1; no qualification or merge review is inferred |
| codex/chain-3653-shared-registration-integration-20261009-r1 | 5fbceb43c49cc7c8bea47d2fc61b980a99d04702 | 165 / 168 | none found | exactly absorbed source bytes by codex/chain-3653-shared-registration-integration-20261009; no qualification or merge review is inferred |

Artifact-only latest increments (handoff, private-delivery-r1, Shared-integration heads) retain inherited source-bearing complete PR diffs. They are not whole-branch artifact-only. No source branch has an empty diff in this snapshot.

The separate public-branch-inventory branches contain only public handoff artifacts. They are not extra implementation branches. The corrected packet contains required Refs metadata; earlier published material commits and failures remain preserved.

Latest Shared product source tested is0c725ee10282945053c2bc283fc991b59d81a318; corrected publication head5fbceb43c49cc7c8bea47d2fc61b980a99d04702 only appends receipts. Original locked DOM10 and SDK Server compile passed; full local-source application typecheck failed240diagnostics. Backend import conflicts and original29 held controls remain explicit in each relevant draft.
