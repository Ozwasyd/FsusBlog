# Actual Export remote source branch inventory

Immutable intended base: master `537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea`. Read-only Git/GitHub inventory; no tests, content API writes, merges or branch deletions.

Complete path/status lists, unmerged source variants, exact peer absorption and existing PR reads: [inventory.json](./inventory.json).

Every nonempty source branch has a complete draft template in [public-pr-proposals](./public-pr-proposals). The original root branch already has PR3876; its template is an update proposal only. No branch is empty in this snapshot.

| Branch | Exact remote head | PR paths | Existing PR | Classification / source disposition |
|---|---|---:|---|---|
| codex/chain-3653-20261008 | 43633346da5b203587a9ce788884c49641759f80 | 62 | [3876](https://github.com/Ozwasyd/FsusBlog/pull/3876) | source branch; exactly absorbed by codex/chain-3653-20261008-handoff |
| codex/chain-3653-20261008-handoff | e0175e6708af37744240fa749c652b4d8da9c5d0 | 62 | none found | artifact-only increment over a source branch; exactly absorbed by codex/chain-3653-20261008 |
| codex/chain-3653-20261008-ready | b0e31fff6dfbc6debb4bf6c23df082139f26fb78 | 81 | none found | source branch; unique source variants remain |
| codex/chain-3653-budget-20261008 | de4ded917e11d9baab7e5eba1cbd28ea732e81a9 | 82 | none found | source branch; exactly absorbed by codex/chain-3653-wall-20261008 |
| codex/chain-3653-canonical-adapter-format-20261008 | 88c8cec272e597f09e07e0775abc1792507dc758 | 24 | none found | source branch; unique source variants remain |
| codex/chain-3653-canonical-freezer-20261008 | c4bfd8dca103cb59f41f58a2e9618b2e3650073e | 513 | none found | source branch; unique source variants remain |
| codex/chain-3653-di-preflight-20261009 | dec33cb67ec41424abd1226efaec6113105f2860 | 523 | none found | source branch; unique source variants remain |
| codex/chain-3653-frozen-embeds-20261008 | b65110463a5c50e133ecf0505546d95ccd2584a2 | 92 | none found | source branch; unique source variants remain |
| codex/chain-3653-frozen-embeds-reviewed-20261008 | d74d423c9635757455765df72be0f1c443061195 | 94 | none found | source branch; unique source variants remain |
| codex/chain-3653-html-svg-title-fixed-20261008 | 3b41bc28716a23d351e6244354f7f4e5bd8f107a | 98 | none found | source branch; unique source variants remain |
| codex/chain-3653-private-delivery-20261009 | cd73cccf184667b3300531b168a859669f0bbeda | 522 | none found | source branch; exactly absorbed by codex/chain-3653-private-delivery-20261009-r1 |
| codex/chain-3653-private-delivery-20261009-r1 | c65f3da6d98a9495a90a54be69dea9601f1b779c | 523 | none found | artifact-only increment over a source branch; exactly absorbed by codex/chain-3653-private-delivery-20261009 |
| codex/chain-3653-shared-jobs-master-20261008 | cdf63489847a7dd3a6a1060564293f8ca7ddfc5e | 22 | none found | source branch; exactly absorbed by codex/chain-3653-html-svg-title-fixed-20261008, codex/chain-3653-site-scope-contracts-20261008 |
| codex/chain-3653-shared-prerequisites-master-20261008 | 132a5a25ef0d8a87d98715b1bcb24b818c6d3264 | 9 | none found | source branch; exactly absorbed by codex/chain-3653-canonical-adapter-format-20261008, codex/chain-3653-html-svg-title-fixed-20261008, codex/chain-3653-shared-jobs-master-20261008, codex/chain-3653-site-scope-contracts-20261008 |
| codex/chain-3653-shared-test-diagnostics-20261008 | 7bd32f92ec16dcb1f31d65649eb4aabbbc3e7d58 | 15 | none found | source branch; unique source variants remain |
| codex/chain-3653-site-scope-20261008 | c576838198b8a1a2034119cb3171f379b10302f7 | 83 | none found | source branch; unique source variants remain |
| codex/chain-3653-site-scope-contracts-20261008 | 33e6e41d99cdb54bba707d8bc6eefb43da645772 | 97 | none found | source branch; unique source variants remain |
| codex/chain-3653-wall-20261008 | 7d12a4a66e184cddb25fcff99d9b63098cb6bd5e | 82 | none found | source branch; exactly absorbed by codex/chain-3653-budget-20261008 |
| codex/chain-3653-shared-registration-integration-20261009 | 0c725ee10282945053c2bc283fc991b59d81a318 | 164 | none found | source branch; unique source variants remain |
