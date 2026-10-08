# #3647 one-comment continuation from current master

The actual fetched master is `6e287562b3f861d3eb81dcb23f93e6243205abd8`; the published review candidate is its direct child `b653640c86d214283f6865bcfc4a47571764686d`, branch `task/3647-current-master-comment`. The supplied `5798707d359ce5ee57752aa868d0ccbf3f889494` was superseded only by PDF work; the owned BanStateProjection file and relevant project/props/lock files were unchanged. This is a new continuation, preserving every old stacked branch and receipt.

There are exactly2changed paths: `src/backend/Infrastructure/Security/BanStateProjection.cs` and its necessary ordinary external naming declaration. The only product source delta is one XML comment: a missing source supplies no fact, and the existing `Read(subjectHash)` may observe an intervening `Apply`. No runtime token, signature, test/oracle, lock, Project XML, policy/checker or generated source changes. Nothing from the old nine-file prerequisite candidate was imported; current master already owns its source graph. No held ProjectXML audit, broad Migration suite, PR/API content mutation, merge or production resource was used.

[Complete immutable source diff](https://github.com/Ozwasyd/FsusBlog/compare/6e287562b3f861d3eb81dcb23f93e6243205abd8...b653640c86d214283f6865bcfc4a47571764686d) · [Current candidate source](https://github.com/Ozwasyd/FsusBlog/blob/b653640c86d214283f6865bcfc4a47571764686d/src/backend/Infrastructure/Security/BanStateProjection.cs) · [Issue3647](https://github.com/Ozwasyd/FsusBlog/issues/3647).

`summary.json` indexes fresh run `fsusblog-3647-current-master-20261008T131231Z`. Every executed command, UTC start/end, exit code, exact HEAD/tree/base and clean/stable candidate check is in `current/*.json`, with original raw output in adjacent `.log`. No old outcomes were reused. `source-scope-and-merged-provenance.json` includes the complete2path diff, immutable source blob/SHA/public links and method trace.

| Current candidate check | Actual result |
| --- | --- |
| Original backend test-project restore `--locked-mode -p:NuGetAudit=true` | exit0; real SQLite NU1903 retained |
| Original unmodified backend test-project/product build and BanStateProjection/Convergence tests | exit0;15passed,0failed,0skipped; actual TRX and assembly digests included |
| Supplementary freshly compiled product-assembly probe | exit0;8scenarios: null/concurrent known result, same-generation conflict fence, stale refusal, generation recovery, cancellation, shared continuation, cleanup, repeated loads |
| Original source-integration matrix | exit0;1C#file,0violations; `qualificationEligible:false` |
| Complete tokens/AST/XML-stripped bytes/signatures and XML diagnostic proof | equal; zero diagnostics; token mutation and malformedXML negative controls reject |
| Exact original declaration coverage |17/17meaningful summaries;21total existing summaries; complete-node token mapping preserves overloaded signatures and Max helper |
| Prior merged PR3694 source proof | same executable probe proves17/17already present at merge0ea87e3c564f6fd62ee5e3de00167e0e11fc8bbd, a current-base ancestor |
| Authoritative docs/lifecycle/trusted current-base commit-range/scoped intent | exit0 |
| Final prospective local PR metadata | exit0; not actual GitHub PR admission |

The initial prospective `docs(security)` title was rejected by the unchanged path-based checker (`src/` is classified as runtime even for XML-only diffs). That raw RED remains. The final local review draft uses the previously accepted `chore(security): clarify missing ban authority documentation` category, with the complete source diff explicit. No commit history, source, checker or policy was rewritten. The missing-exception negative control still refuses: the original naming registry requires the manifest for this changed registered C# path. Local draft metadata does not create or update a PR.

`probes/original-roster.json` and `original-findings.log` seal the historical17diagnostics, not a fresh full-style receipt. `probes/BanProjectionContractProbe.cs` is the full Roslyn probe, compiled and executed afresh with official SDK10.0.401/CSharp14/refpack10.0.12. `toolchain-identity.json` rehashes actual compiler/runtime/Node24.16.0/reference files for this run. Probe binaries/tool caches are deliberately excluded. For independent source-proof reproduction, with the pinned official SDK on PATH and full repository history, run:

```bash
python3 probes/reproduce-source-proof.py --repo /path/to/FsusBlog --base 6e287562b3f861d3eb81dcb23f93e6243205abd8 --head b653640c86d214283f6865bcfc4a47571764686d --out /tmp/3647-independent-source-proof
```

The supplementary product probe source and actual compiler argv/product DLL digest are also included. This check is separate from the15original tests and establishes no broader runtime/native/cross-node qualification. The original test-project's existing Migration ProjectReference was compiled, without running that chain's Migration test/native acceptance.

Remaining gates: independent security/architecture review against current methods/norms, applicable full/domain/native/cross-node qualification, and separately authorized PR/merge/current-master acceptance. Source-stage deferred/full tier rosters remain in the original plan/result; no unrun lane is a pass. Historical PR3694 footer and global RED receipts are retained in prior evidence. SQLite NU1903 and existing analyzer warnings remain real. #3647 stays OPEN. The current one-comment continuation has no new external implementation prerequisite; old stacked nine-file review is separate.
