# Expected query catalog validation

The [closed schema](../../config/schemas/expected-query-case-catalog.schema.json)
and [validator](expected-query-case-catalog.mjs) define test/evidence-only query
metadata. They do not generate expected cases or execute product queries. The
existing [query registry](query-case-registry.mjs) owns case IDs; this module
imports its `queryCaseIds` without maintaining another ID list or runner.

## Validation boundary

`validateExpectedQueryCaseCatalog(catalog, currentInputs)` accepts a catalog and
independent current owner projections. Both are closed JSON-schema inputs.
`currentInputs` is this validator's normalized intake contract, not an existing
graph/distribution exporter API. A caller must obtain those projections from
the canonical owners; absent capabilities cannot be replaced by DB discoveries,
actual query outputs, copied expected values or hand-written fallback facts.

The current intake requires:

- `authorityRefs`: exact article graph, comment graph, distribution catalog,
  assignment and statistics content references;
- `queryOwners`: each canonical case's production owner/version, semantic kind,
  input roles, actor, expected schema, order/permission/visibility policies and
  scenario applicability;
- `inputRoles`: canonical role IDs with authority, domain and value type;
- `scenarios`: canonical scenario/assignment/statistics references and explicit
  uniform/non-uniform classification.

The validator compares supplied current metadata. Obtaining and verifying its
physical provenance remains the canonical exporter/consumer owner's job. This
module does not establish that an arbitrary caller-supplied projection came
from production, a real graph or measured database statistics.

`expectedQueryCatalogDigest(value)` excludes the object's own `contentDigest`
and uses the existing canonical JSON SHA-256 owner. Seal each declarative case
before sealing the catalog. `schemaDigest` and the registry reference bind the
exact local schema and registry bytes. Changing schema, catalog, case, query
owner, graph, assignment or statistics identities invalidates their bindings.
Future expected artifacts must reference the catalog/case/schema digests; their
equality admission belongs to the existing runner/verifier integration.

Validation rejects unknown, duplicate or missing IDs; missing semantic kinds;
stale identities; owner/input/schema mismatch; ambiguous roles, parameters or
scenarios; omitted explicit tie-breakers; uniform-only applicability; and
content tampering. A schema-valid declaration alone cannot qualify coverage.
Unknown SQL/title/DB-ID/actual-output fields are rejected by the closed schema.
Parameters describe canonical roles, rather than embedding query input values.

The article/comment expected definitions describe ordered semantic identities,
counts, pagination/cursor facts, statuses, source/publication/revision/edge
coordinates, visibility, permissions and digests. Comment items also declare
parent/root/depth/deleted-placeholder facts. They are structural contracts;
semantic comparison, sharding, bounded generation and artifact verification
still require the original producers and runner owners.

## Checks

Install the existing locked schema validator dependency without lifecycle
scripts, then run the dedicated controls and original registry regression:

```sh
npm ci --ignore-scripts --prefix tools/test-matrix/schema-validator
node --test tests/tools/expected-query-case-catalog.test.mjs
node --test tests/tools/data-scale-query-matrix.test.mjs
```

Use an owned writable npm cache when the environment's default cache is not
writable. The tests use explicitly synthetic metadata to exercise validation;
they produce no seed, query, runtime, browser, device or qualification receipt.

`scanExpectedQueryProductionIsolation()` inspects production source for catalog
schema/parser/path/environment references and rejects unobservable symlink
sources. Its result is a static reference control. Runtime reads, package
contents, indirect imports and compiled assembly isolation still need separate
actual acceptance through the existing owners.

## Canonical distribution consumption

`inspectExpectedQueryScenarioApplicability(applicability)` directly consumes
the original [distribution inspector](distribution-query-binding.mjs) with
the original query registry's IDs. Callers supply explicit owner applicability;
this module never infers it from query names or maintains another case/scenario
table. Missing intake and the current catalog's unresolved capabilities remain
blocked. Non-uniform policy eligibility does not grant qualification.
Noncanonical or lossy JavaScript applicability inputs retain the original
serializer's exceptions; this seam does not swallow them into a successful
report.

The catalog, contract, inspector and their original catalog/query controls are
consumed from actual integrated master
`aaba7b8c84ecfb336c71443e30d9fd82d21fb16d`, where PR #4021 merged the distribution
owner's content-shape digest refusal. These files match the revised original
source `fbf689f71fd864fceb9c8432defa8fee224e1626` byte-for-byte. The earlier
`f5abc68cb455ceff9d23e025cba1b617b3a7e567` consumption is historical. The source catalog is recomputed from
the integrated checkout's actual content/media/temporal/article/variant
authority bytes and validated there. Its eight unavailable capabilities are
preserved. No assignment compiler, actual DB statistics reader, scenario
receipt or query-runner admission is supplied by this seam.

## Canonical query inventory consumption

