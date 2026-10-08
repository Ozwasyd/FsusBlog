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

There is no client default catalog or local preference store. The shared catalog defines allowed IDs, and does not claim that an all-standard profile matches current editor geometry. Default policy and the database/AEDS transport have not been implemented. Missing, corrupt and future profiles currently refuse at this boundary; the eventual single server policy must supply the verified safe default.

The `authorTypographyMapping` consumer reads the actual FsusUI public `ElMarkdownEditor.props.editorProfile` default and reports `blocked`. The public `markdown`/`prose` profile is insufficient for five independently adjustable dimensions. A new prop appearing in an upstream checkout cannot turn this observation into a supported mapping. The mapping owner must consume an explicit public catalog, registered font identities and reflow contract before settings, apply or preview are enabled. See [local source typecheck modes](fsusui-typecheck-modes.md) for the existing alias resolver. No private selector, numeric CSS, token fork or editor wrapper supplies a substitute.

`node tools/frontend/author-typography-inventory.mjs` enumerates every indexed regular UTF-8 text file, binds full-file bytes and matching line digests, and reports binary/unavailable/aliased/oversized inputs explicitly. It discovers candidates across source, styles, storage, server, tests, configuration and documentation without a known-key list. `verifyAuthorTypographyInventory` re-enumerates physical inputs and rejects content, input-set and receipt drift. The report remains discovery-only: ownership labels are conservative path classifications, not proof of exact legacy readers, writers, scope, CSS effect or safe migration. It cannot authorize deletion or establish residue zero. Public, export and system font owners must remain isolated from author preference migration.

`captureAuthorTypographyContinuity` now consumes the canonical `ArticleEditorRuntimeBinding` returned by the existing Writer's `authoringEditorRuntime.bindEditor`. It calls `binding.positionBinding()` and `binding.continuity.capture()` and returns that owner's sealed context directly. It captures the observed public selection/history and semantic anchor, including manual scroll intent, without a transaction, editor remount, new epoch or second state store. The owner continues to reject missing observations, mismatched surfaces, stale documents and disposed bindings. This capture is preparation for reflow, not evidence that a profile was applied or that focus/viewport restoration succeeded.

Current source has no preference service, reset, migration executor, settings UI, font runtime, typography reflow/restoration or terminal acceptance receipt. The shared binding exists and is consumed; it is no longer a missing dependency. Writer mounting, document/anchor/attachment integration and authoring exports remain owned by the coordinating editor chain. The remaining integration must consume the actual FsusUI typography catalog/font/reflow APIs when offered; no duplicate kernel or preference authority is provided here.
