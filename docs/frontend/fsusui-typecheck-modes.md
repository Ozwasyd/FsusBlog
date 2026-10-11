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

### Consumer Source Initialization

With the original locked public dependencies already installed and the required
theme/Wasm assets already present in the source checkout, initialize the consumer
from its FsusBlog repository root:

```bash
node src/frontend/scripts/prepare-local-fsusui-install.mjs verify \
  --frontend-root src/frontend --fsusui-root /absolute/path/FsusUI
```

This command verifies the original manifest, lock, source dependencies and assets;
it does not install packages or generate missing assets. It writes a real source
copy under this consumer's ignored `.tmp/fsusui-source/<source-root-sha256>`.
The directory key hashes the canonical owner path. The copy contains the actual
Vue source, declarations and existing assets, omitting owner dependency trees,
Git metadata and temporary/cache directories. Its marker binds the source owner,
consumer frontend and source-content digest. The owner checkout stays read-only;
each linked FsusBlog worktree initializes its own independent copy.

The internal `resolveLocalFsusUiRepositoryRoot` API selects this verified copy
once it exists. Before initialization, it retains the original owner selection.
The external `fsusui-root.mjs` CLI prints the owner Git-worktree root for identity,
including when its input names an owned copy; that output does not certify copy
freshness. Source consumption uses the internal API rather than treating the
identity output as the initialized dependency projection.

Selection verifies both owner and copy content, the consumer dependency root,
every locked alias target/name/version and complete package-link membership.
Unexpected nearer `node_modules` directories fail. Source changes or copy drift
require rerunning initialization; stale or invalid copies do not silently fall
back to the owner. Initialization validates existing `.tmp` and `fsusui-source`
ancestors before creating directories, refuses redirected or owner-contained
destinations, and replaces only an owned copy. A failed preparation preserves the
previous published copy. It neither repairs existing owner dependency pollution
nor authorizes downloading missing dependencies or generating missing assets.

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
and their installed identities, then initializes the consumer source copy above.
Within that copy, each original source import name is linked to its verified
public dependency through `vue/packages/node_modules`. The copy's root
`node_modules` link points to this consumer's `src/frontend/node_modules`, so
declarations outside `vue/packages` and component source resolve one consumer
Vue identity. The original FsusUI checkout's dependency links are not rewritten.
Source imports retain the locked nested KaTeX version instead of accidentally
selecting the different root version. A missing dependency is an error, not
permission to resolve or update the lock.

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

For the complete application with source aliases, run
`node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application` from the
repository root. The existing producer inherits every app/Wasm/SFC include and
strict compiler setting from `tsconfig.app.json`, adds the local declarations,
and resolves Vue and `@vue/*` through the consumer's installed dependencies.
The generated project lives under `src/frontend/.tmp/typecheck`, so each
worktree resolves its own installed type libraries. The complete application
inherits the original app's `types` list; the focused contract project separately
retains its original `vite/client` and Node types.
Composite emission is disabled for this source-consumption typecheck; strictness,
unused checks and the application's syntax checks remain inherited.

Canonical ESLint and the standard style executor select this same complete
project when local source consumption is enabled. They do not use the three
export-contract fixtures as the application program. Invalid configured local
roots fail closed. With `FSUSBLOG_USE_LOCAL_FSUSUI=0`, the original registry
project service remains active. Local-source style checks recheck mutable
external source types without the registry-mode ESLint content cache.
