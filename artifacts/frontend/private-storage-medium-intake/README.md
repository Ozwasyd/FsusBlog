# Original private-storage medium guard intake

Source WIP for #4261 composition, related #2295/#1813. No runtime/qualification.

Exact baseline: Blog `fd792280cffe18f5fb0335c930243f5c25b2bc83`, registry blob
`25f67cfbeb5203678f2142fd36d50824ef4d8dca`. Actual local UI source is #953
`d6bb0836a15f40d7ccace41773d19259c72d37a6`. Worktree/branch are independent;
shared Blog/UI source trees are not overwritten.

Actual original Journal donor #4225
`e788d215448c417c214d2c3399352ea173004159` contains the exact runtime guard. Its
whole registry differs from this baseline by the journal import/invalidation as
well as the requested guard. Only `else` to
`else if (entry.medium === 'runtime')` is consumed. No full-file copy, cast,
public-union narrowing, fake grant, journal import/cleanup hook or checkpoint change.
Source blob/provenance facts are in `source-intake.json`; these are not seals.

The original registry union has local/session web-storage, indexed-db, cache-storage
and runtime variants. Its existing storage branches retain their original cleanup.
The explicit real-medium guard legally narrows the runtime entry for
`clearRuntimeEntry` instead of relying on exclusion of the composite web-storage
union. Actual runtime inactive/failed/allSettled handler behavior is unchanged.
`registerPrivateStateCleanupHandler` still rejects unknown/non-runtime registry IDs
through its original `private_state_cleanup_handler_not_registered` error. The
synchronous web-storage entrypoint and all original handlers/contracts are unchanged.
Other debts are retained visibly, not cast away or silently reclassified.

Only original source compiler/style tools run after original entrypoint/config
inspection. Full original application command before/after:

```bash
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/private-storage-ui-baseline node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application
node tools/frontend/check-frontend-style.mjs --mode strict-full --file src/frontend/src/services/privateStorageRegistry.ts
git diff --check
```

The original alias producer extends original tsconfig.app.json without weakening
strict/erasableSyntaxOnly/noUnusedLocals/noUnusedParameters/noUncheckedSideEffectImports;
all are true, ES2022/ESNext/Bundler. Actual UI source/dependencies remain fixed.
Existing dependencies are locally linked; no package publication/private registry
or credentials. No compiler source import is executed as a product module.

Before RED exit2 / 110 complete diagnostic blocks, after RED exit2 / 109.
Only registry `(425,48) TS2345` is removed. Remaining 109 complete blocks match
exactly, added 0 (Blog 85 to 84; included UI 25 to 25). Raw original outputs/delta
are committed. This is the original Blog whole-application result; the separately
reported UI standalone debt/57 is not rerun or reclassified by this Blog-only
change. No full application/UI PASS is claimed. Original strict-full style PASS,
one file/zero violations; diff check PASS.

No tests, listing/discovery, product import, runtime/browser/native/security/privacy/
receipt execution, qualification, producer/frozen writes or authority/seal refresh.
All existing HOLD/UNRUN remain. No source test is needed for this one-line donor
intake; cleanup semantics are source-inspected rather than claimed qualified.
Rollback is the one-line guard revert plus supporting intake notes; no migration
or runtime data has been executed. Independent source review remains required.
