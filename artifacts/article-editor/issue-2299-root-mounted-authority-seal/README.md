# Bounded Root/Layout mounted seal source offer

Refs #2299. Request: exact Main36d835088f310dd31d1e76ca240d5cc606dcbb65
original-producer-requests.json, Root/Layout section. Actual Layout base2f386.
Only original Write/Layout/context/outlet product files are changed here.

The same original primary physical port now exposes sealMountedAuthority,
hasMountedAuthorityCustody, cancelMountedAuthority, revokeBeforeChange,
revokeBeforeExternalRead and retireMountedAuthority. One exact issuer-local token
joins the actual successful physical tuple to an original producer reservation.
There is no new host/editor/session/registry/body/history model or index.
Pure has reads only private disposed/retired/sealing/failure/epoch/token/tuple
custody. It invokes no callback, DOM/ref, clock, allocation, clone or cell.read().

Private custody is revoked before producer cancellation callbacks and original
recovery/native/Layout reads. Sync ref/context/route/source watchers, before-update,
DOM observer and pre-unmount paths invalidate the physical tuple. The document
observer sees root removal/reparenting; it inspects no outside content. Original
Root MUST call revokeBeforeChange before route-outlet/subtree/component/retained
identity changes and revokeBeforeExternalRead before resolver/native/source
callbacks. Startup cancellation MUST call retireMountedAuthority before the same
sessions.retire operation and original external cleanup. Retirement is permanent;
failed original reservation cancellation also refuses later authority.

Required concrete Root interface:

- Provide authoringWorkspaceMountedAuthoritySourcesKey with the actual original
  producer join, or null. reserve(sessionRef, ORIGINAL mounted runtime, native,
  revokeBeforeChange) must issue original Membership/Document/Writer/Principal
  private tokens and register the revoker at their PRIVATE pre-mutation boundary.
- Return only a genuine opaque reservation: original nativeEditor and retained
  identity, pure original private hasCustody join, and cancel of reservations only.
  Metadata, boolean/id/permission snapshots, reactive authGeneration, downstream
  lifetime listeners or always-true callbacks cannot implement this contract.
- Use the exact original signatures requested by Main36: Registry membership
  seal/has/cancel; Document lifetime seal/has/cancel; same mounted Writer
  seal/has/cancel; real auth principal seal/has/cancel. These APIs are requests,
  NOT declared present or implemented by this Layout interface.

No actual auth/membership provider is instantiated in this branch. Default source
is null, so seal returns null and has refuses. Physical completion, composition
admission or an id-only principal watch cannot supply missing authority. No real
installation, joint authority, full-ready, retention or resource receipt is claimed.

root-owner-only.patch is a separate exact three-file offer against original
bb9d2de4abc428ed1a64b8e2d9450506722efdaf. It pins the actual pre-revocation callback
in private view/resources, revokes before external invalidation/route/unmount
callbacks, and changes the original Frame lifecycle caller from direct Main retire
to same sessions.retire(). Original Root must bind beforeMountedAuthorityChange
to the actual mounted owner; no no-op provider is supplied. The actual caller is
src/frontend/src/layouts/AdminWorkspaceFrame.vue. Root product files are NOT
overwritten. Parent reports bounded bb9 session bridge independently no newmustfix;
this new Root caller offer and Layout seal increment need their own review.

The independent56961 review found two source defects, corrected in this offer but
not yet independently closed. P1: generic revocation did not permanently retire
Write before same sessions.retire(). Root startup now requires a DISTINCT
retireMountedAuthority capability, pins and forwards it separately, invokes it
before original custody/session retirement and view teardown, and binds it to the
actual Write permanent method. beforeMountedAuthorityChange remains temporary.
P2: prepare previously revoked before reserving and omitted the sealing guard.
It now refuses sealing/pending first and owns the pending slot BEFORE any
callback-bearing revocation. Producer cancel/reserve callbacks cannot reenter
and take that slot. These are source corrections only, not executed race controls.

Source verification only: original owned strict lint/SCSS, Vue/TS AST/SFC, pure has
AST and exact Root patch/postimage checks. The real strict local UI9f92+a775 graph
remains FAIL209, no new owned findings. No reduced/fake type program or product
module evaluation. All tests/list/mount/browser/native/auth/security/privacy/
receipt/tamper/race/IME/resource/full-refset qualification stays HOLD/UNRUN.
No frozen authority/evidence refresh, package publication, merge or issue closure.
