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
