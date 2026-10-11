# Public editor IDs and actual retained-owner boundary

Related to #2246 and #2250. Source-only increment, not chain acceptance.
Tested implementation: `3732cf612987aa7c36d4db21b218f2fb1396c423`.

ArticleWriteEditor exposes textareaId, labelledBy, outlinePanelId and
outlineTitleId. Primary textarea/body label defaults remain article-content /
article-body-heading; the Layout host must supply unique stable values for an
actual secondary editor. These accessibility IDs are not document/session authority.
The existing public MarkdownEditorAdapter and FsusUI textareaId path are reused.

ArticleWriteOutlineRail exposes panelId/titleId. Vue useId supplies a unique default
panel ID per real component instance; title/host IDs and launcher aria-controls
refer to it. Both compact and desktop content associate their real heading via
aria-labelledby. No private DOM query, body store, session map or forged binding
was added. Write.vue and Layout-owned files are unchanged.

## Verification

All727 actual frontend files match the static program byte for byte. Actual old
journal and UI06d remain; canonical699 configuration overlays are unchanged.
Application typecheck exit2/234 and the two-component strict-full style exit1/65
both have zero added/removed normalized findings relative to cb965. Existing
journal exports/native attachment API and unrelated component findings remain.
This is not a passing application build. Commands, logs and exact scope are here.
No tests, test listing/collection, mount, browser/native/backend or product run.

## Exact Layout observation and minimum missing producer

Fetched and read supplied Layout commit
`3cd15f25b3f8ecc65600a04f14e6f86324460adc`; did not apply or cherry-pick it.
Its AuthoringWorkspaceSessionOutlet Teleports one existing primary slot VNode to
two actual region refs. It does not acquire/bind/release a second editor. Its
Write.vue passes the existing original form/context/runtime handlers into that
same component, which is a usable primary placement source change.

The requested listRetainedBindings/isCurrentBinding/readView/bindMountedEditor
API does not exist in the current original owner. The original primary form and
runtime exist, but are component-scoped and route-selected. Registry entries
contain document refs/association metadata, not the live form, draft/tasks owner
or its setter/commands. ArticleDocumentContextAuthority.acquire shares one
adapter and switches its document for another article/scope; it accepts no
already-held native session owner. Writer watch(articleId) switches that adapter,
resets the entire original form and starts initData. onUnmounted releases
runtime/context/recovery/tasks and clears content; component watchers also end.

An actual producer must issue a retained original owner from the canonical
session/document authority, with its real article/draft/document/epoch/revisions,
original form/draft/task and native mount handle; define new unsaved draft identity;
and connect final close/evict/scope release. Route selection can then select that
owner. Until those producer/lifetime inputs exist, exporting fabricated second
WriterBinding or snapshot-backed setters would violate the single-owner contract.
This is a concrete source/lifecycle dependency, not a permission request. The
current primary binding can be reused, while the public IDs above are now ready.

Checkpoint reentry P2 at cb965 is independently SOURCE CLOSED by parent; no
repeat fix. Real upload source intake d27 remains applied. Corrected journal
producer generation scoping plus stable crashJournalRef, native attachment API
join, external #2245 acceptance and all runtime/product gates remain pending.
