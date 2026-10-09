# Readonly candidate producer and transport handoff

This is a task input handoff, not an implemented API, admission receipt or accepted
product fixture. The inspected candidate is
`1767ca27ae78782ea3cf0d599a8149007b501683`. Neither complete schema nor native
qualification is a prerequisite for developing this bounded readonly module.
The existing planner continues to refuse execution.

## Module A: authenticated finite candidate producer

Implement the server application producer by composing the original
`ArticlePackageImportZipCandidateReader.TryReadCandidate`,
`ArticlePackageImportCandidatePlanner.TryCreatePlan` and
`ArticlePackageImportCandidateReviewProjection.TryProject`. Do not implement a
second reader, validator, planner, digest algorithm or authority registry.

Reserve these currently absent files for this module alone:

- `src/backend/Services/Authoring/ArticlePackageImportCandidateReviewProducer.cs`
- `tests/backend/Unit/ArticlePackageImportCandidateReviewProducerTests.cs`

Read `AGENTS.md`, `docs/security.md`, the three original implementations and
`ClaimsPrincipalExtensions.cs` before implementation. Preserve the six delivered
review contract/projection/component/test files. Do not alter their assertions,
the shared planner or admission guards.

The real request supplies the archive bytes, requested mode, caller policy and
permission-context digest assertions, caller UTC interval, explicit requested
target hints and bounded page coordinates. The client must not select the server
administrator or site. Use the authenticated request's positive `admin_id`,
`identity_kind == AnonymousIdentityRuntime.AdminPrincipalKind`, nonempty
`admin_sid` and original `HasAdminPermission(AdminPermissions.ArticleWrite)`.
Derive the administrator identity from that observed server identity, rather than
a client value. These claims are the existing authentication pipeline's output;
they do not create a fresh persisted per-target permission receipt.

One actual input remains missing: a server-owned stable `SiteIdentity` accepted
by `ArticleRelationContractValidator.Validate(ArticleRelationActorContext)`.
The only inspected server site owner resolves `SITE_BASEURL` to a trimmed URL in
`SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope`.
`IsContextIdentity` rejects `http`, `/`, `?`, `=`, `#`, whitespace and controls,
and requires a colon and length 3–160. No backend factory or authoritative
URL-to-stable-identity mapping was found. Property-definition `SiteScope` is also
a scope, not this stable identity. Obtain the canonical owner/API, exact supplied
commit and its server binding before writing this dependent implementation.
Do not use `site:primary`, the package's source site, a caller-selected site,
an invented config key, or a newly invented URL hash as a product identity.

After that input arrives, implement a stateless producer without business writes,
extraction, store-created plans or network calls. Preserve original refusal
reasons and cancellation semantics, and return no partial review on failure.
Use `TimeProvider` for actual projection time. Reobserve request owner, session,
permission claim and canonical site after the bounded pipeline; changed context
must refuse publication. Do not label this as an atomic or persisted permission
observation. Caller digests stay assertions and every result keeps the original
execution refusal and missing-authority list.

Use the original project/testhost for positive finite ZIP composition, original
digest equality, explicit update hints, bounded pages and repeat/cancellation
controls. Test unauthenticated/non-admin/missing session/permission, site drift,
invalid ZIP/policy/interval/page and context movement with no partial output.
Controlled claims and test sites are unit inputs, not live authentication or
production-site qualification. Existing internal
`ArticlePackageImportCandidateByteTests.CreatePackage` can supply finite bytes;
the official `ZipArchive` can write the test ZIP. Do not modify existing frozen
tests to manufacture admission. Discovery must positively match the selected
new test methods and cases before execution; no empty/full-suite fallback.

Publish a bounded source commit with a legal repository scope and `Refs: #2406`
or `Refs: #2418`. Report the source SHA, original build/test commands, case
counts, failures and acceptance limits. Leave both whole UX issues open.

## Module B: AEDS request/read transport

This module consumes Module A's exact supplied source commit. It does not take a
client-created plan as a server-owned read source and does not invent an upstream
API. An immediate stateless readonly page request can compose Module A; a later
read-by-plan-reference route additionally needs the actual owner/site/session
binding, retained candidate/plan source, lifetime/expiry and drift behavior.

Proposed exclusive new implementation paths, subject to the coordinator's file
allocation, are:

- `src/shared/Contracts/ArticlePackages/ArticlePackageCandidateReviewRequest.cs`
- `src/backend/Modules/Endpoints/AuthoringEndpoints.ArticlePackageCandidateReviewRoutes.cs`
- `src/frontend/src/api/articlePackageCandidateReview.ts`
- `tests/backend/Unit/ArticlePackageCandidateReviewTransportTests.cs`
- `tests/frontend/unit/api/articlePackageCandidateReview.test.ts`

Use the real `/api/binary/author` route owner, specific AEDS v2 request/response
frames, original authorization/PoW/header/error semantics and `IAedsEncoder` /
`AedsJsonResults` helpers. JSON inside an original typed AEDS frame is distinct
from an HTTP JSON fallback; do not add that fallback or reuse an unrelated frame.
The authoritative frame source is
`src/shared/Contracts/Validation/aeds-protocol.json`; generated enum/TS/POD/C++
surfaces must be changed only through its original producer. No candidate-review
frame or route currently exists. Request allocation of this shared source and
the original route registration/dispatch edits from their canonical owner before
editing them; never guess/reserve numeric IDs independently. Obtain the actual
#1853 API/boundary evidence from its owner where this UI consumer depends on it.

The original authoring request helper caps its complete request at 1 MiB; the
finite ZIP reader permits up to 128 MiB and 64 MiB expanded finite bytes. Define
an honestly bounded wire input with the original owner. Do not silently enlarge
the shared helper, claim full large-asset intake from a small preview transport,
invent an upload receipt, or read a client path. Larger intake requires a real
isolated source/upload owner and its authorization/cleanup evidence.

Verify original frame golden/parity controls, malformed/wrong frame, wrong
owner/site, expired reference if present, bounded request/response, cancellation
and no private source/title exposure. Keep the original review component as the
consumer; do not add a browser ZIP parser, second package state, mapping or
execute action. Current native/browser/production UX and whole-package admission
remain separate, explicitly unaccepted gates; they are not blanket prerequisites
for developing the bounded readonly transport.

## Shared migration gate request

The original generators preserve exactly 226 inventory entries, their complete
semantics/IDs/order and seven non-matrix source digests. The original migration
validator and test still demand 225. Normal matrix planning and the original
two-test migration file reproduce this contradiction. Request the canonical
migration owner's exact commit and admission evidence for the intended complete
producer set. Do not remove an entry, edit the gate constant/test expectations or
hand-fill publication binding to obtain a pass. No named external issue owner
for this newly reached gate has been inferred.
