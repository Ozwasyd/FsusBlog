# Inactive package candidate read handoff

Source candidate: `b38c5017d80e7ca130a7457ce082cb8e3c4b45b7`.

The three package-owned files add a typed request/response and an inactive
`ArticlePackageCandidateReviewReadService`. They call the actual original
`ArticlePackageImportCandidateReviewProducer`; no package schema, digest,
planner, receipt, identity store, initializer or execution authority is replaced.
Only the two canonical reader declaration files from
`467857b3cc88aaa2916159552c24088f6f9910b8` are consumed. Canonical storage,
lifecycle, owner tests and DI remain at their sole owner and unqualified here.

The service checks the actual authenticated admin principal, session and
`article.write`, uses the original admin identity helper, and reads
`ISystemSiteIdentityReader.ReadCurrentSiteIdentityAsync`. Only `Current` with
lifecycle 1, bounded generation/mapping revisions, and exactly one scope equal
to raw server `SITE_BASEURL` is accepted. No normalization or scope fallback is
permitted. Generation, mapping and selected scope revisions survive into the
readonly context echo and must remain equal on the final reader observation.
The same actual HTTP context, admin ID, session and configured scope are checked
again. Reader failures propagate; cancellation produces no successful review.

The request has no actor, session, server scope or lifecycle mutation input.
`CallerPolicyDigest`, `CallerPermissionContextDigest`, interval and target hints
remain caller assertions processed by the original validator/planner. Positive
Int64 expected revisions use canonical decimal strings; the original portable
identity codec parses the portable article. Actual target permission authority
and mutation are still unavailable. The original projection always disables
execution and says why. This is a small finite stateless preview profile, not
complete archive, migration, mutation, durable plan or full-size admission.

The proposed transport must use an owner-allocated closed request/response AEDS
v2 pair. Bind the DTOs through the existing authoring typed JSON-byte frame
helper and original unified ApiError envelope, security/PoW/rate-limit boundary
and authentication policy. Enforce the existing 1 MiB complete framed request
limit before decoding, including unknown-length bodies. Decoded ZIP bytes are
limited to 512 KiB. Never parse source in the browser or return ZIP/source/title,
session, actor, server scope, full scope list, permission verdict or credentials.
Do not log request or response bodies. No legacy HTTP JSON endpoint or generic
frame substitution is permitted. RequestAborted must reach ReadAsync and the
canonical reader/producer; response cancellation must use the original helper.
This source does not add or register that transport.

`RequestId` is an opaque bounded correlation value, not a grant. A seed read is
page zero with no expectations. Subsequent reads replay the same original ZIP,
intent and hints and echo both original PlanDigest and observed context
coordinates. A mismatch refuses the read; the server does not silently replace
them. The context echo is not signed, a durable plan reference, a token or an
execution capability. Frontend transport must verify RequestId and expected
original digest/coordinates before handing the original Review to the supplied
controller, retain context only for this read sequence, abort on context change,
and reject late responses. The controller is not a source parser or executor.

`root-3735-di-proposal.patch` contains only two unapplied DI lines at the shared
owner file. It requires the qualified canonical SystemService implementation;
this branch intentionally contains only the reader declarations. No frame IDs
or route path have been invented. Root #3735 must allocate and prove the
complete closed pair across existing ABI owners before activation. No shared
registry/DI source was edited.

Frontend commit `3335910dee5e67e446167ec3b3d875912a908709` cannot be consumed
against the currently frozen six-file baseline. Its three existing dependencies
have different blobs; revised exact source/evidence must be supplied by the
parent. Neither controlled consumer tests nor another chain's tests qualify the
canonical storage or real UI/product flow.
