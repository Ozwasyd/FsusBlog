# Capture recovery independent source offer

Refs #2382/#1813; downstream #2384. SOURCE WIP, no issue closure/activation/receipt.

## Actual source checkpoint and producer provenance

- Original clean/verified master base: `29051db2a80db7770dfe78a1db6e4c6998337324`.
- First pushed adapter source: `ebb37290c5aba5e20d0e75e22d50582aeca59ac3`.
- Draft: https://github.com/Ozwasyd/FsusBlog/pull/4260.
- Source worktree: `/workspace/FsusBlog-quick-capture-recovery`.
- Original journal origin: `98b480fe9681e42720b94067409453e5574ae8e5`.
- Original policy alignment: #3413 `9463e62468e6c2f81e123f91a205ae9ef826c1d0`, not a new checkpoint capability.
- Sole journal blob at this base: `2c8df95d2403a62330a8a32153b5b8895871266a`.
- Actual #4244 request source read: `bc41079de3d20774cd7635f90e0d2d21c2623833`.
- Actual #4251 readonly reconciliation source read: `6b0fb53e7a42a48d27fe1005cbbee7d341ada5ef`.
- Actual #4256 transport source read: `ac727b42dea66811b906fe8b8ff408dea9401839`, then `63b988c832249a32c65269c48e81e903e0db1c25`. Its frontend transport, backend transport and shared request/response contract blobs are unchanged between those two heads.
- Parent reported bounded independent producer-source acceptance for bc41079/6b0fb53/63b988. No acceptance is inherited by this new adapter.

No createwriter, journal owner, active Main/session, UI, codecs, protocol authority,
generated/frozen output, lockfile or package source is edited. This branch is
separate from original Journal #4225. Existing privacy documentation is maintained;
this artifact records candidate facts rather than a second long-term authority.

## Available actual API

```typescript
new ArticleCaptureRecovery(captureId, originalCoordinator, readActualScope);
stage({ requestId, clientRevision }, { schemaVersion: 1, title, markdownContent });
discover();
discardOwned();
retire();
describeArticleCaptureRequest(adminPrincipalId, captureId, identity, input);
```

`readActualScope` must read the genuine current session-owner object, decimal
admin principal, configured site scope and actual article-write admission. The
capture identity/request GUID/client revision and SAME original physical-tab
coordinator are real caller inputs. No unknown/default/hostname or actor identity
is invented. These inputs are not a server grant or effective-authority proof;
actual composition is not activated here. The scope must be credential-free;
current configured site scope is not a historical receipt site/document binding.

The client correlation projection uses the actual producer's schema/title/body
length-prefix SHA-256 and mode=2/actor/Guid/input-digest command binding, preserving
Guid.ToByteArray byte order and exact raw title/Markdown UTF-8. It is not a receipt
digest, permission proof or new createwriter. UTF-16 bounds/control-title/.NET
whitespace admission mirror the supported source request; no truncation, trimming
or newline/Unicode folding occurs. URL/template/unknown fields refuse because the
actual schema-1 producer does not admit them.

Capture identity/site/tab/request/client metadata and only that exact minimal input
are encoded inside the original closed journal's source payload. Original outer
schema, database, principal hash, UTF-8/plaintext/168h, integrity/cleanup and budgets
remain untouched. There is no second storage namespace/database/body cache/form/
retry queue/title-dedupe/create path. Scope identity strings are hashed by the
original owner; local ownership retains only scalar record/request coordinates.

Actual native Web Locks use `ifAvailable` for local-only, cooperating capture
serialization; no waiting retry queue or fallback. Original notifications only
invalidate observations, never grant ownership. Foreign/same capture rows conflict.
Repeated input reads actual original storage and never renews TTL. Expired/missing
input remains unprotected with the same request identity, not a new UUID. Real
quota/storage/lock failure reports lack of local protection; source does not block
a future genuine server attempt through its original producer.

Observed owner/principal/site/permission change permanently retires the binding;
explicit cancellation/discard revokes before awaiting. Only this instance's known
row is read and compared by complete original metadata before original discard
under its native local lock. Pending local-write retirement attempts original-row
cleanup and keeps unknown status on failure. No other valid record or borrowed
coordinator is disposed/cleared. Local discard has zero server calls; it does not
prove that an external server request was cancelled or wrote nothing.

`discover` exposes only immutable digests/coordinates with unknown outcome and
reconciliation-required status. It does not expose ready recovered title/body,
retry/create, saved Inbox, document/open action or confirmed cleanup.

## Exact missing original hooks and non-negotiable outcome semantics

The real backend producer already offers:

