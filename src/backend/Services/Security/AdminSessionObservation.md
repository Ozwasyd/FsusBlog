# Original admin session validation observation source

The first reusable producer is AdminSessionProjection.Validate. It already returns
actual current session/principal versions, delivery generation and idle/absolute
expiry after readiness/principal/token/revocation/expiry checks. Original
AdminSessionValidationService.ValidateAsync reduces this to IsValid/Reason after
original touch scheduling; JwtHelper's authenticated-token path calls that original
interface. This increment exposes data from the same actual original owner without
changing that public validation/JWT/interface behavior. Existing service changes
only its partial modifier; original body is byte-unchanged.

CaptureCurrentSessionObservationAsync is internal. It requires an authenticated
admin principal and bounded exact session identity, runs the original validation/
touch path, checks unchanged identity, then directly revalidates the same original
projection and captures its actual result. The second real validation refuses a
touch callback/reentrant change; it is not an inference from the earlier bool.
Private state retains original principal object/admin/session identity and a private
SHA256 token hash, never the raw access token. No digest, epoch, expiry or default
permission is manufactured. Cancellation/errors propagate.

An opaque CurrentSessionObservation is retained in this validator instance's private
ConditionalWeakTable. IsCurrentSessionObservation refuses copies/fabricated objects,
other validators/principal objects and identity/session changes, then calls the same
actual projection and compares the exact original result including versions,
generation and deadlines. It schedules no additional touch. A newer version or
deadline is a different observation; expiry/revocation/not-ready/token mismatch
refuses through the original validator. Caller may obtain a fresh observation.

This is validation at the original projection's actual lock/read point, not a
revocation-exclusion lease or a promise about any future commit. Validation can
expire or revoke after the call. The original JWT signature/admission, original
projection authority delivery/readiness and final caller checks remain required.
No cookie/header/token producer, public endpoint/DTO, auth claim/permission setting,
validator interface, DI, native DB connection or transaction behavior is changed.
Raw observation data cannot grant article.write, lifecycle operation, whole-set,
site, document/editor/unsaved-state, native reservation or postcommit admission.

## Checked existing open owners, not assumed absent

- Exact c1900f2d64b7dcb4d71f9aa78fa93770161a6cf7 already provides real Inbox/
  PreviousEditableStatus and original PrepareEditableTransitionAsync/Commit. Its
  ActiveAdmin/article.write check is a genuine single-article check; use it rather
  than borrowing a projection permission for Restore.
- Auth PR3835 exact7fb66280c23bf7c6c0b8c7c6cc4b2167011a276b retains this same
  admin validator output reduction. Its user session authentication changes are
  not an existing Bulk session observation/native operation grant.
- Export PR4124 exact935dc8871af2b89a97fa3b4214821f70f37ef0c3 has a real
  AuthorRecentArticleHistoryPersistedPermissionReader. It rereads persisted
  principal/session/site/article facts, explicitly performs no HTTP token
  admission and rejects Archived/Deleted for its history decisions. That raw
  producer is real; its recent/export decision cannot be upgraded to lifecycle
  restore or a caller-owned native whole-set receipt.
- Capture PR4256 exact63b988c832249a32c65269c48e81e903e0db1c25 uses the original
  SQL recent permission reader with authenticated context, exact configured site
  and empty article set before/reply. Create-specific admission and historical
  receipt scope remain distinct from Bulk whole-set operation admission.
- IAuthoringCanonicalDocumentReadTransaction.ReadSnapshotAsync/IsCurrentSnapshot
  and IAuthoringDocumentRevisionGate are real original extension contracts. No
  article/editor/native transaction-bound implementation was found in inspected
  backend source. Frontend document/source owners are not a server DB lock/grant.

## Exact remaining original production queue

The original Bulk owner may consume this real session data, but must separately
bind actual actor/site/operation/dependency policy to its exact frozen set and same
native reservation. Original persisted principal permissions/site configuration
must come from their actual owners; this session result carries none of those
fields. Original Document/Write owner must supply article/draft/document/editor
revision, unsaved epoch and lock/lease/fence observation plus live revalidation in
that original native scope. IArticleBulkPreflightAuthority.ObserveAsync and group
authority remain unregistered/unavailable until the actual inputs exist. No
permission/lease/current-readiness receipt is fabricated by this source increment.

Ordinary AdminSessionObservationTests cover actual projection data, owner/object
identity, expiry/revocation, touch reentry and token mismatch; UNRUN and uncompiled.
Real auth/runtime/security/privacy/race/DB/native/test/discovery/import/qualification
and frozen generation/receipt/catalog workloads remain HOLD. Compilation/style is
SOURCE/STATIC only. Original #3735/#3736/#3738 remain WIP.
