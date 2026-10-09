# Typed System candidate and callback prerequisite handoff

Current source `08dbbac2bb522ca7f6b2433c02acbb60490149f0` is published on
`codex/chain-3582-authenticated-review-transport-20261009`, source parent
`5e0869545ddff7301b4341091d12be6a56129ee2`. This supersedes the earlier claim
that a typed installation identity API is absent. API existence and runtime
source qualification are separate facts.

## Actual typed API consumed, runtime authority withheld

Consumed from exact supplied `467857b3cc88aaa2916159552c24088f6f9910b8`, byte-identical:

- `src/backend/Interfaces/ISystemSiteIdentityReader.cs`
- `src/backend/Models/ReadModels/SystemSiteIdentityContracts.cs`

No `SystemService.SiteIdentity.cs`, configuration writer, lifecycle implementation,
final #3735 scoped alias, mother tree or registration policy was imported. The
coordinator reported actual offline-import lifecycle-intent and fresh-bootstrap
seed defects in that supplier. Its current implementation is not independently
qualified and cannot become active runtime authority in this consumer.

The root's new `ArticleVaultInstallationSiteIdentityCandidateReader.ReadCandidateAsync`
calls original `ReadCurrentSiteIdentityAsync(CancellationToken)` on every read.
It checks Current, canonical opaque ID shape, exact lifecycle/generation/mapping
coordinates and exact approved scope/revision. Absent, MigrationRequired,
Ambiguous, Malformed, UnsupportedVersion and unknown states refuse. URL/legacy
Vault-site fallback, normalization, caching, provisioning and config writes are
absent. Storage/cancellation errors propagate. Returned canonical typed data is
only an unqualified candidate, not an execution or trusted-site grant.

Root-owned explicit `AddFsusArticleVaultInstallationSiteIdentityCandidates` requires
an already registered original reader, refuses duplicates/missing registration and
installs only that scoped candidate consumer. It does not install a SystemService
alias, conflict/history reader, recovery stage or active runtime trusted-site binding.
The original System owner retains alias and lifecycle integration. Once the parent
supplies exact corrected source and independent evidence, root can consume it and
wire the **actual approved mapping coordinates**, without minting another identity.

Frozen original backend build exits 0, 1,507 retained warnings, zero errors; a new
local-constant naming warning from the first build was corrected. Exact nonempty
VSTest discovery selected 30 methods/72 cases: new typed candidate controls 35,
original execution/compiled owner 37. Execution passes 72/72 with no skips.
Five-file C# style, document lifecycle/authority and direct original source scanner
(two test files, zero findings) pass. The typed port is controlled NSubstitute data,
not real SystemService storage/lifecycle acceptance. No DB/native/browser/held audit
was executed for this preparation. Previous PostgreSQL2/frontend27/host78 results
remain bound to source `0df1a63682e8e357b397dc1d19cbee30fdc94ef9` and are not new passes
at 08dbbac. All issue acceptance remains open.

## b98 supplied callback increment: NOT consumed

Requested supplier `b98e179b0c0ac6c1f85790fcce3bd918a3aa6cdc` was fetched by exact SHA.
Its actual parent is `952300d5b9b6303d5dc7202cbd66e3aaa0bdf67e`. The supplied patch
changes exactly five ArticleService files; the exact patch and source comparison
are archived. `git apply --check` exits 1 and changes no files.

The following two hunks fail against root source parent 5e0869545:

- `ArticleService.LifecycleAndReadModels.cs:85`
- `ArticleService.Mutations.cs:507`

The supplier parent has additional source-generation/outbox/caller-cancellation
prerequisites in those files that root does not contain. Root also lacks the
`ArticleSourceGenerationAuthority` type and nested
`ArticleCreateMutationAuthority.CallerCancellationScope` referenced by b98.
The two Vault callback files and `ArticleService.cs` do match the exact supplier
parent, but applying that subset would neither consume the complete increment nor
supply its prerequisites, so no subset was applied or tested. All five files remain
unchanged in this increment.

Smallest coordinator handoff: provide the precise reviewed prior #3654
source-generation/cancellation/outbox prerequisite commits and their scope/evidence,
or have its sole owner publish a root-compatible bounded increment. The archived
context diff identifies the required differences; it is diagnostic only and must
not be applied as a mother-tree replacement. Root will then recheck the exact
patch/compilation and applicable original controls. Cross-chain conflict resolution
is paused under the global barrier. Supplier-reported 6PG results are not inherited.
Complete portable lineage remains original #3654 work, not root qualification.

## Remaining independent integration

Current-input acquisition and canonical current-review AEDS contracts remain real
missing capabilities, as detailed in the preceding authenticated-read handoff.
The new typed API removes the **interface absence** from SiteIdentity's blocker:
remaining are corrected qualified lifecycle source, canonical final alias and
actual approved scope/version facts. Authentic editor operation refs and admitted
native host session bindings still require their canonical owners. No second
registry, writer, parser, dispatcher, fabricated current input or machine receipt
has been introduced. No PR/body/comment/label/ready/merge write or issue closure;
mother branch and PR3900 remain read-only. Accepted issues: zero.
