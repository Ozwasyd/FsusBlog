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
`e66650ec61b56af6e45bcb393b98cd648a3ccef8`. It preserves the original inventory
and its source-byte owner identities, then reports missing kinds using only
the closed schema vocabulary. It retains unresolved canonical role bindings,
scenario applicability and per-case blockers. Raw collector input fields,
route parameters and the declared anonymous actor cannot substitute for
canonical graph roles. This inspection is always blocked and unqualified;
it does not normalize an incomplete inventory into accepted `currentInputs`.

The original owner declares seven kinds across sixteen case IDs. In
particular, middle/last comment cursors and nested expansion declare
`pagination-order`; nested expansion explicitly does not establish a full
`public-thread`. Seventeen required kinds lack original owner declarations.
The earlier synthetic control mapping is not production coverage evidence.

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
