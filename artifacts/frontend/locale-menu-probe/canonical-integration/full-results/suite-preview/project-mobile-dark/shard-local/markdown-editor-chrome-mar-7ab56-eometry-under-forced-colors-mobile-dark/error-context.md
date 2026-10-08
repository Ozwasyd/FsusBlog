# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: markdown-editor-chrome.spec.ts >> markdown editor chrome variants matrix (#429) >> keeps framed geometry under forced colors
- Location: vue/tests/visual/markdown-editor-chrome.spec.ts:520:13

# Error details

```
Error: expect(page).toHaveScreenshot(expected) failed

  22258 pixels (ratio 0.05 of all image pixels) are different.

  Snapshot: chrome-evidence/forced-colors.png

Call log:
  - Expect "toHaveScreenshot(chrome-evidence/forced-colors.png)" with timeout 20000ms
    - verifying given screenshot expectation
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - 22258 pixels (ratio 0.05 of all image pixels) are different.
  - waiting 100ms before taking screenshot
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - captured a stable screenshot
  - 22258 pixels (ratio 0.05 of all image pixels) are different.

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
      - generic [ref=e34]:
        - generic [ref=e35]: 227 字符
        - generic [ref=e36]: 45 词
    - generic [ref=e37]:
      - heading "变更摘要" [level=2] [ref=e38]
      - paragraph [ref=e39]: 本页把同一个编辑器实例嵌入真实文档版式，用于验收 framed、embedded、 minimal 三种 chrome 在 source、live、split、preview 四个 mode 下的 geometry、focus、语义与可访问性表现。
```

# Test source

```ts
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
  527 |       })
  528 |       const border = await editor.evaluate((element) => {
  529 |         const style = getComputedStyle(element)
  530 |         return { color: style.borderTopColor, style: style.borderTopStyle }
  531 |       })
  532 |       expect(border.style).not.toBe('none')
> 533 |       await expect(page).toHaveScreenshot([
      |                          ^ Error: expect(page).toHaveScreenshot(expected) failed
  534 |         'chrome-evidence',
  535 |         'forced-colors.png',
  536 |       ])
  537 |     },
  538 |   )
  539 | })
  540 | 
```