```csharp
Task<ArticleCreateReceipt> CreateInboxAsync(actor, requestId, ArticleInboxCreateRequest(1, title, markdownContent), ct);
Task<ArticleCreateReceipt?> ReconcileInboxAsync(actor, requestId, ArticleInboxCreateRequest(1, title, markdownContent), ct);
```

Reconciliation performs original actor/article.write admission and exact
owner/request/raw-payload digest ledger read; it does not spawn a writer. Null
means ONLY no committed receipt observed at that read. In-flight create can still
commit: null, timeout/offline/failure/cancellation do not prove no writes, justify
clearing unknown journal or allocate a new UUID for retry. Exact payload/UUID must
remain bound. A returned receipt is historical; current article/document or a new
site/session grant cannot be inferred from it.

Actual `createInboxCapture`/`reconcileInboxCapture` source exists at #4256, through
original private request/runtime and actual binary request. Its route/central
registration/generated frame/codecs/native composition remain unactivated/held.
The required generated module and bindings are absent here, so this adapter does
not import a nonexistent generated port, route to `/admin/article`, manually
refresh a frozen output, invoke a producer or fabricate success.

Before complete recovery is available, original owners must supply:

1. Real registered/generated authenticated create/reconciliation transport and
   actual current session/site composition/retirement signal.
2. Genuine historically scoped, input-bound create confirmation custody. Current
   response `RequestSiteScope` describes that request, not the old receipt's site.
   Historical receipt still does not supply current document/permission authority.
3. The actual reconciliation consumer which preserves unknown/null identity and
   only consumes genuine confirmed input through original journal.confirm.
4. Original request support for optional source URL and explicit current template
   plan plus stale-plan admission; they are refused, not guessed, here.

No executable success/verification/reconciliation callback shim is accepted.
Confirmed-input cleanup is absent until its real prerequisites exist. Full #2382,
#2384 activation and all runtime/independent qualification remain blocked.

## Actual static checks only

The original entrypoints/configuration were inspected as source. Commands:

```bash
node tools/frontend/check-frontend-style.mjs --mode strict-full --file src/frontend/src/services/articleCaptureRecovery.ts
node src/frontend/node_modules/typescript/bin/tsc --noEmit --strict --noUnusedLocals --noUnusedParameters --erasableSyntaxOnly --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM --skipLibCheck src/frontend/src/services/articleCaptureRecovery.ts
node src/frontend/node_modules/typescript/bin/tsc --noEmit --strict --noUnusedLocals --noUnusedParameters --erasableSyntaxOnly --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM --skipLibCheck src/frontend/src/services/articleRecoveryJournal.ts
git diff --check
```

Original strict-full style PASS: one new adapter/zero violations
(`checkpoint-style.txt`). Strict target source compiler RED exit2 with ONLY original
`articleRecoveryJournal.ts(821,9) TS1294`; full diagnostic equals original journal
alone under the same flags (`checkpoint-types.txt`, `original-journal-types.txt`).
No adapter diagnostic and no waiver/core edit. Initial new type/style errors are
preserved in initial outputs, then repaired without suppressions or policy changes.
An initial style-tool invocation encountered an untracked directory symlink;
local dependency links were made inside the normally ignored real directory,
without changing repository ignore/configuration or installing packages.

The **original full application** type producer ran on exact master base and head,
with the same real UI source `59b9a1facc1862e590604973703ffc3d92fb85f9` alias and
existing installed dependencies:

```bash
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/journal-publication-ui-static node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application
```

Both RED exit2 / 167 complete diagnostic blocks; exact multiset added/removed 0.
No configuration weakened. Resolved strict/erasableSyntaxOnly/noUnusedLocals/
noUnusedParameters/noUncheckedSideEffectImports remain true, ES2022/ESNext/Bundler.
Raw before/after/delta and resolved options are committed; no whole-app PASS claimed.

The whole new unit SOURCE file was compiler-checked under strict/noUnused/
erasableSyntaxOnly, actual aliases/dependencies, without executing module/setup.
Only the same original journal TS1294 remains (`unit-source-*`); no control-source
diagnostic. Five source controls cover raw/BOM/CRLF/final-newline retention,
actor/UUID exact binding, length-prefix ambiguity, title/body-only/.NET whitespace,
unsupported fields and invalid/overbound source/identity. They are ALL UNRUN and
do not qualify storage, native lock, multi-tab, crash/restart or receipt semantics.

Original Vitest config/shared/setup were inspected as source only. Setup creates
happy-dom and loads protocol/actual locale graph. No runner/help/list/discovery,
candidate import, test, browser/native/security/privacy/receipt/backupmigration
execution or frozen write occurs. No package publication/private registry/credential.
Root original preflight and every runtime/qualification HOLD remain in force.
