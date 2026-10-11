# FsusUI Typecheck Modes

FsusBlog keeps two explicit FsusUI typecheck modes so package-export drift and local-source alias drift fail independently. Isolated npm candidate verification reuses the published-package typecheck against an immutable local tarball and must not change the lasting consumer install.

## Published Package

`npm run typecheck:published-fsusui` checks the installed `@ozwasyd/element-plus` package from `package-lock.json`.

Use this mode for release/package-consumption validation. It must not rely on local repository aliases or Blog-local module augmentations.

## Isolated npm Candidate

Validate an existing immutable FsusUI tarball with:

```bash
npm --prefix src/frontend run verify:fsusui-candidate -- --tarball /absolute/path/fsusui-npm-candidate.tgz
```

`FSUSBLOG_FSUSUI_CANDIDATE` provides the same absolute file input. When both inputs
are present they must resolve to the same regular `.tgz` file. The verifier checks
package identity, semver, dependency protocols and the locked Vue peer before
installation, and prints the candidate SHA-256.

The consumer copies the current source, frontend manifest and lockfile into an
ignored `.tmp/fsusui-candidate-*` directory. Only its FsusUI dependency is replaced;
other direct dependency specifiers and lock identities must remain unchanged.
Installation disables lifecycle scripts and uses an isolated offline npm cache.
The cache is copied from `FSUSBLOG_FSUSUI_CANDIDATE_NPM_CACHE`, or the user's
existing npm cache by default. Prepare ordinary locked dependency cache entries
before running this command; missing cache content fails without a registry
fallback. Credentials and repository npm configuration are not inherited.

All five gates consume the installed tarball: published-package typecheck,
FsusUI export/boundary checks, the frontend production build, actual Worker/Wasm
execution through the public package entry, and a single Vue runtime identity
check. Only this isolated process sets `FSUSBLOG_USE_LOCAL_FSUSUI=0`; normal local
development keeps its existing alias behavior. Required native build tools must
be available, with `EMSDK` selecting an existing SDK when needed.

The verifier checks that original source, manifests, npm configuration and
`node_modules` remain unchanged. It cleans the temporary consumer on success or
failure. `FSUSBLOG_KEEP_FSUSUI_CANDIDATE_FIXTURE=1` retains it for diagnosis and
prints its path; retention does not turn a failed gate into acceptance.

## Local Source

`npm run typecheck:local-fsusui` checks the same export contract against a local FsusUI checkout.

By default it resolves the `FsusUI` checkout beside the primary FsusBlog checkout, including when the command runs from a linked Git worktree. Set `FSUSBLOG_LOCAL_FSUSUI_ROOT` to select another checkout; an invalid explicit path fails closed instead of falling back to the installed package. This is the mode to run during local development before the FsusUI package has been published.

### Docker Source Installation

`FSUSBLOG_USE_LOCAL_FSUSUI=1` explicitly selects the checked-out source mode in
`ops/docker/FsusBlog.Server.Dockerfile`. The `fsusui` named context must contain
the real `vue/packages` sources and previously built theme/Wasm dist. Missing,
empty or escaped required assets fail before installation; this mode does not
download an FsusUI package or read the GitHub Packages token.

`src/frontend/scripts/prepare-local-fsusui-install.mjs` owns the transient
installation projection. It removes only `@ozwasyd/element-plus` from the copied
root dependency declarations and its exact lock record. Every other lock record,
including nested public dependencies and tarball integrity, remains unchanged.
Source-only public dependencies receive exact locked root declarations so npm
does not prune them with the removed private parent. A version-conflicting nested
dependency receives a dedicated public npm alias whose tarball and integrity are
copied from its original locked record; existing root declarations are retained.
Its necessary transitive records are copied from their original lock resolution
into the temporary alias subtree, preserving exact URLs and integrity instead of
asking npm to resolve a new dependency version. Missing, cyclic or excessive
alias closures and colliding or invalid package names fail closed.
The checked-in manifest and lockfile are never rewritten or regenerated. Ordinary
public dependencies are installed with `npm ci` against these temporary inputs;
remaining non-public URLs or missing integrity fail closed. Bundled records are
accepted only through a present package-parent chain ending at an unchanged
public tarball with integrity; removed-parent orphans are rejected.

