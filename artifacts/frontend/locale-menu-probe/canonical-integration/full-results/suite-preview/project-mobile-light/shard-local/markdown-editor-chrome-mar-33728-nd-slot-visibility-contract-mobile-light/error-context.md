# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: markdown-editor-chrome.spec.ts >> markdown editor chrome variants matrix (#429) >> renders toolbar, status, and slot visibility contract
- Location: vue/tests/visual/markdown-editor-chrome.spec.ts:400:13

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('.el-markdown-editor').getByTestId('chrome-visual-status-slot')
Timeout: 20000ms
- Expected substring  -  1
+ Received string     + 11

- 已同步到草稿箱
+ 227 字 · 45 词 · {
+   "mode": "source",
+   "readonly": false,
+   "disabled": false,
+   "loading": false
+ } · supported{
+   "mode": "source",
+   "readonly": false,
+   "disabled": false,
+   "loading": false
+ }

Call log:
  - Expect "toContainText" with timeout 20000ms
  - waiting for locator('.el-markdown-editor').getByTestId('chrome-visual-status-slot')
    24 × locator resolved to <span data-v-525503f0="" data-testid="chrome-visual-status-slot">227 字 · 45 词 · {↵  "mode": "source",↵  "readonly"…</span>
       - unexpected value "227 字 · 45 词 · {
  "mode": "source",
  "readonly": false,
  "disabled": false,
  "loading": false
} · supported{
  "mode": "source",
  "readonly": false,
  "disabled": false,
  "loading": false
}"

```

# Page snapshot

```yaml
- generic [ref=e4]:
  - heading "Markdown Editor Chrome" [level=2] [ref=e5]
  - article [ref=e6]:
    - heading "FsusUI 2.4 发布说明" [level=1] [ref=e7]
    - paragraph [ref=e8]: 编辑器 chrome 变体验收样张 · framed / source
    - region "Markdown 编辑器" [ref=e9]:
      - generic [ref=e10]:
        - generic [ref=e11]:
          - button "加粗" [ref=e12] [cursor=pointer]
          - button "斜体" [ref=e13] [cursor=pointer]
          - button "标题" [ref=e14] [cursor=pointer]
          - button "引用" [ref=e15] [cursor=pointer]
          - button "代码" [ref=e16] [cursor=pointer]
          - button "链接" [ref=e17] [cursor=pointer]
          - button "格式工具，2 个工具" [ref=e18] [cursor=pointer]:
            - generic [ref=e19]: 格式工具
            - generic [ref=e20]: "2"
        - tablist "Markdown 模式" [ref=e21]:
          - tab "源码" [selected] [ref=e22] [cursor=pointer]
          - tab "实时" [ref=e23] [cursor=pointer]
          - tab "预览" [ref=e24] [cursor=pointer]
        - generic [ref=e25]:
          - button "上传图片" [ref=e26] [cursor=pointer]
          - button "保存" [ref=e27] [cursor=pointer]
          - button "提交" [ref=e28] [cursor=pointer]
      - generic [ref=e29]:
        - textbox "Markdown 源码编辑区" [ref=e30]:
          - /placeholder: ""
          - text: "# FsusUI 2.4 发布说明 - 统一事务模型：value、selection、history 全部走单一 transaction store。 - Live 模式：语法 marker reveal 与 caret/scroll 稳定性达标。 - Avalonia 端：FsusMarkdownEditor 共享同一 source 事务合同。 > 兼容 Element Plus 公共 API，主题 token 保持 `--el-*` 优先。"
        - button [ref=e31]
      - generic [ref=e34]: "227 字 · 45 词 · { \"mode\": \"source\", \"readonly\": false, \"disabled\": false, \"loading\": false } · supported{ \"mode\": \"source\", \"readonly\": false, \"disabled\": false, \"loading\": false }"
    - generic [ref=e35]:
      - heading "变更摘要" [level=2] [ref=e36]
      - paragraph [ref=e37]: 本页把同一个编辑器实例嵌入真实文档版式，用于验收 framed、embedded、 minimal 三种 chrome 在 source、live、split、preview 四个 mode 下的 geometry、focus、语义与可访问性表现。
