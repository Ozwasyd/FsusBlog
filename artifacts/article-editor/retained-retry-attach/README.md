# Original attachment retry entry source repair

Exact runtime producer: 6654f9458f2395e9216c61c0782aa837e234d624.
Exact source/control producer: 002a48338a6fbb2cd97eb5195cfd302cbaf229a7.
Exact predecessor: 85a8ebebba8f777eef9d30466d4101e15f74b649.
Independent review closed the predecessor notification-reentry P2. Its remaining
attachment-frame retry asymmetry is repaired here; exact successor review pending.

Both owner pre/post subscription retry guards now reject attachingConsumer before
producer callbacks or scope inspection. Original native pre/post retries use the
same owner's private readonly retryActive query for attachment, retirement and
notification/cleanup frames. Existing binding.retryInvalidation already rejects
attachment; its guard is unchanged. Native cancelAll/dispose, public task/seal
cancellation, pure has predicates and Registry source are unchanged. No new grant,
handle, second index, cleanup entry or privileged bypass exists.

[The complete SOURCE phase/entry review](entry-symmetry.md) enumerates original
create/attach/pre/post-notify/cleanup/pending/failed-cleanup phases against all
public retry/cancel/dispose/token/record cancellation entries, plus the internal
native bridge. Retry rejects actual producer-frame reentry. Original mandatory
native cleanup remains permitted outside its existing callback guards; a blanket
outer-cleanup/attachment ban would also block genuine cleanup inside create.
The audit preserves this distinction instead of inventing a new caller authority.

The generated production and full source-control offers bind all FOUR source
postimages, with only TWO changed files: Document authority and its dedicated
source tests. Registry/Registry-test blobs remain identical. Normal production
apply-check/apply/diff-check/reverse-check/reverse and full offer apply-check/apply/
diff-check/reverse-check actually returned0 in a task-owned detached exact85a8
checkout. All7497 non-offer baseline blobs stayed identical. This is predecessor
source replay, not current Main replay or qualification. Source-offer manifest
records exact before/after Git blobs, SHA256, bytes, modes and original generator.
No Main/Root/Writer/native factory/shared Vue/frozen authority/seal/guard/config/
dependency/server DocumentId source or policy was edited.

Two appended original-module source controls are UNRUN. Total59 authority plus20
Registry cases come from text inspection only. They cover real create-frame owner
pre/post/native retry rejection before scope/callback reads, actual first-error and
pending-unsubscribe custody, later actual retry, and native retry during real
consumer cleanup without duplicated pending work. The cleanup case preserves real
native subscription custody through failed pre delivery before attempting retry. Original complete entry/config/
setup/import [preflight](../retained-document-authority/preflight.md) is unchanged;
its initial counts are historical. Proposed focused original whole-file entry,
NOT executed:

```sh
cd src/frontend
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI node_modules/.bin/vitest run --config vitest.config.ts ../../tests/frontend/unit/authoring/articleDocumentContext.test.ts ../../tests/frontend/unit/authoring/openArticleDocumentRegistry.test.ts ../../tests/frontend/unit/authoring/retainedArticleDocumentHandle.test.ts ../../tests/frontend/unit/authoring/articleDocumentRetainedAuthority.test.ts
```

Canonical runtime entrance remains tests/matrix.yml frontend-unit-shard through
its original lane script/RunFrontendUnitShardLane. No tests/help/list/discovery/
candidate-import execution, alternate config/mock, worker override or selector.

Original strict-full checks both production files with0 violations; installed
TypeScript parser reads FOUR source texts only, with0 parse diagnostics. Native,
Document and Registry pure has bodies compare unchanged against85a8. Incremental
production/source diff-check0. Exact original whole application command:

```sh
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application
```

It remains RED exit2/249 diagnostics, zero full headline/multiplicity delta against
recorded880, with actual compiler-only UI8db0ac8f49749e3e5f28be5051bb3d3ed71ada71.
Compiler evidence is source6654; exact production bytes at002a are unchanged.
No waiver, changed-span proof or full qualification is inferred. Prior85a8 raw
artifact diff-check RED2/22 context warnings stays unchanged. This increment's
publisher raw-patch whitespace findings are recorded separately in static-evidence;
standard patches are preserved, never an aggregate PASS or rule/config exception.

All runtime/test/list/discovery/import/browser/mount/native/security/privacy/
receipt/race/DB/storage/full Host qualifications remain HOLD. No full-ready claim,
frozen evidence refresh, package publication, merge or issue closure.
