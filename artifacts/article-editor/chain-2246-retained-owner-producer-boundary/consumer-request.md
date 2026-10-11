# Concrete Writer input for the original retained-document producer

Producer task supplied by parent:01a12cf5-cd0e-753a-b7f0-81f100373027.
This is a consumer request/observation, not an implemented interface or issuer.
No accepted #2245 evidence or #2245 second-binding API is required to create this
original document source capability; cache/refresh acceptance remains separately WIP.

The smallest actual producer handoff Writer can consume is:

1. A genuine registry-issued retained handle and the original bound adapter/context
   getter; ability to validate its membership/liveness in the original producer.
   Inactive retained owner is still live: tab selection and handle validity are
   separate. No route/ref/snapshot reconstruction is sufficient.
2. The actual canonical registry/session association and original document scope:
   articleId/draftId/documentId/documentEpoch/sourceRevision/draftRevision,
   editorSessionId/editorSessionRef relationship, siteScope and raw principal source.
   Supply actual fresh original readers/handles, not a registry row echoed as proof.
3. A primary adoption/retention operation accepting its already-held REAL
   ArticleDocumentContextBinding and association. Reuse that adapter/identity/epoch
   and existing Writer/native runtime; do not acquire or bind the primary again.
4. Original context subscription plus per-document final invalidation/release
   notification for actual close, evict and scope revocation. State who legally
   invokes each event and how it is fenced against stale/reentrant callbacks.
   Writer then revokes its same-binding journal, File/attachment, task and runtime
   owners. Hide/move/tab selection do not invoke final release. Full snapshot gates
   remain required before actual eviction/disposal.
5. The original issuer's existing stable create-draft identity and exact retained
   lifetime. Writer's original storage/recovery owner will integrate persistence
   coordinates according to that lifetime and the existing private cleanup/schema
   contract; authority must not create a second body/journal store or invent a
   storage namespace. The currently shared literal create key needs explicit
   multiple-draft semantics before simultaneous retained drafts are advertised.
6. The producer's sanctioned way to keep the original per-document Writer consumer
   resource/effect lifetime attached to that genuine handle, including how the
   existing primary form is adopted. It must support one original form/draft/tasks
   owner per handle without requiring a caller shadow identity/mount map, another
   authority, copied body or whole Write/composable clone. Producer supplies only
   its ownership/lifetime hook; Writer owns its actual consumer state and commands.

Writer will expose Layout's requested readView/body mutation and same-handle
transaction/selection/focus/attachment/save/submit callbacks from those original
resources. It will forward bindMountedEditor to the existing original runtime,
reuse primary once, and return its mountedSource/checkpoint ports. Layout owns
Write.vue/component host/Teleport and only borrows those real bindings/IDs.

The real journal02cfd, native/File source6a73 joins and public component IDs are
already delivered atde6df. Further producer integration waits only for the parent's
exact original source/API and call-site/lifetime evidence. No code or issuance
change is made by this request; all runtime/product/frozen-authority holds remain.