After installation, the helper verifies the source's locked runtime dependencies
and their installed identities. Each source import name is linked to its verified
public dependency through `vue/packages/node_modules`, while the existing root
dependency link supplies the shared frontend runtime. Thus source imports retain
the locked nested KaTeX version instead of accidentally selecting the different
root version. A missing dependency is an error, not permission to resolve or
update the lock.

`FSUSBLOG_USE_LOCAL_FSUSUI=0` retains the existing published-package installation
with its original private lock and required token. Other switch values fail;
installation failures never select the other mode. Source-alias builds are not
the isolated tarball qualification or evidence of package publication.

`tests/tools/frontend-local-install.test.mjs` is registered with the existing
`repository-governance:static-node-contracts` temporary-repository physical owner.
The static-governance matrix declares the regression and its source inputs; the
existing governance suite runner executes it exactly once. Its offline npm
lock-tree checks do not replace actual `npm ci` or Docker build acceptance.

## Full App Typecheck

The focused FsusUI export contract is separate from full app `vue-tsc` because the full app can fail on unrelated baseline errors. Full app typecheck should still be run as part of broader frontend cleanup, but FsusUI package/local alias failures should be diagnosed with the two focused modes first.

## Author Typography Consumer Boundary

The shared `AuthorTypographyCatalog` owns the five closed dimension/value IDs from [the typography child contract](https://github.com/Ozwasyd/FsusBlog/issues/2431). `AuthorTypographyContractValidator` rejects unknown, extra, missing, differently cased, numeric, CSS and URL values without normalization. Its snapshot digest binds account, site, revision and profile IDs. It proves content identity only; authenticated persistence, CAS and idempotency must establish authoritative server facts separately. No profile contains article, mode, document epoch, selection, scroll, font assets or public theme fields.

There is no client default catalog or local preference store. The shared catalog defines allowed IDs, and does not claim that an all-standard profile matches current editor geometry. A verified design-bound default and the AEDS transport have not been implemented. The sole server default policy contract is explicit; an unavailable policy refuses missing-profile read/reset instead of inventing default values. The controlled policy used in Postgres tests does not qualify the product design baseline.

`AuthorTypographyCommandPolicy.Prepare` validates typed set/reset commands against the authenticated scope and the current content-addressed snapshot. It rejects stale/future expected revisions, corrupt or cross-scope observations, unknown mutations, invalid profiles and exhausted revision counters. Reset accepts no client profile and requires a valid server-supplied current design default; set does not depend on an unavailable reset default. A prepared mutation carries only scope, expected revision and a closed replacement profile. Preparation is not a committed CAS receipt: the sole shared author-preference writer must atomically compare that revision, preserve writing-aid fields and persist request idempotency inside its transaction. Another domain's revision increment invalidates the previous proposal. These contracts add no table, endpoint, codec, client store or fallback default.

`AuthorTypographyRequestReplayPolicy.Evaluate` verifies the sole writer's persisted request observation before fresh CAS preparation. Matching nonempty request IDs replay the original snapshot, even after current revision advances; reusing the same ID with a different valid action/revision/profile refuses. Wrong lookup IDs, cross-account/site records, altered command/snapshot/record digests and inconsistent committed revisions refuse. Request content identity includes all five profile IDs and is generated through the existing domain digest primitives. This policy does not retain request history or establish storage authenticity, and its synthetic test records are not database receipts. The common writer still owns durable idempotency, retention bounds, transaction races and reset-default verification.

The server `IAuthorTypographyPreferenceReader`/`IAuthorTypographyPreferenceCommand` ports expose typed `GetTypographyAsync`/`UpdateTypographyAsync` operations with authenticated scope, required server device scope and finite read/write outcomes. `UserLocalePreferenceService.AuthorTypography` now consumes the actual writing-aid owner's read-state, request-lookup and commit helpers from source offer `add49d00cc4613c02dd7388ea768e255629cdafe` and bounded retention/initialization improvements from `72a27ace54b941c3186df460d733977c2ec9d369`. It validates the closed payload, resolves policy defaults, verifies replay content and re-enters the shared commit helper to check persisted device binding before CAS. Fresh set can replace an absent profile without constructing a fictional current/default snapshot. The common row/revision/journal/transaction remains the only persistence implementation. Aid and typography mutations preserve each other's fields. The shared migration/manifest/registration remains with that owner.

`IAuthorTypographyCurrentDesignDefaultPolicy` supplies the one server default. The domain partial's internal policy-binding constructor does not alter shared DI registration. The existing service constructor can read valid stored typography and commit a closed manual set; missing or invalid typed profile fallback and reset require the verified policy. Malformed persistence JSON or a corrupt common-row digest returns unavailable rather than inventing an observed revision. The required device argument has no missing-device overload or account-derived fallback. Digest shape validation is not device verification: caller-header hashing and rotating risk pseudonyms are not formal device authority. The actual authenticated principal/site/device binder and typography DI/wire remain unconnected, so this partial is not end-to-end author-only acceptance.

The first real PostgreSQL fixture run against the offered helper compiled the production projects and ran 97 scoped cases: 96 passed and one failed. `AuthorTypographyPreferencePostgresTests.DeviceColumnTamper_CannotTransferAnOriginalRequestToAnotherDevice` committed a request for device A, changed only the journal device column to device B, then observed `Replayed` for device B. At that source epoch the helper's typography request digest omitted the device, and the typography receipt did not bind it. This failed gate required a fix from the common helper owner; the domain test remains unchanged and its failed logs are preserved. The run covers shared-row CAS races, original-request replay, field preservation, scope isolation and rollback using the actual service, migration DDL and PostgreSQL fixture. It does not replace full backend compilation, verified default/device authority, runtime or UI acceptance.

After consuming the retention/initialization source, the actual production-project and fixture rerun executed 104 scoped cases: 103 passed, the same device-tamper case failed, and none were skipped. At that epoch the typography suite contained 17 cases. Its new cases prove that initialization cannot overwrite existing typography, the two domains share a 256-operation quota, a full journal retains original typography replay, and the final slot admits only one competing CAS write. Fresh writes refuse at capacity without deleting old identities or mutating current facts; another site remains independent. The PostgreSQL collection-manifest gate still fails because both domain test classes are unregistered alongside inherited manifest drift. No shared manifest or checker was edited to hide that failure.

The common helper owner's exact fix `1f03355ee5f4155d61303d5bb200960c205ac5bb` is consumed without a local digest patch. Its persistence-only receipt binds the device to the unchanged public domain record, and its request identity includes that device. Prelookup and transactional replay validate the same binding. Old unbound journal receipts refuse replay; they are not silently rebound to a new device, removed, or treated as fresh operations. The independent consumer rerun passed all 120 scoped domain/PostgreSQL cases, including the unchanged original device-column tamper probe, CAS races and original-request replay controls. Earlier failed epochs remain evidence. A device-bound content digest still does not establish formal device authority; the trusted server binder remains a separate prerequisite.

The added `LegacyUnboundReceipt_RefusesReplayWithoutRebindingDeletingOrChangingCurrentFacts` fixture reproduces the prior producer's exact domain-record JSON and existing device-free request digest. Both devices' retries refuse without returning a record or changing the current preference. A fresh request with the observed shared revision can commit, while the legacy journal identity and its bytes remain retained and continue refusing replay. The full scoped consumer rerun passes 121/121 cases with zero skips; typography PostgreSQL now has 18 cases. This checks the persistence-format transition only, not legacy profile inventory/deletion or formal device attestation. A helper rollback cannot reinterpret new bound receipts as the old unbound format; any runtime activation or compatibility migration remains with the shared persistence owner.

The `authorTypographyMapping` consumer delegates profile resolution to the actual public FsusUI `resolveMarkdownEditorTypography`. An argument-free probe remains blocked (`profile-required`) and supplies no author default. Supplied invalid profiles refuse; valid unsupported profiles remain blocked; supported means public capability only, never applied or saved. The separate public `editorProfile` presentation default remains an observation. See [local source typecheck modes](fsusui-typecheck-modes.md) for the existing alias resolver. No private selector, numeric CSS, token fork or editor wrapper supplies a substitute.

`node tools/frontend/author-typography-inventory.mjs` enumerates every indexed regular UTF-8 text file, binds full-file bytes and matching line digests, and reports binary/unavailable/aliased/oversized inputs explicitly. It discovers candidates across source, styles, storage, server, tests, configuration and documentation without a known-key list. `verifyAuthorTypographyInventory` re-enumerates physical inputs and rejects content, input-set and receipt drift. The report remains discovery-only: ownership labels are conservative path classifications, not proof of exact legacy readers, writers, scope, CSS effect or safe migration. It cannot authorize deletion or establish residue zero. Public, export and system font owners must remain isolated from author preference migration.

`captureAuthorTypographyContinuity` now consumes the canonical `ArticleEditorRuntimeBinding` returned by the existing Writer's `authoringEditorRuntime.bindEditor`. It calls `binding.positionBinding()` and `binding.continuity.capture()` and returns that owner's sealed context directly. It captures the observed public selection/history and semantic anchor, including manual scroll intent, without a transaction, editor remount, new epoch or second state store. The owner continues to reject missing observations, mismatched surfaces, stale documents and disposed bindings. This capture is preparation for reflow, not evidence that a profile was applied or that focus/viewport restoration succeeded.

Current source includes the typography domain partial on the offered shared server authority and consumes bounded journal retention and the owner's device-binding fix. Its scoped journal device-integrity probe passes. Formal device/author access binding, verified production default, typography DI/AEDS wire, legacy migration executor, settings UI, font runtime, typography reflow/restoration and terminal acceptance remain incomplete. The typography owner retains responsibility for its authority integration and Postgres tests. The shared binding exists and is consumed; it is no longer a missing dependency. Writer mounting, document/anchor/attachment integration and authoring exports remain owned by the coordinating editor chain. The remaining integration must consume actual upstream contracts when offered; no duplicate kernel or preference store is provided here.

### Typography domain handoff

The existing read/write result records and byte-valued outcomes now live once in `Shared.Contracts.AuthorTypography.AuthorTypographyPreferenceResults`; the backend ports import them. Names, field order and finite outcome numbers are retained. `AuthorTypographyPreferenceResultValidator` checks only the closed result shape, scope, exact revision range and existing content digests. It never verifies a principal/device, creates a receipt or grants a write capability. `AuthorTypographyHandoffTests` supplies literal decoded-domain projections and refusal/tamper vectors. Its JSON serializer is test-only projection evidence, not an HTTP fallback or an AEDS encoder. Canonical transport ownership must allocate frames, define byte layout and emit ABI/golden evidence through its existing registry and producers; this source allocates no frame or route.

The transport owner can consume these exact existing domain types: `AuthorTypographyMutationRequest`, `AuthorTypographyCommand`, `AuthorTypographyProfile`, `AuthorTypographyPreferenceReadResult` and `AuthorTypographyPreferenceWriteResult`. Request IDs are nonempty GUIDs; fresh commands carry an expected shared revision in `[0, MaximumExactRevision)`, the existing common writer's bound. Set carries the exact version-one closed profile; reset carries a null profile. A client request contains no account/site/device/default/article/mode/epoch/selection fields. The server supplies scope and device separately. Scope is positive account ID plus an exact site identity of at most 128 characters, with no whitespace normalization or control characters. Digest fields are the existing lowercase SHA-256 identities, not authentication proofs. Public frame numbers, GUID encoding, POD/container bounds and typed error mappings remain the canonical transport owner's decisions.

Read outcomes are `Stored=1`, `CurrentDesignDefault=2`, `Forbidden=3`, `CurrentDesignDefaultUnavailable=4`, `Unavailable=5`. Stored requires a positive revision; a default may retain the actual shared row revision when writing aids already exist. Refusals have no snapshot. Write outcomes are `Committed=1`, `Replayed=2`, `RevisionConflict=3`, `RequestIdentityConflict=4`, `InvalidRequest=5`, `Forbidden=6`, `CurrentDesignDefaultUnavailable=7`, `Unavailable=8`. Success carries the original valid recorded request and its committed snapshot. In particular, the actual helper's `CurrentSnapshot` on replay is that original committed snapshot, **not the latest row**. After replay or a CAS conflict, settings must perform an explicit authoritative read before proposing another command. Revision conflict may contain a separately validated current snapshot or null; other refusals have no record or snapshot. Unknown outcomes and refusal/success payload substitution fail domain validation.

The integrating owners still need these concrete bindings:

- **Scope/access:** obtain the account and author permission from the current server session, and choose the canonical preference site identity through one server owner. Do not accept request-body actor/site coordinates. Canvas `primary-site` and history's configured `SITE_BASEURL` are distinct existing facts; neither is automatically the typography site. Account/site/logout changes invalidate consumer observations and pending commands rather than transferring them to another principal.
- **Device:** the server must supply a formally verified device scope before mounting a mutation endpoint. There is currently no canonical typography device API. Hashing a client header, a risk pseudonym or the account ID does not satisfy this requirement; without that source, no consumer may submit a write.
- **Default/DI:** provide one `IAuthorTypographyCurrentDesignDefaultPolicy` implementation bound to the actual active FsusUI public design/default catalog. The fixture's all-standard profile is not a production default. The shared registration owner must construct the one scoped `UserLocalePreferenceService` through its existing internal four-argument policy constructor and alias `IAuthorTypographyPreferenceReader`/`IAuthorTypographyPreferenceCommand` to that same instance, alongside the existing locale/writing-aid aliases. `ActivatorUtilities` choosing the public three-argument constructor does not bind the policy. No second typography service or registration store is required.
- **Settings/reflow:** consume canonical decoded domain results and the actual public typography catalog. The controlled form disables unsupported choices and emits only a supported candidate or revision-bound reset intent. The integrating owner supplies verified access/device/default observations; display flags are not proofs. Keep the existing editor and binding. `captureAuthorTypographyContinuity` captures the existing owner context, while `applyAuthorTypographyToEditor` forwards the real mounted public method and its exact Promise/result. The coordinating owner still must supply typography action/origin/completion and persistence integration. Existing surface/refresh/attachment actions and raw UI results cannot masquerade as Writer acknowledgement or CAS receipts.

The owned `view-contracts/authorTypographyProfile` mirrors only the existing Shared catalog IDs for client preflight; its test compares all five arrays to the actual Shared source and checks all 243 combinations. It supplies no default, font assets, CSS values, mode, article field, snapshot digest or persisted state. `view-contracts/authorTypographySettings` is a controlled display projection, not a decoded frame, permission proof or a new authority field. Its display flags cannot supply missing public capabilities; only supported profiles may emit change/reset intents. Intent emission does not execute a server write. The integrating owner must validate canonical decoded results and provide actual current access, device, default and font observations before mounting the consumer.

`AuthorTypographySettings.vue` uses the public compact section density and composes five labeled public FsusUI Select controls, an accessible pending/conflict/outage status, a reset intent with expected shared revision, and a fresh-read intent. It has no draft profile, optimistic snapshot, API client, preference store, private CSS or editor instance. Reload is outside the disabled form, so a conflict does not block rereading; permissions still guard the intent. Incoming observations replace the displayed values. The existing trusted `MarkdownRenderer` supplies a fixed CJK/Latin/RTL/combining/emoji/code content sample. It explicitly labels that fixed sample as content only; it does not display the chosen typography. Actual Writer live preview remains unconnected. Font labels project supplied observations only and are not font readiness evidence.

`readAuthorTypographyDimensionMappings` projects the actual public catalog choices, supported values and mapping identifiers by reference. The source offer at FsusUI `d2ccb90fa2f85394af506df5fe620c6281a04e82` (tree `1505aa30d5af1e74ec0802e4403234eb63fad55d`) documents `markdown-editor-typography.v2`: system-sans and standard source-blank-line paragraph spacing support all three size, line-height and width choices (27 combinations). The other 216 closed combinations are unsupported; registered pinned reading-serif/CJK assets and independent paragraph gaps remain absent. Numeric and class/style authority stays in FsusUI. This engineering mapping does not establish the server current-design default. The existing Writer owner retains all mounting, continuity and anchor ownership.

Current isolated checks cover closed local-source unit cases, including forced change/reset refusal and same-app unique labels, and a scoped local-alias typecheck of the owned modules/components/tests. Chromium diagnostic rendering covers light/dark at 375/768/1440, controlled display states including revision exhaustion and all font-state labels, keyboard rereading, no observed external requests and real trusted-renderer sample content. The initial matrix passed 16/20: two immediate font-size reads raced asynchronous rendering, and two CSS-zoom cases overflowed. Polling the actual rendered size fixed the timing issue without lowering the font-size bound; the next matrix passed 18/20. The 150% and 200% CSS-zoom checks retain real failures (80px and 233px horizontal page overflow at 375px). At 200%, the actual public form is about 608px wide and its Select about 469px wide. Focused diagnosis then separated the owned sample from the public controls: applying only `min-width: 0` to the consumer sample grid item reduced both overflow values to zero and allowed the public Select to shrink naturally. The sample's intrinsic minimum had enlarged the shared grid column. `AuthorTypographySettings` now uses the existing `min-w-0` utility on that owned section only; Form, Select, FsusUI source/tokens and the closed profile values stay unchanged. The public primitive is sufficient for this repair, so no upstream geometry workaround is requested. The two focused 375px zoom cases then passed. Browser assertions still require the same page overflow bound and additionally check sample overflow and every choice's right edge; historical failed runs stay recorded separately. CSS zoom is diagnostic reflow evidence, not OS/browser magnification acceptance. Formal independent UX, actual profile apply, font readiness/network/device, mounted Writer continuity, long-document performance and terminal acceptance remain unverified. Existing negative prop-validator and process warnings remain visible.

The ordinary backend locked restore was reproduced failing on the missing Server-to-AngleSharp metadata edge. Exact source `ea4e47dd2979cdab87e5287c33888fbbf7e6d768` is applicable: all eight project/package inputs match and deleting that one offered edge makes the entire lock equal to the prior local lock. Its two-file canonical patch was consumed as `12450cceb84145a7b013257669adaef2473e985c` without regenerating or changing package versions/content hashes. The original locked restore then passed with the existing SQLite NU1903 warning; the original `dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --filter FullyQualifiedName~AuthorTypography` then failed compilation with ten errors in six test files. Those six files match the offered checkpoint byte for byte: `AuthoringExtensionRpcBrokerTests`, `TaxonomyExactMetadataTests`, `SecurityAdminPolicyDefaultsTests`, `RealConcurrencyHarnessTests`, `CanonicalArticleLifecycleScheduledFailureTests` and `CanonicalArticleProjectionVerifierTests`. No test executed through that original entrypoint. Existing isolated 121/121 evidence is retained separately and cannot replace this failed full-project gate. Source delivery does not establish acceptance.

The focused zoom repair is published at `fed076536a095f6735227d0052055942648c0588`: the existing controlled settings fixture passes all 22 Chromium cases, including unchanged 150/200% page-overflow limits, sample overflow and input right-edge checks. Its three owned local-source unit suites pass 32/32 and scoped local-source types pass. Screenshots were inspected. The additional task-geometry check still fails three unchanged paths (`ArticleWorkspaceTabStrip`, `Settings`, `Write`); no shared geometry source was modified. These diagnostics and negative-validator/process warnings remain visible, and the rendered fixture is not an independent UX or mounted-editor acceptance receipt.

Canonical compilation repairs were consumed at `d7a3e0c9bacb25c3669be23b955c3d1c013cdfec`: exact verifier source `9bf3ebb9779de226c369d1d0b8021ba140d2f176`, exact poll-field source `e724251e44222c1c36388984f71f88e901a02c48`, and only namespace/awaited-assertion hunks from `5d71bb2eec8c7c3645a799560e2ba28675d5357b`. No runtime expectation, unrelated formatting or lock changes were consumed. The original backend project now compiles and its actual `FullyQualifiedName~AuthorTypography` run passes 77/77 with zero skipped. Running the six affected classes through the original compiled project gives 233/235 passed, zero skipped. Two canonical projection scenarios, `aot-cold-wait` and `aot-shared-budget`, fail the existing hydration read count at `CanonicalArticleProjectionVerifierTests.cs:626`: expected two calls, observed one. The assertion was left unchanged in that checkpoint pending its canonical owner’s semantic correction. The C# style check also retains 75 whitespace diagnostics and three using-order findings in the consumed source; warnings are not zero. No old 248-test result is inherited, and the prior isolated 121-case subset was not rerun as a substitute. Full unfiltered backend, actual typography apply/font/device/Writer and terminal qualification remain open.

The authorized hydration-only correction from `5d71bb2eec8c7c3645a799560e2ba28675d5357b` was consumed at `2c57211974e8bcb26bc2b50a0a58f1aeeab91ea2`. The actual reader returns `aot_current_document_missing` before discovering any sidecar when the AOT entry is absent; only the successful reread discovers and strictly verifies the referenced sidecar. Only the two absent-then-present scenarios now require exactly one hydration read; all other exact read-count assertions remain unchanged. No production behavior, lockfile or unrelated formatting was imported, and the resulting projection test file equals the canonical source blob. At this exact commit, the original `tests/backend/FsusBlog.Server.Tests.csproj` entrypoint rebuilt with `--no-restore --filter FullyQualifiedName~CanonicalArticleProjectionVerifierTests` and passed 112/112. Its six previously affected classes then passed 235/235 using `--no-build --no-restore`, and its `FullyQualifiedName~AuthorTypography` run passed 77/77 using the same compiled project. All three runs skipped zero tests. The changed projection test file passes the scoped C# style check with zero findings. The rebuild retains 1,569 warning lines and zero error lines; the earlier failed runs, other-file style findings and shared geometry failures remain recorded. These current local results do not inherit historical 248-test evidence or establish full runtime, independent UX, typography apply/font/device/Writer or terminal acceptance.

### Public typography source consumption

The public source offer is consumed through the real local alias at exact FsusUI
`d2ccb90fa2f85394af506df5fe620c6281a04e82`; its contract is
[`docs/api/markdown-editor-typography.md`](https://github.com/Ozwasyd/FsusUI/blob/d2ccb90fa2f85394af506df5fe620c6281a04e82/docs/api/markdown-editor-typography.md).
Blog implementation commit `2aeead62eaf0265202587fe13589def2f2503957` preserves
those exports without a copied numeric catalog. The server/client closed IDs
remain unchanged. No FsusUI source, shared Writer/context/anchor/attachment,
writing-aid preference, lock, checker or allowlist is changed by this increment.

`applyAuthorTypographyToEditor(editor, request)` accepts the actual mounted
exposed method with the public request/result types and returns its exact
Promise. Its source type check verifies equality with the actual exposed method.
The integrating owner must bind `expectedDocumentIdentity` and
`expectedRevision` to the current editor document and source revision, distinct
from the preference CAS revision in settings intents. `requestId` is UI
correlation only. No request builder, second editor, layout scheduler, anchor
algorithm, persistence or continuity completion is introduced here.

Only the UI's actual resolved result can report `applied`; its
`restored-after-frame` result is a UI observation. `rejected` and `interrupted`
retain their public reasons, `visualCommitted` and settle distinction. The
consumer does not convert any of them into a Writer acknowledgement, server
commit or terminal receipt. `font.state: current` and `no-font-loader` are
upstream system-font observations/policy; `faceEvidence: not-collected` remains
explicit and is not pinned-asset, glyph or network qualification.

At this source increment, the official public-export local typecheck and scoped
Vue/TypeScript checks of owned source, component, tests and existing fixtures
pass. The original ESLint rules against the canonical exact-source TypeScript
project pass for four owned source files with zero findings. This is separate
from the original style entrypoint, whose ordinary project cannot resolve the
unpublished public package/source exports and remains failed. Its failure and
initial consumer type errors remain recorded. The global FsusUI boundary check
still fails three unchanged selector paths: `AdminArticleCompactCard`, `Login`
and `Register`. Focused Markdown lint and document lifecycle checks pass.
These results do not establish warnings-zero or full-branch acceptance.

The three owned test sources contain 42 expanded cases (mapping 12, settings
contract 20, settings component 10). New cases cover the actual public
27-supported/216-unsupported resolution, hostile-record refusal without getter
execution, real mounted call-through rejection for unsupported/stale document/
stale revision requests, and controlled supported change/reset with unsupported
options disabled. No test manufactures an applied result or DOM geometry. The
entry preflight records actual imports, shared happy-dom/RAF and locale setup,
Wasm mocks, cleanup hooks and the exact existing Vitest configuration. All 42
runtime cases and test list/collection remain **UNRUN** under the coordinating
runtime hold. Required exact-source theme/assets are not runtime qualified.

The current source preparation is consumer-owned `task` bounded composition;
formal classification/UX acceptance, mounted Writer typography action and
completion, verified access/device/default authority and transport, actual live
preview, font/assets/network/Unicode, native input/IME, browser/mobile/zoom,
performance, migration and terminal/publication gates remain open. Historical
source-epoch browser/backend results above are retained as history and do not
qualify this new source combination. The upstream 13-case typography runtime
entry likewise remains unrun; its static offer is not acceptance.
