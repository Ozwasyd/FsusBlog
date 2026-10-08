# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: markdown-editor-chrome.spec.ts >> markdown editor chrome variants matrix (#429) >> stays usable at 150% and 200% zoom
- Location: vue/tests/visual/markdown-editor-chrome.spec.ts:354:13

# Error details

```
Error: expect(page).toHaveScreenshot(expected) failed

  26274 pixels (ratio 0.06 of all image pixels) are different.

  Snapshot: chrome-evidence/zoom-150.png

Call log:
  - Expect "toHaveScreenshot(chrome-evidence/zoom-150.png)" with timeout 20000ms
    - verifying given screenshot expectation
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - 26274 pixels (ratio 0.06 of all image pixels) are different.
  - waiting 100ms before taking screenshot
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - captured a stable screenshot
  - 26274 pixels (ratio 0.06 of all image pixels) are different.

```

# Page snapshot

```yaml
- generic [ref=e4]:
  - heading "Markdown Editor Chrome" [level=2] [ref=e5]
  - article [ref=e6]:
    - heading "FsusUI 2.4 发布说明" [level=1] [ref=e7]
    - paragraph [ref=e8]: 编辑器 chrome 变体验收样张 · embedded / split
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
          - tab "源码" [ref=e22] [cursor=pointer]
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
        - article [ref=e33]:
          - generic [ref=e34]:
            - heading "FsusUI 2.4 发布说明" [level=1] [ref=e35]
            - list [ref=e36]:
              - listitem [ref=e37]: 统一事务模型：value、selection、history 全部走单一 transaction store。
              - listitem [ref=e38]: Live 模式：语法 marker reveal 与 caret/scroll 稳定性达标。
              - listitem [ref=e39]: Avalonia 端：FsusMarkdownEditor 共享同一 source 事务合同。
            - blockquote [ref=e40]:
              - paragraph [ref=e41]:
                - text: 兼容 Element Plus 公共 API，主题 token 保持
                - code [ref=e42]: "--el-*"
                - text: 优先。
    - generic [ref=e43]:
      - heading "变更摘要" [level=2] [ref=e44]
      - paragraph [ref=e45]: 本页把同一个编辑器实例嵌入真实文档版式，用于验收 framed、embedded、 minimal 三种 chrome 在 source、live、split、preview 四个 mode 下的 geometry、focus、语义与可访问性表现。
```

# Test source

```ts
  271 |           await expect(editor).toHaveClass(/el-markdown-editor--live/)
  272 |         }
  273 |       }
  274 |     },
  275 |   )
  276 | 
  277 |   visualTest(
  278 |     'exposes an accessible tree without decorative chrome',
  279 |     async ({ page }, testInfo) => {
  280 |       for (const chrome of CHROME_VARIANTS) {
  281 |         const editor = await openChromeCell(page, testInfo.project.name, {
  282 |           chrome,
  283 |           mode: 'split',
  284 |         })
  285 |         await expect(editor).toHaveAttribute('data-markdown-instance', /.+/)
  286 |         // Screen-reader simulation evidence (local): the aria snapshot tree
  287 |         // must expose the labelled input owner and the rendered preview, plus
  288 |         // the mode tablist whenever the chrome keeps a mode switcher (minimal
  289 |         // leaves mode composition to the caller). No real screen reader
  290 |         // hardware is required; the aria tree is the a11y authority here.
  291 |         const snapshot = await editor.ariaSnapshot()
  292 |         expect(snapshot).toContain('textbox')
  293 |         if (chrome !== 'minimal') {
  294 |           expect(snapshot).toContain('tablist')
  295 |         }
  296 |         await testInfo.attach(`aria-tree-${chrome}.yml`, {
  297 |           body: snapshot,
  298 |           contentType: 'text/yaml',
  299 |         })
  300 |       }
  301 |     },
  302 |   )
  303 | 
  304 |   visualTest(
  305 |     'keeps geometry intact across 375/768/1366/1440 viewports',
  306 |     async ({ page, useVisualViewport }, testInfo) => {
  307 |       for (const [viewport, width] of [
  308 |         ['markdown-editor-375', 375],
  309 |         ['markdown-editor-768', 768],
  310 |         ['markdown-editor-1366', 1366],
  311 |         ['markdown-editor-1440', 1440],
  312 |       ] as const) {
  313 |         await useVisualViewport(viewport)
  314 |         const editor = await openChromeCell(page, testInfo.project.name, {
  315 |           chrome: 'framed',
  316 |           mode: 'live',
  317 |         })
  318 |         const overflow = await editor.evaluate((element) => {
  319 |           const root = element.ownerDocument.documentElement
  320 |           return root.scrollWidth - root.clientWidth
  321 |         })
  322 |         expect(
  323 |           overflow,
  324 |           `${width}px viewport must not introduce horizontal overflow`,
  325 |         ).toBeLessThanOrEqual(1)
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
> 371 |         await expect(page).toHaveScreenshot([
      |                            ^ Error: expect(page).toHaveScreenshot(expected) failed
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
  426 |       ).toContainText('已同步到草稿箱')
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
```