# Document Export transport composition

The transport consumes the registered Shared Document Export request, task request,
job response and page response roots. POD decoding and its per-root frame/payload
bounds remain in the canonical codec; this module defines no parallel wire codec.
The existing ApiError frame carries uniform source-free denial.

`DocumentExportRequestFreezer` owns request admission through the closed export
catalog. It checks the original live `IDocumentExportJobAuthorization` before
reading and before return, captures and validates the complete source-facts seal,
owns every retained buffer, and constructs the canonical sealed input/task.
Input/task identities are stable for the exact owner, source-facts seal and
request/options. Repeated admission therefore reaches the sole jobs' existing
idempotency fence without a second identity allocator, task store or worker.
Changed source facts or options cannot impersonate the original admission.
The original non-null frozen-embed materializer refusal remains intact.

`IDocumentExportFrozenSourceReader` is a mandatory host port with no default
implementation. A real implementation must supply these independently verified
persisted facts for the exact principal, formal SiteScope and source coordinate:

- Exact Markdown UTF-8 bytes and the export-domain source digest, without reading
  a newer draft/revision/publication. Draft source version and persisted document
  epoch must be checked by the original authoring authority.
- Complete metadata and property snapshots and their original export-domain
  seals. Compare-package digests have different domains and cannot be converted
  merely by adding a `sha256:` prefix or replacing the expected digest.
- Every retained image/font byte with its identity, MIME, role, caption and font
  tuple, plus canonical asset/font manifest seals. All required local reading
  fonts must be present; URLs and host fonts do not supply these facts.
- The actual canonical renderer identity, version and independently bound build
  digest. A provider/catalog name alone is not an executable/build receipt.
- Original parser-confirmed absence of embeds, or the complete authorized retained
  publication plan, host mapping, projections, codec and retention evidence. The
  already-published embed bridge is not a complete source reader or materializer.
- A stable full facts seal and a second live permission check before admission.

`DocumentExportHttpJobAuthorization` consumes the existing SQL-backed
`IAuthorRecentArticleHistoryPermissionProjectionProvider` for each HTTP operation.
It binds the actor to the actual admin principal/session and verifies the returned
owner, current status, single exact article decision and original permission seal.
It performs no second SQL query or digest-domain conversion. Without an original
authenticated HTTP context it denies worker access. This adapter has not been
qualified against a real database/session merely by controlled source tests.

`AuthorRecentArticleHistoryPersistedPermissionReader` is the shared scoped reader
for the original principal/session/article SQL facts and permission digest. The
existing `SqlAuthorRecentArticleHistoryPermissionAuthority` preserves its HTTP
principal/session/site admission and delegates those facts to this reader.
`DocumentExportSessionJobAuthorization` uses the same reader for each HTTP or
worker operation. HTTP still requires the actual admitted admin context; worker
operations use the stored actor/session and recheck live persisted expiry,
revocation, principal status, permissions and article lifecycle. This source path
does not itself qualify real PostgreSQL/session behavior or a worker execution.

The available `IRevisionComparePackageReader` exposes Markdown and comparison
metadata/snapshots, but does not supply the complete export property/asset/font
closure or renderer build. Its current backend authority requires literal
`primary`; the export endpoint uses the formal configured SiteScope. Export does
not rewrite that upstream permission contract or invent a numeric/URI alias.
Publication-specific full-source and retained-embed facts are likewise required.

After the host supplies one scoped real source reader and one scoped original
live job authorization, `AddDocumentExportTransport` registers the sole concrete
`DocumentExportJobService`, freezer and endpoint binding. Missing or duplicated
authorities refuse composition. Storage/data protection, binary request context
and AEDS encoder retain their original host registrations.
`MapDocumentExportEndpoints` checks the required registrations before mapping the
existing seven admin-protected routes with their original PoW requirements and
Binary-POD route metadata. The general bootstrap does not call either entry while
the real source/permission ports are unavailable. No HTTP/private download or
provider/native acceptance is inferred from these registrations or controlled tests.

For HTTP composition, `AddDocumentExportHttpTransport` consumes an already
registered scoped full source reader, the original scoped recent-article permission
projection and the original singleton HTTP context accessor. It registers the
existing `DocumentExportHttpJobAuthorization` and then the same transport/Jobs
composition. Missing or duplicate authorities refuse before registrations change.
`AddDocumentExportSessionTransport` additionally requires the single scoped
persisted permission reader and binds `DocumentExportSessionJobAuthorization`
before composing the same transport and sole Jobs implementation. The original
runtime-domain bootstrap registers the shared reader for the existing recent
article authority; it does not activate either export entry or launch a worker.
The three explicit transport entries do not supply full source facts or activate
routes. Repeated HTTP/session composition refuses before registrations change.
Authorities must be ordinary unkeyed registrations because the original transport
resolves them without a service key. A pre-existing concrete sole Jobs descriptor
may be reused only when it is unique, unkeyed and scoped; keyed, duplicate,
singleton or transient concrete registrations refuse before any transport alias
or HTTP authorization is added. This prevents a scoped alias from silently
capturing a longer-lived job service and its scoped live permission dependency.

