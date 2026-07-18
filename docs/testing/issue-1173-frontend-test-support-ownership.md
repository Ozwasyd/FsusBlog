# Frontend test support ownership

Issue #1173 removes the secondary `src/frontend/tests/frontend/` tree. The only
frontend test ownership root is now `tests/frontend/`; Vitest and Playwright
configuration stays in `src/frontend/` because it belongs to the frontend package
runner rather than to production source or to a second test suite.

## Canonical layout

| Kind | Canonical ownership |
| --- | --- |
| Test cases and executable checks | `tests/frontend/{unit,property,model,benchmarks,e2e,checks,typecheck}/` |
| Reusable fixtures | `tests/frontend/fixtures/` (plus explicitly classified colocated fixtures) |
| Shared test support | `tests/frontend/support/` |
| Vitest runner configuration | `src/frontend/vitest*.config.ts` |

The happy-dom globals, requestAnimationFrame lifecycle, and WASM mocks are owned
by `tests/frontend/support/unit/setup.ts` and
`tests/frontend/support/unit/animationFrameEnvironment.ts`. The admin-dashboard
visual module is a fixture, so it lives in `tests/frontend/fixtures/` and is served
through Vite's repository-allowlisted `/@fs/` path during that Playwright test.
Vite deduplicates Vue and vue-router for repository-level fixtures only in `serve`
mode; production builds receive an empty dedupe addition. None of these files is
part of an application bundle.

## One setup resolver

`src/frontend/vitest.shared.mjs` exports `frontendUnitSetupFile`, resolved from the
repository root to `tests/frontend/support/unit/setup.ts`. Every unit, property,
model, performance, worker, Wasm, adapter, renderer, composable, and hydration
Vitest config consumes that export directly. A shard may not construct a relative
setup path of its own.

Because the setup now lives outside the package directory, the shared config also
exports `frontendTestDependencyDedupe`. Every setup consumer applies it so Vite
resolves `happy-dom` from `src/frontend/node_modules` through normal package
exports instead of searching from the external support file's directory.

The shared resolver rejects absolute input and path traversal before returning a
support path. The repository checker also loads the real export, confirms that it
equals the canonical file, and verifies that every declared `setupFiles` consumer
uses the same export exactly once.

## Transform-cache identity

`tools/test/frontend-vitest-transform-cache.mjs` includes both canonical unit
support files in `transformCacheConfigFiles`. A change to the setup file or its
animation-frame helper therefore changes `configDigest`; an identity created from
the retired source path cannot be admitted under the new layout. The existing
run/source/toolchain/environment identity, ordinary-to-perf lifecycle, corruption
repair, and fail-closed validation remain unchanged.

## Governance and local check

`tests/governance/frontend-test-layout.json` classifies test cases, fixtures,
support, metadata, runner configs, setup consumers, and cache inputs.
`tools/test/check-frontend-test-layout.mjs` rejects, in one report:

- a new source-local `tests` tree or either retired frontend test root;
- an unclassified frontend-test path or undeclared support namespace;
- setup code outside a declared support namespace;
- a missing, independently resolved, or undeclared Vitest `setupFiles` consumer;
- a moved support file missing from the transform-cache identity; and
- a runtime-environment test importing back through the retired source root.

Run the focused contract with:

```bash
node tools/test/check-frontend-test-layout.mjs
node --test tests/tools/frontend-test-layout.test.mjs \
  tests/tools/frontend-vitest-transform-cache.test.mjs
```

Negative fixtures use isolated temporary repositories and demonstrate explicit
allowlist admission, multi-error collection, unresolved setup rejection, stale
cache identity rejection, and support-category enforcement.

## Risk and rollback

The migration changes paths and cache identity only; happy-dom, animation-frame,
WASM mock, Vitest isolation, coverage, and performance-test semantics are kept.
If a runner cannot load the new support file, revert the issue commit as a unit.
Do not add a compatibility copy or fallback under `src/frontend/tests/`, because
that would recreate two ownership roots and permit stale transform-cache identity.
