# Original primary physical mount source offer

Refs #2299. Product scope is `Write.vue` and its existing
`authoringWorkspaceLayoutContext.ts` public contract. The one original
ArticleWriteEditor remains under the same persistent Teleport/slot host. Its own
connected root/native-region DOM refs, real original mounted Writer/native source,
canonical Registry revision/entry digest, current document identity/epoch/revisions,
binding generation and operation lifetime fence physical completion. The port is
`Write.getArticleWorkspacePrimaryMountPort()` ->
`AuthoringWorkspacePrimaryMountPort | null`; its only operation is
`prepareMountedEditor(entry, signal): Promise<void>`.

This operation waits for the real existing subtree and original native binding.
It does not open/move/focus a tab, acquire/rebind another editor, attach a host,
copy body/history, create a mount index/store, or issue readiness/resources/refset
receipts. Reentry is refused; abort/unmount settles the task and removes watchers
and abort listeners. Different restored document/body or read-only ownership is
refused explicitly rather than reconstructed from entry metadata. The original
Writer source independently reads its actual private document binding; matching
serialized coordinates alone cannot supply that source.

The actual Root startup phase must provide the existing module's readonly
`authoringWorkspacePrimaryMountOnlyKey`. Write stays physically mounted and inert
and suppresses its original automatic route registration/status publication during
that phase. This prevents the route editor from populating the empty Registry
before original startup custody. No phase flag grants permission or admission.

`root-owner-only.patch` is an exact four-file offer against original Rail
`62564bb29270a2bfc53e0ba5c24a2f30f24ecb42`, retaining its authenticated lifetime
introduced at `16f5248ba7cc6f87230672246c4a43366769caf6`. It removes the actual
starting RouterView destruction gate, provides that actual phase, forwards the
required real mount operation through its original authenticated caller, and
passes it to the same original session installer. It depends on the actual Main
composition `07ea5048bc8c01eaf3dd9b95dc22434016ae4dc5`. No product Root,
composition, session or native file is changed by this Layout offer.

Concrete producer gaps remain. At exact Root625, the entire frontend contains
only the declaration of `connectAdminArticleWorkspaceSnapshotStartup`, with no
production invocation supplying startup capabilities. Its original producer must
bind `startup.prepareMountedEditor` to the actual current routed Write public ref,
under the same startup signal/view/auth lifetime. This offer supplies no substitute
bootstrap or void stub for that absent production provider. The original Writer
currently has one route-owned form/context; a genuine restored Registry handle and
full-form/body view adoption API is absent from this consumed source. That owner
must provide it before a different restored entry or second editor can be mounted.
Removing the Root gate alone cannot satisfy either gap.

Verification is source/static only: exact patch application to the four original
source files; SFC/template/TS AST parsing; one actual native subtree; original owned
ESLint and SCSS rules. Actual strict UI9f92+a775 graph remains FAIL209, zero added
versus prior source and zero owned Write/layout findings. No reduced/fake type
program is used. All tests/list/mount/browser/native/auth/receipt/security/privacy/
race/IME/resource/full-refset qualifications remain HOLD/UNRUN. Full factory
resource/snapshot refusals are not weakened. No merge/close/deployment/package publication.