The frontend typed consumer is imported exactly from its sole owner at
`4a55619a574e58ab17659ca9b2eb855d0b27e330`. The original Blob/anchor browser delivery
is bound by `createDocumentExportBrowserUiPort` to `deliverDocumentExportPrivate`;
it checks cancellation immediately
before dispatch and removes its link and private object URL on every exit. A
resolved delivery means browser dispatch only, not an operating-system file-save
receipt or a successful provider output. It does not fetch or expose grant URLs.
The original consumer performs response, private-generation and signal checks.

Catalog and source choices are still mandatory authenticated host projections.
`IDocumentExportSourceCatalog` now supplies private authorized choices and binds
their independent positive Int64 source versions to exact persisted draft,
revision or selected publication facts. Its random choice ID, database revision,
publication number and labels are distinct identities. Re-reading a changed draft
refuses an old binding; capturing the new facts allocates a new version. It uses
the existing SQL HTTP permission authority, which delegates to the canonical
persisted reader. The original direct SQL constructor remains compatible; the
production bootstrap explicitly injects its single scoped reader.

`AddDocumentExportSourceCatalog` requires the original scoped SQL client,
authoring lifecycle, persisted permission reader and SQL HTTP authority, plus
unkeyed singleton configuration/context. It registers only the scoped catalog
and its binding store, rejects missing/keyed/duplicate registrations before any
mutation, and performs no SQL or route activation. The schema SQL remains an
additive proposal for the original migration authority. The new entity enters
the existing managed model; that observation alone does not supply its required
unique/check/foreign-key constraints or an admitted migration receipt. The
original recipe extractor accepts `GENERATED BY DEFAULT AS IDENTITY`, while
this module requires `GENERATED ALWAYS AS IDENTITY`; no identity conversion,
alternate migration or weakened compatibility check is supplied here.

The bound domain source is private freezer input and must not be serialized to
UI. It does not supply the complete frozen export property/assets/fonts/renderer
closure, retained embeds, public choice wire contract or authenticated routes.
The backend catalog's `ImplementationAvailable` flag declares source capability;
it cannot be promoted to admitted native availability in a browser registry.
Existing `ServerDraftResponse` has `serverRevision` but no persisted document epoch
or export source-version authority; revision/detail/release responses likewise
lack the full export closure. Neither `serverRevision`, `revisionNo` nor a release
ID is silently substituted for the generated export `sourceVersion`. There is no
current authenticated export catalog/source projection wire route. Request
preparation, article navigation and route/bootstrap activation therefore remain
unbound until those original inputs are supplied.

The original binding exposes `FreezeDecodedRequestAsync(context, actor, request, ct)`
for an endpoint-level consumer that already read the existing request POD. It never
reads a frame; the original body-reading `FreezeRequestAsync` delegates to this same
handoff. Both paths retain cancellation checks and the exact frozen-request match.
Only known catalog source/capacity refusals become the original uniform job denial;
unrelated failures and cancellation propagate. No input is repaired or resealed.
An endpoint must choose one body reader: the original binding, or the forthcoming
private selection adapter returning the decoded request. It must never run both.
The adapter cannot be injected back into the binding's freezer/full source reader;
the full reader directly consumes the catalog with the actor already admitted.
This seam creates no public options response and does not activate a route or
supply the missing complete properties/assets/fonts/renderer source authority.

The request endpoint now resolves the scoped private source-selection adapter
inside its existing authenticated, no-store error wrapper. The adapter alone reads
the bounded original request frame and freshly checks the real catalog binding.
The endpoint requires its returned actor to equal the actor already admitted, then
passes the decoded request to `FreezeDecodedRequestAsync` before the sole job create
and original snapshot writer. It never calls the old frame reader on this path or
serializes the private bound source. Transport composition requires an explicit
single scoped catalog and binary request-context before adding any registrations,
and rejects existing adapter registrations. The full source reader remains a
mandatory separate authority directly consuming catalog facts; it must not depend
on the adapter. General bootstrap remains inactive without that complete reader.

## Persisted source choices

The explicit endpoint mapping now includes two authenticated ArticleWrite/PoW
POST operations: `/api/binary/document-export/sources/capture` and
`/api/binary/document-export/sources/revisions`. They read one original bounded
AEDS frame, resolve the original administrator/site/session, and call the real
catalog's transactional `CaptureAsync` or `CaptureRevisionsAsync`. Cancellation
is checked after decoding and after capture; original source/capacity refusal
uses the uniform no-store ApiError boundary. The reply uses only actual persisted
ChoiceId, Label and the complete independent-version coordinate, encoded once
by the sole Shared codec inside that boundary. No BoundSource is serialized.

The exact registered wire contract and budgets are maintained in
`docs/api/document-export-source-options.md`. This source integration consumes
the current-master Shared closure, not the older aggregate registry. Production
mapping still requires all real scoped authorities, including the full frozen
source reader; controlled endpoint tests do not qualify PostgreSQL, live session
or PoW, provider/native execution, or rendered UI.
