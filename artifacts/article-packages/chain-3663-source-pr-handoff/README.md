# Read-only source branch handoff inventory

Inspected master: `be7c53d99b64342925ca63d061bacde34d22ba4c`. Current integration: `3d177f17fa34bdf322447f1ea917469d2c938869`.

No tests were run for this inventory. No GitHub content was written. Exact candidate receipts are kept distinct from inherited scope.

| Branch | Remote HEAD | Paths/source | PR | Status |
| --- | --- | --- | --- | --- |
| `codex/chain-3663-asset-metadata` | `8280ea5a578fe39812f4ea029af31ca2fa8892b3` | 52/42 | [Prepared draft](chain-3663-asset-metadata.pr.md) | history retained in current integration |
| `codex/chain-3663-current-source-handoff` | `a3598378b951b5f6ca4c3cd38b0eb9bb1ebf9a59` | 80/45 | artifact/document-only handoff; no source PR proposal | not ancestor; divergent paths require review |
| `codex/chain-3663-frozen-export` | `8472af99b53d9e63584c0d6cda0bd0bc69859f66` | 40/33 | [Prepared draft](chain-3663-frozen-export.pr.md) | history retained in current integration |
| `codex/chain-3663-import-candidate` | `54b924cf414bce7235a701741601f4b6eeb2e934` | 33/28 | [Prepared draft](chain-3663-import-candidate.pr.md) | history retained in current integration |
| `codex/chain-3663-import-zip` | `4068caadabbc8e5e229a3a22cb00cd405d124314` | 37/31 | [Prepared draft](chain-3663-import-zip.pr.md) | history retained in current integration |
| `codex/chain-3663-manifest-candidate` | `f6334b35c5b420f7affb56efc20179bc38aed26e` | 24/20 | [Prepared draft](chain-3663-manifest-candidate.pr.md) | history retained in current integration |
| `codex/chain-3663-mapper-canonical-locks` | `7744c4def3a620df82928715e55dcde223e1eded` | 32/26 | [Prepared draft](chain-3663-mapper-canonical-locks.pr.md) | not ancestor; divergent paths require review |
| `codex/chain-3663-metadata-components` | `b2584610dd155996d8f1b16b94bc1f301bedc9da` | 44/36 | [Prepared draft](chain-3663-metadata-components.pr.md) | history retained in current integration |
| `codex/chain-3663-migration-lock-format-handoff` | `4f6ca6e63048302a545a2c21944da780594f4d6f` | 13/9 | [Prepared draft](chain-3663-migration-lock-format-handoff.pr.md) | not ancestor; divergent paths require review |
| `codex/chain-3663-package-continuation` | `f4600360c7d2847f048ebc5465baae052aa7efe8` | 46/37 | [Prepared draft](chain-3663-package-continuation.pr.md) | not ancestor; divergent paths require review |
| `codex/chain-3663-package-foundation` | `49e7118a384df5d5019b435ceb362320e3d917f8` | 7/5 | [#3888](https://github.com/Ozwasyd/FsusBlog/pull/3888) | not ancestor; divergent paths require review |
| `codex/chain-3663-persisted-property-binding` | `3d177f17fa34bdf322447f1ea917469d2c938869` | 355/67 | [Prepared draft](chain-3663-persisted-property-binding.pr.md) | history retained in current integration |
| `codex/chain-3663-portable-property-mapping` | `fb4d18e9342716def4dca6a73d102f7246e42846` | 50/40 | [Prepared draft](chain-3663-portable-property-mapping.pr.md) | not ancestor; divergent paths require review |
| `codex/chain-3663-property-codec` | `0c0f3583b21dabefcffc5717ad8665521a61b775` | 56/45 | [Prepared draft](chain-3663-property-codec.pr.md) | history retained in current integration |
| `codex/chain-3663-property-mapping-review` | `569518458ad4aa27cbc885417121a2e04cb74254` | 12/10 | [#4012](https://github.com/Ozwasyd/FsusBlog/pull/4012) | not ancestor; divergent paths require review |
| `codex/chain-3663-sqlite-native-repair` | `e3553bfb1ade96bb6ac6609bf92efc42de3913be` | 2/2 | [#3862](https://github.com/Ozwasyd/FsusBlog/pull/3862) | not ancestor; divergent paths require review |
| `codex/chain-3663-strict-source-closure` | `7c3a95429f2379ea60a80942244193977e18c5b2` | 162/57 | [Prepared draft](chain-3663-strict-source-closure.pr.md) | history retained in current integration |
| `codex/chain-3663-taxonomy-components` | `47da00c0c42bb9458291f4637d5d36761313c8b3` | 48/39 | [Prepared draft](chain-3663-taxonomy-components.pr.md) | history retained in current integration |
| `codex/chain-3663-title-summary-mapping` | `0c778b16f664a91d19b42b9dd26cb1ffe8e76140` | 16/13 | [Prepared draft](chain-3663-title-summary-mapping.pr.md) | not ancestor; divergent paths require review |
| `codex/chain-3663-trust-window` | `0ef9493cb1e2509254e28ac6a9ba95e860f8d4be` | 35/29 | [Prepared draft](chain-3663-trust-window.pr.md) | not ancestor; divergent paths require review |

No no-diff remote branches. Local-only import-dependency-prep, migration-lock-format and property-mapping-prequalification are not actual remote branches and receive no PR proposal.

Full path/status/numstat and endpoint differences: per-branch `.diff.txt`. Full inherited paths are also included in every uncovered source PR body. Exact byte absorption, divergent paths and closest remote ancestor are recorded in `inventory.json`. Source-vs-current patches support original-owner review, not automatic conflict resolution.

The migration lock format handoff contains actual dependency/project/lock source changes despite its handoff name. It must receive a source/build WIP draft rather than a format-only claim. Current-source-handoff has only artifact/current-document own changes above the already published property-codec source and is kept separate.

All 16 issues remain OPEN/unaccepted. No tracking assignments.

Earlier captures are aggregated without rerun: 72 clean-tree records for 15 exact remote heads. Their raw bytes, exit status, actual source/run identity and available TRX are preserved under `receipts/`; development dirty-tree captures are excluded. Some captured commands contain their actual original machine paths; proposed public PR bodies use only public repository-relative artifact locators. These original commands are not presented as portable fresh executions.

The sixteen prepared PR templates intentionally preserve WIP/unpassed full-diff gate fields; the coordinating parent is the sole PR content writer. Draft handoff must not be blocked on final review, but these templates are not passing gate evidence. The artifact-only publication branch does not alter any source branch or provide another implementation.