`inspectExpectedQueryOwnerInventory(binding)` calls the original
`buildQueryCaseInventory(binding)` from published query owner source
`143f9176eea697b7687c3e5e842b64ca6f15674c`. It preserves the original inventory
and its source-byte owner identities, then reports missing kinds using only
the closed schema vocabulary. It retains unresolved canonical role bindings,
scenario applicability and per-case blockers. Raw collector input fields,
route parameters and the declared anonymous actor cannot substitute for
canonical graph roles. This inspection is always blocked and unqualified;
it does not normalize an incomplete inventory into accepted `currentInputs`.

The same inspector directly consumes the original
`buildQuerySemanticOwnerInventory({ binding, kinds })`, passing only the sole
closed schema vocabulary. Its returned `semanticOwners` retain the original
business-owner source refs, exact current-byte digests, entrypoints, signature
parameter types, actor constraints and routes. Their query-inventory digest
must equal the independently read original case inventory. All native
declaration blockers remain attributed to their domain and kind.

These are newly usable typed source declarations across all twenty-four kinds,
including the real publication-receipt/current-invocation verifier overload and
cache/AOT/HotRead readers. The original AOT article route is
`/article/{articleId}`, with its original route-identity owner. Declaration
availability does not add executed cases or supply missing producer inputs.
Original `inputs`, `canonicalRoleBindings` and `scenarioApplicability` stay
null. No receipts, coordinates or normalized graph roles are manufactured.

The current original declarations retain 85 source references across 19 source
files. Full public thread reads include roots, children, permalink context and
replies. Deleted-root and deleted-reply requirements keep their distinct read
boundaries. Pending/rejected/hidden visibility retain public, moderation queue,
attributable actor and projection owners. Region resolution/normalization and
the admin permission route remain explicit original authorities. None of these
source declarations supplies actual final moderation or visibility facts.

Consistency intake still needs actual same-run/business-epoch publication and
revision/content coordinates plus cache/AOT/HotRead generation and bytes.
The existing outer public-content source/run identity and temporal observation
must be retained by the original runner. No-hit and search-ranking authorities
remain missing; source-version/extractor repair belongs to that runner owner.

The original case inventory declares seven kinds across sixteen case IDs. In
particular, middle/last comment cursors and nested expansion declare
`pagination-order`; nested expansion explicitly does not establish a full
`public-thread`. Seventeen required kinds still lack case mappings, while
source owner declarations cover all twenty-four kinds.
The earlier synthetic control mapping is not production coverage evidence.

## Native producer role intake

The test/evidence-only
[typed consumer](query-producer-role-intake/QueryProducerRoleIntake.cs) connects
the actual `ArticleScaleGraphIdentityBindings` from #2542 source
`21a20129b3127fdcfb6f34bff7f80b1ef8b5f239` and
`CommentScaleResolvedGraphIntent` from #2545 source
`8822207ec995f4346eed20f27393b172dd51343a`. It compares article plan digest,
semantic article role, original native reference schema/digest and the native
article coordinate. It retains the original objects and inspects one occurrence
without materializing the complete scale plan. It creates no serialized receipt,
expected values, role registry or query runner.

`Inspect(articleBindings, commentIntent)` always returns blocked admission.
Article allocation bindings explicitly lack physical allocation provenance;
comment intents contain symbolic parent/reply requests and planned moderation,
without actual comment IDs or final thread/status/visibility coordinates. The
existing bulk transport result proves neither complete graph admission nor
its query business-epoch binding. Reference equality, an empty comment
occurrence or a committed row count cannot waive those missing capabilities.

`ThrowBeforeQueryExecution()` refuses even if a caller clears the diagnostic
list. The original runner owner must place this call before expected mapping
and query capture, alongside its original receipt/current-invocation checks.
The current shared runner does not call it yet; this split does not edit that
owner's file or claim execution isolation from an unconnected component.
Replacing this unconditional refusal requires the original producers' actual
sealed physical receipt admission APIs and exact query coordinates. An invented
callback, receipt shape or caller-supplied ID map is not an admission substitute.

The [compiled refusal controls](query-producer-role-intake/check.sh) archive the
complete exact writer backend and overlay nine exact comment-owned source files
from the original comment commit. This is a composite source integration; its
manifest identifies both original sources and all local controls. The writer's
identity binding is compiled once from its backend. The internal native APIs
are accessed using the existing `FsusBlog.Server.Tests` friend assembly grant;
no production access declaration or security setting changes. No producer
object, native ID, digest, key or receipt is fabricated by these controls.
The output proves typed source linkage and missing-input refusal only; actual
producer linkage cases, physical acceptance, production queries and 1M
qualification remain unrun.

```sh
bash tools/data-scale/query-producer-role-intake/check.sh --help
```

## Canonical PostgreSQL producer consumption

