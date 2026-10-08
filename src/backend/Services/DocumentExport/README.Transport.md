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
