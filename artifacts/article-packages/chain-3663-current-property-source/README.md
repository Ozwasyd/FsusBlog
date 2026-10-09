# Current property source and finite planner integration

Related to #3663, #2398, #2408, #2400 and #2410.

Actual tested source: `d855433f2c4cbb675b2544c5d67ff8c101164847`, branch
`codex/chain-3663-persisted-property-binding`. Later evidence commits do not
retarget this receipt. Restored environment actually ran SDK10.0.302 and the
repository data/cache wrapper. Verified master before work:
`be7c53d99b64342925ca63d061bacde34d22ba4c`.
Previous strict105-source candidate and571 controls at `7c3a95429` remain intact.

Consume only supplied canonical prerequisites919421b7,6f1f228d,92859e5b.
[All11 final kernel blobs](canonical-kernel-final-blobs.json) exactly match
`4eeb8ab3611574a51633cee07e25a1d7a87920e8`; no broad branch/adapter import.
The same reviewer supplied original-project7select/61adapter/3refusal evidence;
that peer evidence is not this task's runtime receipt or inherited admission.

`ArticlePackageCurrentPropertyReader.ReadAndMapAsync` now calls the actual sole
`IArticlePropertyValueAuthority.ReadAsync` port. No caller snapshot is accepted
as persisted input. Exact owner/site/article/revision/property revision and
publication coordinates, immutable rows/content digest, snapshot/factset IDs
and snapshot audit identity/chain/hash bind the existing sole v1 codec/mapper.
Audit provenance stays backend-only and is absent from portable property JSON.
No schema, wire registry, production provider or writer is duplicated.

Current definitions are canonical content/owner/type checked. Signed historical
row schema/digest and default/presence/value spelling stay unchanged. Current
definition epoch/digest/status observations are held separately, so inactive
historical selections can survive current schema movement without receiving
new-value/import permission. Actual current-definition and reconciliation
movement are checked alongside audit/source identity on a second authorized
read. Permission revocation and cancellation propagate from the original port.
These rechecks are not an atomic export or group transaction fence.

The existing finite planner now has
`ReadCurrentPropertiesAndCreateCandidatePlanAsync`. It replaces asserted
property snapshots with observed rows, reuses its original projection and
aggregate checks, checks article/raw-byte budgets before reads, and checks
observed prefixes before continuing. Failure returns neither a partial plan
nor partial source projections. Other supplied metadata/source bytes remain
candidates; `RequirePropertyAuthority` and `RequirePackageAuthority` refuse.
Missing heads are not synthesized. Drafts and nonempty references are refused
until their exact original authorities supply operation-bound source facts.

Actual current component proof:110 whole source files from the single tested
candidate; locked audit-enabled restore, strict compile with0warnings/0errors,
five-file positive-scope source style and commit range all exited0.
[Current report](final-report.json) records617/617 passed,0failed/skipped:
original571 plus46new source-port/history/planner controls. All43original
foundation controls and the1000-definition/order/value/zero-write assertions
remain intact. Controlled read ports and their handwritten data are unit
fixtures, not actual DB, live permission or signed-audit receipts.

The617 union first failed35foundation controls after the canonical validator
moved to GetManyAsync; old NSubstitute fixtures only configured GetAsync.
A minimal fixture delegation preserves every per-case getter override and the
canonical HoldIds guard. The separate1000-definition fixture was then adapted
without deleting or weakening any assertion. Failures582/35 and616/1 plus the
final617/0 TRXs are retained. Initial own test UUID namespace setup and one
async fixture compilation error are also captured. Intermediate receipts stay
bound to their actual source heads; no failed result is converted to a pass.

An exploratory whole-file persistence harness lacked original audit/template
closure and failed19dependency diagnostics. No stub was added. The final
110-file proof covers the actual reader/mapper/planner/contracts and original
finite controls, not the SQL persistence graph or canonical storage test.
The complete11kernel source blobs and supplied original-project evidence are
separate. Original Backend/native/provider/full matrix and independent runtime
acceptance remain HOLD. Original held audits/matrices were not rerun.
Docs lint still reports the identical26baseline diagnostics, unwaived.

[Precise existing signatures and producer requests](supplier-input-requirements.json)
retain all13V1 fields and the package-only historical metadata gaps. The API
and current source bridge are present; do not call the whole property API absent.
Original ArticleService reader implementation/production registration/schema/
audit dependency identity and isolated runtime evidence remain to be consumed.
Authorized selected historical/draft modes, a permission-bearing reference
context and exact target revision/lifecycle/operation facts remain separate
requests. The existing reference RequireAllowedAsync port returns no target
coordinates; a caller allowed flag or synthetic Actor permissions is refused.
No guessed ReadExactAsync endpoint, slug, asset rights or persisted facts.

Full accepted package root/version registry/privacy/decode-bind integration
remains owned and unfinished. Complete original Base/Local/Server V1 manifests
and PropertiesSha256 are not interchangeable with this component digest.
Canonical slug/route/historical rights, asset ledger/rights/retention and actual
frozen graph/publication/materializer inputs remain required.

[All16 current issue states](all-issue-status.json) stay OPEN; none is accepted.
Current bodies/comments were reread and all16body hashes remain unchanged.
There are no tracking assignments.

| Issue | Status |
| --- | --- |
| #3663 | Trust source merged; original current runtime qualification HOLD |
| #2398 | Finite components/source bridge; full accepted root/registry unfinished |
| #2408 | Same sole schema; full original acceptance unfinished |
| #2400 | Finite writer plus current-property planner source; full export/runtime HOLD |
| #2402 | Finite byte/ZIP validator; full formal preflight HOLD |
| #2404 | Waiting accepted preflight/current resolution authorities |
| #2405 | Waiting accepted plan/atomic executor/rollback |
| #2406 | Waiting accepted capabilities and product runtime |
| #2407 | Waiting accepted replacement; no legacy retirement |
| #2410 | Same sole exporter; full export/runtime HOLD |
| #2411 | Same sole validator; full formal preflight HOLD |
| #2413 | Waiting accepted validator/current resolver |
| #2415 | Waiting accepted plan/atomic executor/recovery |
| #2418 | Waiting accepted product capabilities and #1853 |
| #2409 | Terminal whole-chain runtime/mutation/performance acceptance HOLD |
| #2420 | Same terminal union; no completion from finite controls |

API content writes remain paused by the coordinating parent. Existing
[draft PR4012](https://github.com/Ozwasyd/FsusBlog/pull/4012) stays frozen at
`569518458ad4aa27cbc885417121a2e04cb74254`; no new PR was created.
Frozen exporter branch8472 is preserved. No master push, merge, issue close,
auto-merge, production migration, shared lock regeneration, audit suppression,
deployment or cross-chain conflict resolution occurred.

The captured harness has actual task paths. For a separate reproduction,
copy it outside the repository, rebind its input prefix to the exact tested
checkout, preserve its locked packages/editorconfig/build props and recorded
SqlSugar dependency, then run the original command records with SDK10.0.302
and disposable data/cache roots. A path rebind is not another execution receipt.