The [PostgreSQL intake](query-producer-role-intake/QueryPostgresProducerIntake.cs)
consumes the actual source-level `DataScalePostgresArticleProduction`,
`ArticleScaleResolvedGraphBatch` and `DataScaleBatchCheckpointIdentity` from
writer commit `21a20129b3127fdcfb6f34bff7f80b1ef8b5f239`. These APIs exist and are
used directly; missing runtime artifacts do not erase their source capability.
The producer and checkpoint types are internal to the native backend, so this
consumer remains inside test/evidence compilation until the original owner
provides an appropriate external handoff.

The intake requires an actual resolved batch explicitly. It compares the
original whole-plan coverage's plan binding, bounded batch ordinal roster,
native allocation role/ID map and production graph digests. Role requirements
and shared-content aliases come only from
`CanonicalArticleGraphFactory.DescribeNativeRoles`. Every original alias group
must retain one allocated ID; no global ID uniqueness rule replaces that owner.
Resealing calls the same
factory's native-binding/resolved-input overload; no second generator or
ordinal-derived ID is introduced. An actual open PostgreSQL connection supplies
the original authority's current database identity. The original checkpoint
validator authenticates the exact independently supplied current identity and
committed stage; its first failure propagates without retry or normalization.
No SQL is executed by this consumer.

The current source also binds the original frozen physical batch's digest to
the authenticated checkpoint. The original v2 digest includes composite
primary keys, complete owned row scopes and external taxonomy references.
`DataScaleArticleTaxonomyProjection.Attach` adds current ArticleTag links to
the canonical physical batch. The original writer persists them, and its
readback verifies link scopes and referenced categories/tags.
The intake does not duplicate that reader or turn an authenticated batch into
complete seed acceptance.

Successful component matching still cannot execute queries. The current
checkpoint binds run/runtime/source/namespace/provider/database, plan/batch,
graph/native-binding/physical/key-roster digests. It does not bind query
business epoch, fixture generation, seed receipt or assignment coverage digest.
Complete whole-plan assignment coverage also does not prove that every batch
was physically materialized. Native allocation persistence has a real awaited
callback but no returned durable admission receipt. Signed audit and complete
seed acceptance remain separate, and `CompleteSeedAccepted` remains false.

`DataScalePublicationRequestBinding.BindAsync` is now a real native API: it
joins an actual publication result to native factory roles and delegates to
the original writer/current-invocation verifiers. The producer creates no
publication result. The remaining publication blocker is the actual result
and current invocation, not absence of a binding API. This component neither
manufactures those values nor replaces that verifier.

The original runner still must hook both intake boundaries before expected
mapping/capture and retain its independent query source/run/epoch/seed binding.
The current native MySQL/SQLite staging API uses existing native-PK tables with
role-to-actual-ID mapping, exact readback/savepoint rollback, enabled foreign
keys and trigger/shadow-table refusal. The earlier allocation-owner schema
incompatibility is an adapter gap, not a product schema migration requirement.
That staging API excludes PostgreSQL and is not imported by this PostgreSQL
consumer. Its original provider controls are not this intake's receipt.

Final comment coordinates, whole-plan physical receipt, signed audit/full seed
acceptance and scale qualification remain unaccepted. These specific artifact
gaps do not prevent compiling and consuming the current source components.
The saved development PostgreSQL service is available infrastructure; no
actual resolved producer bundle, current identity, task authentication key or
persisted allocation/checkpoint artifacts were found. Consequently the ordinary
nonempty intake path remains unrun, rather than populated with diagnostic
factory defaults or test receipt values.

## Current integration limits

The actual canonical registry has 16 query IDs, while the closed schema requires
24 article/comment semantic kinds. Top/prev-next/negative search/derived
consistency and full-thread/moderation/visibility/region/actor/permission/deleted-thread
coverage are incomplete. The validator preserves these failures; no complete
catalog artifact is checked in. The original owner inventory is available;
its closed canonical role/scenario projection and complete
comment/assignment/actual-statistics intake are not connected to this
module. The source distribution inspector above is a real bounded component,
and its blocked report is preserved rather than promoted to qualification.

The current [article expected exporter](query-plan-collector/CanonicalQueryExpectedArticles.cs)
remains the original producer. It is not replaced here. Article/comment
generation, generated-artifact binding, full production isolation, 100k/1M
resource checks and legacy retirement remain unaccepted. The exact canonical
query owner must supply shared registry/runner changes. Shared matrix,
documentation and lifecycle integration must also be performed by their
original owners. None of these gaps can be treated as a successful product
qualification.

Rollback removes this module, schema, dedicated controls and module-local
documentation together. No product data, wire protocol, query implementation,
threshold, original registry, seed or production configuration changes.
To roll back only this consumer follow-up, remove its inspector exports/imports,
dedicated intake tests and follow-up metadata/documentation while preserving
the base catalog/schema/validator from PR #4011 and the master-owned
distribution source/control files.