```

# Test source

```ts
  326 | 
  327 |         // Mutation gate for the mobile toolbar overlap: the mode switcher and
  328 |         // the action row must not intersect, so every switchable tab stays
  329 |         // reachable to pointer and touch input at narrow viewports.
  330 |         const modesRect = await editor
  331 |           .locator('.el-markdown-editor__modes')
  332 |           .boundingBox()
  333 |         const actionsRect = await editor
  334 |           .locator('.el-markdown-editor__actions')
  335 |           .boundingBox()
  336 |         if (modesRect && actionsRect) {
  337 |           const intersects =
  338 |             modesRect.x < actionsRect.x + actionsRect.width &&
  339 |             actionsRect.x < modesRect.x + modesRect.width &&
  340 |             modesRect.y < actionsRect.y + actionsRect.height &&
  341 |             actionsRect.y < modesRect.y + modesRect.height
  342 |           expect(
  343 |             intersects,
  344 |             `${width}px viewport must not overlay actions on the mode switcher`,
  345 |           ).toBe(false)
  346 |         }
  347 |         await expect(
  348 |           editor.locator('.el-markdown-editor__status'),
  349 |         ).toBeVisible()
  350 |       }
  351 |     },
  352 |   )
  353 | 
  354 |   visualTest(
  355 |     'stays usable at 150% and 200% zoom',
  356 |     async ({ page }, testInfo) => {
  357 |       for (const zoom of [1.5, 2]) {
  358 |         const editor = await openChromeCell(page, testInfo.project.name, {
  359 |           chrome: 'embedded',
  360 |           mode: 'split',
  361 |         })
  362 |         await editor.evaluate((element, zoomValue) => {
  363 |           ;(element as HTMLElement).style.zoom = String(zoomValue)
  364 |         }, zoom)
  365 |         await waitForFontsAndLayout(page)
  366 |         const overflow = await editor.evaluate((element) => {
  367 |           const root = element.ownerDocument.documentElement
  368 |           return root.scrollWidth - root.clientWidth
  369 |         })
  370 |         expect(overflow).toBeLessThanOrEqual(1)
  371 |         await expect(page).toHaveScreenshot([
  372 |           'chrome-evidence',
  373 |           `zoom-${Math.round(zoom * 100)}.png`,
  374 |         ])
  375 |       }
  376 |     },
  377 |   )
  378 | 
  379 |   visualTest(
  380 |     'responds to touch activation on the mode switcher',
  381 |     async ({ browser }, testInfo) => {
  382 |       const context = await browser.newContext({
  383 |         hasTouch: true,
  384 |         viewport: { width: 768, height: 1024 },
  385 |       })
  386 |       const page = await context.newPage()
  387 |       const editor = await openChromeCell(page, testInfo.project.name, {
  388 |         chrome: 'framed',
  389 |         mode: 'source',
  390 |       })
  391 |       const liveTab = editor.locator(
  392 |         `[role="tablist"] button.${nsModeClass('live')}`,
  393 |       )
  394 |       await liveTab.tap()
  395 |       await expect(editor).toHaveClass(/el-markdown-editor--live/)
  396 |       await context.close()
  397 |     },
  398 |   )
  399 | 
  400 |   visualTest(
  401 |     'renders toolbar, status, and slot visibility contract',
  402 |     async ({ page }, testInfo) => {
  403 |       const editor = await openChromeCell(page, testInfo.project.name, {
  404 |         chrome: 'framed',
  405 |         mode: 'source',
  406 |         status: 'hidden',
  407 |       })
  408 |       await expect(editor.locator('.el-markdown-editor__status')).toHaveCount(0)
  409 | 
  410 |       const withoutToolbar = await openChromeCell(page, testInfo.project.name, {
  411 |         chrome: 'framed',
  412 |         mode: 'source',
  413 |         toolbar: 'off',
  414 |       })
  415 |       await expect(
  416 |         withoutToolbar.locator('.el-markdown-editor__toolbar'),
  417 |       ).toHaveCount(0)
  418 | 
  419 |       const slotted = await openChromeCell(page, testInfo.project.name, {
  420 |         chrome: 'framed',
  421 |         mode: 'source',
  422 |         slot: 'status',
  423 |       })
  424 |       await expect(
  425 |         slotted.getByTestId('chrome-visual-status-slot'),
> 426 |       ).toContainText('已同步到草稿箱')
      |         ^ Error: expect(locator).toContainText(expected) failed
  427 |     },
  428 |   )
  429 | 
  430 |   visualTest(
  431 |     'covers empty, disabled, loading, and readonly states',
  432 |     async ({ page }, testInfo) => {
  433 |       const empty = await openChromeCell(page, testInfo.project.name, {
  434 |         chrome: 'framed',
  435 |         mode: 'source',
  436 |         state: 'empty',
  437 |       })
  438 |       await expect(empty.locator('textarea')).toHaveAttribute(
  439 |         'placeholder',
  440 |         /.+/,
  441 |       )
  442 | 
  443 |       const disabled = await openChromeCell(page, testInfo.project.name, {
  444 |         chrome: 'framed',
  445 |         mode: 'source',
  446 |         state: 'disabled',
  447 |       })
  448 |       await expect(disabled.locator('textarea')).toBeDisabled()
  449 | 
  450 |       const loading = await openChromeCell(page, testInfo.project.name, {
  451 |         chrome: 'framed',
  452 |         mode: 'source',
  453 |         state: 'loading',
  454 |       })
  455 |       await expect(loading.locator('textarea')).toHaveAttribute(
  456 |         'aria-busy',
  457 |         'true',
  458 |       )
  459 | 
  460 |       const readonly = await openChromeCell(page, testInfo.project.name, {
  461 |         chrome: 'framed',
  462 |         mode: 'source',
  463 |         state: 'readonly',
  464 |       })
  465 |       await expect(readonly.locator('textarea')).toHaveAttribute('readonly', '')
  466 | 
  467 |       const long = await openChromeCell(page, testInfo.project.name, {
  468 |         chrome: 'minimal',
  469 |         mode: 'preview',
  470 |         state: 'long',
  471 |       })
  472 |       await expect(long.locator('[data-markdown-renderer]')).toBeVisible()
  473 |     },
  474 |   )
  475 | 
  476 |   visualTest(
  477 |     'falls back without WebAssembly and stays operable',
  478 |     async ({ browser }, testInfo) => {
  479 |       // Capability fallback simulation (local): the .wasm asset is unavailable,
  480 |       // so the markdown runtime must degrade per its JavaScript fallback and
  481 |       // the editor must never expose a second input pipeline or crash.
  482 |       const context = await browser.newContext({
  483 |         viewport: { width: 1280, height: 900 },
  484 |       })
  485 |       const fallbackPage = await context.newPage()
  486 |       await fallbackPage.route('**/*.wasm', (route) => route.abort())
  487 |       await fallbackPage.goto(
  488 |         buildVisualUrl(VISUAL_SECTION, testInfo.project.name, {
  489 |           chrome: 'framed',
  490 |           mode: 'preview',
  491 |         }),
  492 |         { waitUntil: 'domcontentloaded' },
  493 |       )
  494 |       await expect(fallbackPage.locator('vite-error-overlay')).toHaveCount(0)
  495 |       const editor = fallbackPage.locator(EDITOR_SELECTOR)
  496 |       await expect(editor).toBeVisible()
  497 |       await expect(editor.locator('textarea')).toHaveCount(1)
  498 |       const renderer = editor.locator('[data-markdown-renderer]')
  499 |       await expect(renderer).toBeVisible()
  500 |       await expect
  501 |         .poll(async () => (await renderer.textContent())?.length ?? 0, {
  502 |           timeout: 30_000,
  503 |         })
  504 |         .toBeGreaterThan(0)
  505 |       const evidence = {
  506 |         candidate: process.env.GITHUB_SHA ?? 'local',
  507 |         fixture:
  508 |           'markdown-editor-chrome-visual preview with .wasm requests aborted',
  509 |         textareaCount: await editor.locator('textarea').count(),
  510 |         rendererCount: await renderer.count(),
  511 |       }
  512 |       await testInfo.attach('projection-fallback.json', {
  513 |         body: JSON.stringify(evidence, null, 2),
  514 |         contentType: 'application/json',
  515 |       })
  516 |       await context.close()
  517 |     },
  518 |   )
  519 | 
  520 |   visualTest(
  521 |     'keeps framed geometry under forced colors',
  522 |     async ({ page }, testInfo) => {
  523 |       await page.emulateMedia({ forcedColors: 'active' })
  524 |       const editor = await openChromeCell(page, testInfo.project.name, {
  525 |         chrome: 'framed',
  526 |         mode: 'source',
```