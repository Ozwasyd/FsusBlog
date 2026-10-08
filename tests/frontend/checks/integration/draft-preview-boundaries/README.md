# Draft preview boundary integration

Run from the FsusBlog repository root:

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/fsus-draft-boundaries-browser/browsers \
  node src/frontend/node_modules/playwright/cli.js install chromium
node tests/frontend/checks/integration/draft-preview-boundaries/run-browser.mjs
```

The runner uses the installed frontend Vite/Playwright dependencies, the canonical
`src/frontend/scripts/fsusui-local.ts` alias factory, and the canonical source-root
resolver. A real local FsusUI checkout and its existing WASM/theme assets are required.
It writes per-run JSON results, screenshots and DOM evidence beneath
`/tmp/fsus-draft-boundaries-browser`. The first failing case is preserved with an
exclusive write; later runs do not overwrite it. An alternative evidence root can be
selected with `FSUSBLOG_DRAFT_BROWSER_EVIDENCE`. The loopback server owns port 4179
with `strictPort: true` and closes when the runner finishes.

The browser executes real `ArticleFsusUiRenderProducer`, `ArticleRenderCache`,
`ArticleDocumentContextAdapter`, `ArticleAnchorContextAdapter`, public position maps,
and the mounted public `ElMarkdownRenderer`. Coverage includes identical-source
document isolation, anchor rejection after a document switch, user-scope clearing,
owner disposal, and canceled/late result isolation while retaining a valid stale view.
The only scheduling seam delays delivery of an actual canonical producer result;
it creates no render result or receipt and does not claim to interrupt synchronous WASM.

These are isolated owner/public-component integration tests. They do not establish
the production preview route, permission endpoint, authentication-route unmount
wiring, native IME, browser scroll restoration, published-package qualification,
or formal UX acceptance. Permission revocation is recorded as **unrun**: the source
admission owner explicitly leaves rendering, rights, assets and complete preview
identity to other gates. No test-only termination callback fills that gap.

`FSUSBLOG_DRAFT_SOURCE_ROOT` can select a real isolated Blog checkout for the same
owner surface. Reports capture its exact HEAD, dirty state and source file digests,
plus the active UI HEAD/dirty state and harness digests. A source override does not
create a missing API or prove product wiring. Artifacts are observations, not release
or production receipts.

The adjacent `vitest.config.ts` composes the original canonical unit configuration
with the production public-component resolver for internally created SSR apps. It
does not replace component implementations, owner APIs, aliases, setup or test gates.

```sh
cd src/frontend
node node_modules/vitest/vitest.mjs run \
  --config ../../tests/frontend/checks/integration/draft-preview-boundaries/vitest.config.ts \
  ../../tests/frontend/unit/integration/draftPreviewPublishedBoundaries.test.ts
```

The mounted Writer probe requires the actual public three-layer host port shipped
in Blog `790b3abb4c6de0da2d9fe177c04c05e7ce8695cc`; the older stacked QA base does
not contain that API. Run its unchanged test file in an isolated checkout of that
exact owner commit, using the real local UI at
`f2b3bb89ffe5f749da26c388f058efdbb6aee864` and configured frontend dependencies:

```sh
# From that owner checkout's src/frontend, after copying only the QA test:
FSUSBLOG_USE_LOCAL_FSUSUI=1 FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI \
FSUSBLOG_VITEST_REPORT_ID=mounted-writer-real-port-frozen \
node node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  ../../tests/frontend/unit/integration/mountedWriterDraftBoundaries.test.ts
```

This host acquires the editor exclusively through
`ArticleWriteEditor.getAuthoringEditorPort()` and consumes actual forwarded
transaction, selection and focus events through the shipped runtime binding.
It verifies port identity against the mounted public editor. The exact-source
run has **2 passes and 2 failures**: port/events/continuity and pending-request
unmount cancellation pass; two successful-render assertions fail because the
real WASM runtime is unavailable in that Vitest environment. A cancellation
pass does not prove successful rendering, the complete `Write.vue` route, or
permission revocation. The separate Chromium suite exercises actual successful
rendering and retained late-result disposal on its stated older owner source.

The four same-mounted comment retry-ID regressions use the unchanged
`commentPendingIdentityBoundaries.test.ts` in the canonical comment owner's
checkout at `cebd4ba362714b732dcf508abbed18e0910d7bb6`:

```sh
# From that owner checkout's src/frontend, after copying only the QA test:
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI \
FSUSBLOG_VITEST_REPORT_ID=comment-boundaries-owner-fix-counterexamples \
node node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  ../../tests/frontend/unit/integration/commentPendingIdentityBoundaries.test.ts \
  -t 'same mounted composer'
```

Independent replay has **4 passes**, with the other 10 cases intentionally unrun.
The old `b4aa6c403e44b12242e9239cd2e4227f6eb660c0` failures remain preserved;
the new result does not qualify the owner's broader admission, browser or types.
