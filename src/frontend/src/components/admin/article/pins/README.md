# Independent article pin presentation

Refs #2313. Source-only continuation, isolated from the active ArticleLibraryRail,
Quick Switcher, Write, Root/session, shared SDK and canonical backend owners.
No component is inserted into a production host by this module.

## Source and protocol boundary

The audited base is `29051db2a80db7770dfe78a1db6e4c6998337324`.
`src/backend/Services/Authoring/AuthorArticlePinApplicationFacade.cs` really
implements Read/Add/Remove/Reorder/RevalidateOpen and derives actor/site from the
authenticated administrator request. Its registration is present in
`src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs`.
It is an **internal application facade**, not a public HTTP/wire contract.

The actual `src/backend/Modules/Endpoints/AuthoringEndpoints*.cs` routes and route
catalog do not bind this facade. No pin request/reply is registered in
`src/shared/Contracts`, `src/core/Algorithms/AedsFrameType.cs`, the frontend
`wasm/aeds` decoder/POD surfaces, `wasm/web/protocol/frame.ts`, or the frontend
API/codec owner. Consequently this continuation implements **no pin transport**:
no guessed endpoint/frame number, generic JSON-frame workaround, invented
decoder, fake response, alternate query/projection or successful no-op command.

The original shared protocol owner (#3735), with backend #2311/#2312, must supply
the following real authenticated routes/contracts. Route paths, HTTP methods,
frame identifiers and codecs are currently **unassigned by their owner**.
The existing author route family is `/api/binary/author`; naming a new path here
would not register it or authorize consumer use.

| Facade operation | Actual domain input | Missing public consumption |
| --- | --- | --- |
| ReadAsync | RequestId; Limit 1..256 (default64); opaque Cursor; optional expected collection/article/permission/site/session revisions | Bounded typed request/reply, `AuthorArticlePinProjectionPage`/receipt decode, authenticated route and private-request cancellation/error mapping |
| AddAsync / RemoveAsync | ArticleId; Int64 ExpectedRevision; RequestId | Typed CAS request/write receipt; revision/idempotency conflict, denied, budget and validation mappings |
| ReorderAsync | ExpectedRevision; RequestId; 1..64 moved ArticleIds; nullable AfterArticleId | Same bounded reorder plan/receipt for keyboard/menu/drag; no client order write or per-item request loop |
| RevalidateOpenAsync | RequestId; ArticleId; CollectionRevision; article/revision/permission references; permission/site/session revisions | Typed Current/Stale/Denied/Unavailable reply and original open-or-activate integration (#2233/#2293) |

Shared contracts must preserve Guid identity, lossless Int64 revision, enum
values, bounds, privacy-filtered order/count, opaque cursor/digests and the
original domain receipts. Actor/site must never become caller-provided grants.
Keep AEDS v2, POD/C++/TypeScript parity, existing X-Fsus headers, private request
runtime, PoW/session protections and unified errors. Public activation, codec
generation and backend/DI changes remain with their original owners.

## Consumer source

`ArticlePinList.vue` is one text-list leaf selected by `surface: rail|switcher`;
both consumers must pass the same original admitted display page. It returns
the original items in server order, renders at most64 rows, refuses invalid or
duplicate inputs as a whole, and hides all old title/count content for
unconnected, stale, conflict or unavailable presentations. It has no localStorage,
membership cache, ranking calculation, cards, cover/summary/tag metadata, new
Drawer or session/router ownership.

`ArticlePinToggle.vue` is the single text toggle for add/remove with one action
ID. Unknown membership is disabled; absence from a page never implies unpinned.
An explicit unpinned input can originate only from the future original shared
composition, not a local favorite list. Text semantics are used without
inventing a private or unsupported pin icon.

`articlePinPresentation.ts` defines **display destinations and closed UI
intents**, not wire DTOs, a permission projection or an authenticated transport.
Its shape/budget checks authorize rendering only and verify no receipt or grant.
`collectionRevision` is an opaque lossless display reference; its wire encoding
must be selected by the shared protocol owner. Every intent carries only
stable pin/article identity, original revision/page digest and an after-anchor;
private title text never enters intent/trace payloads. Dirty/open flags are
optional display facts from the original document/session owner.

Keyboard Alt+Up/Down, explicit FsusUI menu commands and native drag/drop use the
same after-anchor intent builder and never mutate the authoritative list. Arrow,
Home and End navigate through the documented public Button.ref focus API.
Row keyboard handling ignores already-consumed events and accepts only events
from that row's title Button. Dropdown, toggle and other nested controls keep
their own Arrow/Alt semantics. Pending refresh is disabled in both its public
Button and its emit handler, including an unavailable presentation.
An unknown predecessor outside the current page is refused rather than treated
as the collection head. Drag holds only a pin identity and original revision/digest
binding; it retains no page/title object and refuses a changed binding. There are
no global drag observers or unbounded per-collection listeners.
Touch uses the same menu. OpenEligible is a server display hint, not authority:
the leaf only emits an intent and creates no route/tab/session.

The drag operation set is deliberately limited to after-anchors visible on this
page. It has no head/null drop target; keyboard/menu can request head only when
the actual head-page predecessor is known. Sharing the intent builder does not
establish full drag/head equivalence. Full gesture parity remains unimplemented
integration/acceptance work and is not claimed by this source candidate.

All Button, status and ARIA copy now comes from required `ArticlePinCopy` strings
already localized by the original composition through its genuine typed i18n.
These fields are UI copy slots, not invented locale IDs, catalogs or schema
receipts. Both leaves use the same supplied pin/unpin copy. Missing copy renders
no leaf; there is no hardcoded-language fallback, locale mutation or new i18n
authority in this module.

Malformed display input is checked as unknown data before field access: non-string
revision/digest, non-array items, non-boolean startsAtHead/hasMore and non-null
non-string cursor are refused. Whole-page row validation precedes rendering and
the original page is returned by identity only when all shape/budget checks pass.
Missing fields or throwing input return null with no partial title/count. These
checks still verify no receipt, permission or currentness.

Pending/failed/conflict/stale are explicit display states. There is no optimistic
mutation or success acknowledgement. The host must withdraw an old projection,
refresh on real CAS conflict and retain original request/receipt/failure custody.
Stable focus identity is retained separately from row metadata; after genuine
fresh admission the original host may call `restoreFocus`. This is a view-only
operation, never re-admission. Client rank boost, open validation, transport
composition, account/site/logout invalidation and shared Rail insertion remain
unimplemented original integration steps.

## Static scope and held verification

Ownership is FsusBlog task/navigation composition with the original public
FsusUI Button/Dropdown, consumer-only interaction judgment; task profile with
public menu overlay semantics. No shared control geometry, tokens, design
authorities, tests, receipts or SDK source is changed. Static alias is the
original UI562 source (`562536ba33c5d62c1b45d537963f5f3e825b7437`) with existing
installed dependencies. Both design Skills apply; their source reads do not
constitute rendered evidence or an acceptance receipt.

The ordinary future lane remains the existing frontend Vitest shard/config and
`tests/frontend/support/unit/setup.ts`; no new runner/config or test entry is
created. Before any later authorization, preflight exact imports of these three
source modules under the original public UI alias and cases: add/remove
pending/failure/CAS; shared Rail/Switcher page identity and order; all three
reorder paths including off-page boundaries; 0/1/1000 pins through bounded pages;
archived/deleted/revoked/stale/actor-site change; raw transport error/receipt
mapping; current/closed/other-group open-or-activate; retained focus after refresh;
mobile/zoom/themes/keyboard/screen reader; tampered projection/action/receipt.
The original held preflight also covers consumed Dropdown ArrowDown/Alt+Down
events versus title-only navigation/reorder, unavailable+pending refresh button
and handler, missing revision/items and cursor0/startsAtHead shape refusals, and
composition-supplied localized copy across locale changes. No case is executed
or promoted to runtime/UX/receipt evidence by the static source repair.

All runtime, product imports, mount/browser, ordinary tests/list/discovery,
security/privacy, network API execution, native, receipt and frozen qualification
lanes are HOLD/UNRUN. Source compilation/AST/style results cannot establish
authenticated wire consumption, permission/privacy correctness, rendered UX or
completion of #2313. The draft PR binds actual static results and remaining work.
