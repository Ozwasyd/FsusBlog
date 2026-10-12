# Original retained retry entry repair

Exact runtime source: 880a21020765de49fa1117af59c5651cbdc014a9.
Exact source/control producer: 9fceba574e22d2da39580a90a88cf37e4c3e1c6d.
The original two failed-subscription/mandatory-cleanup P2 findings were independently
closed at b3045774a4631c9f58c82167e1f514c12a27f9be. Its remaining retry entry
reentry finding is repaired by this successor, requiring exact-head independent
review. Source control9fce pins the first caught error across the actual Registry's
queued failure-observation drain; production bytes are unchanged from880.

Existing APIs remain source-owned callable subscriptions with retry()/inspect(),
and binding.retryInvalidation(). No new grant/identity/session lookup exists.
Original Registry/adapter/owner pre/post retry rejects at ENTRY using real private
notification/mutation/cancellation phases before its producer can inspect scope,
cancel, dispose or invoke cleanup. Native and owner channels reject cross-channel
notification reentry. cancelAll/dispose reject before abort or native retirement.
These checks do not call external readers. Mandatory owner cleanup outside an
external listener remains permitted.

An actual callback record pins its failure sequence before invocation. A nested
retry error caught by that callback still prevents successful-return from clearing
its failed obligation. First original error and pending unsubscribe remain until
an actual later callback succeeds. Owner post dispatch preserves actual exceptions
from cancel/dispose/listeners, attempts remaining listeners and mandatory consumer
cleanup, then reports aggregate causes. Consumer failures/promises and pending task
leases remain retained; pending/settled consumer work is not duplicated. Historical
admission flags remain quarantined. No abort/stop/retry forces task settlement,
resource zero, admission restoration, forced eviction or safe-eviction authority.
Pure has bodies compare unchanged against b304.

The generated TWO-production and FOUR-source-control patches bind exact b304
before blobs and exact9fce postimages. The generator actually performed normal
production apply-check/apply/diff-check/reverse-check/reverse, then whole-offer
apply-check/apply/diff-check/reverse-check in a task-owned detached b304 checkout.
All returned0; all7487 other baseline blobs stayed byte-identical. Manifest records
path/blob/SHA256/mode identities. This is predecessor replay, not current Main
replay or runtime qualification. No Main/Root/Writer/native factory/shared Vue/
frozen authority/seal/guard/config/dependency/server DocumentId edits.

Five appended original-module cases are UNRUN; source text count is57 authority
plus20 Registry. Complete original unit entry, config, setup and import preflight
remain [the original preflight](../retained-document-authority/preflight.md).
Its initial case counts are historical; the current dedicated totals are above.
The original focused whole-file command is proposed for parent review only:

```sh
cd src/frontend
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI node_modules/.bin/vitest run --config vitest.config.ts ../../tests/frontend/unit/authoring/articleDocumentContext.test.ts ../../tests/frontend/unit/authoring/openArticleDocumentRegistry.test.ts ../../tests/frontend/unit/authoring/retainedArticleDocumentHandle.test.ts ../../tests/frontend/unit/authoring/articleDocumentRetainedAuthority.test.ts
```

Original canonical runtime entrance remains tests/matrix.yml frontend-unit-shard
through tools/test/lanes/frontend-unit-shard.sh and RunFrontendUnitShardLane. No
runner/help/list/discovery/import execution occurred. No alternate config/mock,
worker overrides, timeout changes or selectors replace that entry.

Actual source-only checks: original strict-full2files/0violations, TypeScript AST
4files/0parse diagnostics (installed parser only, candidate modules not imported),
three pure has bodies unchanged, production/source diff-check0. Original full
application compiler command remains:

```sh
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application
```

It returned RED exit2/249 diagnostics, zero complete headline/multiplicity delta
against recorded1fea, with actual compiler-only UI8db0ac8f49749e3e5f28be5051bb3d3ed71ada71.
Type evidence is source880; exact production bytes at9fce are unchanged. This
comparison is not a waiver or proof of unchanged source spans/full qualification.
Raw standard .patch blank-context syntax is preserved; publisher artifact
incremental diff-check status is recorded separately in static-evidence. No
aggregate PASS or rule/config exception.

All tests/list/discovery/candidate-import/runtime/browser/mount/native/security/
privacy/receipt/race/DB/storage/full Host qualifications remain HOLD. No full-ready
claim, frozen evidence refresh, package publication, merge or issue closure.
