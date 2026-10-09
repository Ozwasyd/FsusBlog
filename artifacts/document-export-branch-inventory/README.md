# Actual Export remote source branch inventory

Latest fetched master: `a281fb6e9802471c3a44569c3ccab84f88c8d816`; historical branch records retain their exact comparison bases. Read-only exact remote identity and complete inherited diff inventory. No tests dispatched for inventory or GitHub content writes.

22 actual source-bearing branches have full draft templates in [public-pr-proposals](./public-pr-proposals); one already has PR3876. Every complete name/status/rename endpoint, exact unmerged source variant and source absorption result is in [inventory.json](./inventory.json). Source absorption is byte equality, not acceptance, ancestry or merge approval.

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
| codex/chain-3653-shared-registration-integration-20261009 | cceeb55819ae2bbf02100b7a30081d488aeb7fa3 | 165 / 168 | none found | exactly absorbed by codex/chain-3653-shared-registration-integration-20261009-r1, codex/chain-3653-ordinary-source-composition-20261009 |
| codex/chain-3653-shared-registration-integration-20261009-r1 | 5fbceb43c49cc7c8bea47d2fc61b980a99d04702 | 165 / 168 | none found | exactly absorbed by codex/chain-3653-shared-registration-integration-20261009, codex/chain-3653-ordinary-source-composition-20261009 |
| codex/chain-3653-ordinary-source-composition-20261009 | 5674cf93b8815bd9de96c0e2fc5634ca452064b8 | 204 / 207 | none found | unique source variants remain |
| codex/chain-3653-session-authority-integration-20261009 | b4c3b71e0bb5578ab9df44998eb599bde5ee0715 | 220 / 223 | none found | unique source variants remain |

Artifact-only latest increments (handoff, private-delivery-r1, Shared-integration heads) retain inherited source-bearing complete PR diffs. They are not whole-branch artifact-only. No source branch has an empty diff in this snapshot.

The separate public-branch-inventory branches contain only public handoff artifacts. They are not extra implementation branches. The corrected packet contains required Refs metadata; earlier published material commits and failures remain preserved.

Latest Shared product source tested is0c725ee10282945053c2bc283fc991b59d81a318; corrected publication head5fbceb43c49cc7c8bea47d2fc61b980a99d04702 only appends receipts. Original locked DOM10 and SDK Server compile passed; full local-source application typecheck failed240diagnostics. The two root source conflicts were resolved through authorized ordinary composition. Sole Jobs contract consumption and current root compilation remain pending. Earlier drafts retain their historical observations; current original29 eligibility depends on actual denied-scope overlap rather than blanket aggregate coupling.

Latest ordinary source composition resolves both root-owned files and consumes33safe deltas. Actual compile is FAIL39errors bound to the sole untouched Jobs contract. Production modules released with real APIs: [released-production-modules.md](./released-production-modules.md). See [chain-status.json](./chain-status.json) for all11 open gates.

Current session-authority integration sourceba4681746999eb366aece2175c347665e471515c passes nine-file scoped C# style, official whitespace, metadata/diff and audited locked restore. Its real Server build fails41errors/326warnings at the unchanged sole Jobs contract. Separately inspected sole repair4fd5c1 builds original Server and test projects, but awaits formal parent consumption. Current published source/artifact headb4c3b71e0bb5578ab9df44998eb599bde5ee0715 imports the exact seven approved d8 bounded-entry files without executing them.

Supplier935dc887 has parent-supplied original-project27/27 unit and29/29 isolated PostgreSQL results, exact discovery/TRX and confirmed cleanup. Those results bind only that supplier source/control scope. Root does not repeat unchanged tests for status or promote them to full integration. Original Export14methods/29rows require exact positive names/rows, selected hooks, real resources/discovery/counts and actual overlap with seven denied scopes before execution. PG29 uses its own original integration fixture and is excluded from backend-unit. Held audits remain unrun.
