# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: markdown-editor-chrome.spec.ts >> markdown editor chrome variants matrix (#429) >> keeps one editor instance through rapid mode switches
- Location: vue/tests/visual/markdown-editor-chrome.spec.ts:186:13

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 6

- Array []
+ Array [
+   "requestfailed: GET http://127.0.0.1:4173/assets/typescript-BqvgUolh.js net::ERR_ABORTED",
+   "requestfailed: GET http://127.0.0.1:4173/assets/github-light-Rcb2q3L5.js net::ERR_ABORTED",
+   "requestfailed: GET http://127.0.0.1:4173/assets/engine-javascript-ZX5pI3G3.js net::ERR_ABORTED",
+   "requestfailed: GET http://127.0.0.1:4173/assets/core-Cmkhzapn.js net::ERR_ABORTED",
+ ]
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
          - tab "源码" [active] [selected] [ref=e22] [cursor=pointer]
          - tab "实时" [ref=e23] [cursor=pointer]
          - tab "预览" [ref=e24] [cursor=pointer]
        - generic [ref=e25]:
          - button "上传图片" [ref=e26] [cursor=pointer]
          - button "保存" [ref=e27] [cursor=pointer]
          - button "提交" [ref=e28] [cursor=pointer]
      - generic [ref=e29]:
        - textbox "Markdown 源码编辑区" [ref=e30]:
          - /placeholder: ""
          - text: "# FsusUI 2.4 变更日志 本页为长文档验收样张，用于验证滚动容器、虚拟窗口与异步高度变化下的 chrome 变体稳定性。以下条目按里程碑分组，内容为真实发布说明。 ## 里程碑 1 - 统一 command registry 与 async lifecycle，toolbar、键盘、selection 表面共享同一 snapshot。 - 证据：focused unit、Playwright interaction、视觉与 a11y 矩阵。 ```ts const milestone = \"m-1\" // verified on candidate ``` ## 里程碑 1 - 帧调度权威：layout read 收敛到 measure 阶段，write 收敛到 mutate 阶段，杜绝同帧读写回环。 - 证据：focused unit、Playwright interaction、视觉与 a11y 矩阵。 ```ts const milestone = \"m-2\" // verified on candidate ``` ## 里程碑 2 - 粘贴审阅：HTML 转 Markdown 提供结构化 diff 与逐类确认。 - 证据：focused unit、Playwright interaction、视觉与 a11y 矩阵。 ```ts const milestone = \"m-3\" // verified on candidate ``` ## 里程碑 2 - 表格编辑：结构化行列操作保持 undo/redo 粒度与 selection 方向。 - 证据：focused unit、Playwright interaction、视觉与 a11y 矩阵。 ```ts const milestone = \"m-4\" // verified on candidate ``` ## 里程碑 3 - 搜索高亮：跨模式 reveal 与导航优先级规则确定。 - 证据：focused unit、Playwright interaction、视觉与 a11y 矩阵。 ```ts const milestone = \"m-5\" // verified on candidate ``` ## 里程碑 3 - 附件媒体：source/live 双表面 atomic 呈现与可访问总验收。 - 证据：focused unit、Playwright interaction、视觉与 a11y 矩阵。 ```ts const milestone = \"m-6\" // verified on candidate ``` ## 里程碑 4 - 语言工具：原生 web language session 接入编辑器投影。 - 证据：focused unit、Playwright interaction、视觉与 a11y 矩阵。 ```ts const milestone = \"m-7\" // verified on candidate ``` ## 里程碑 4 - 锚点语法：`^anchor-id` 唯一性、fragment 映射与安全矩阵收口。 - 证据：focused unit、Playwright interaction、视觉与 a11y 矩阵。 ```ts const milestone = \"m-8\" // verified on candidate ```"
        - button [ref=e31]
      - generic [ref=e34]:
        - generic [ref=e35]: 1472 字符
        - generic [ref=e36]: 300 词
    - generic [ref=e37]:
      - heading "变更摘要" [level=2] [ref=e38]
      - paragraph [ref=e39]: 本页把同一个编辑器实例嵌入真实文档版式，用于验收 framed、embedded、 minimal 三种 chrome 在 source、live、split、preview 四个 mode 下的 geometry、focus、语义与可访问性表现。
```

# Test source

```ts
  35  | const waitForFontsAndLayout = async (page: Page) => {
  36  |   await page.evaluate(async () => {
  37  |     await document.fonts.ready
  38  |     await new Promise<void>((resolve) => {
  39  |       requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  40  |     })
  41  |   })
  42  | }
  43  | 
  44  | const openChromeCell = async (
  45  |   page: Page,
  46  |   projectName: string,
  47  |   query: Record<string, string> = {},
  48  | ) => {
  49  |   await page.goto(buildVisualUrl(VISUAL_SECTION, projectName, query), {
  50  |     waitUntil: 'domcontentloaded',
  51  |   })
  52  |   await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  53  |   const editor = page.locator(EDITOR_SELECTOR)
  54  |   await expect(editor).toBeVisible()
  55  |   await stabilizePage(page)
  56  |   await waitForFontsAndLayout(page)
  57  |   // The frame scheduler samples per-frame metrics; an empty pending queue
  58  |   // means every scheduled layout commit has settled for this cell.
  59  |   await expect
  60  |     .poll(async () => editor.getAttribute('data-markdown-frame-metrics'))
  61  |     .not.toBeNull()
  62  |   return editor
  63  | }
  64  | 
  65  | const expectSurfacePlan = async (
  66  |   editor: ReturnType<Page['locator']>,
  67  |   mode: string,
  68  | ) => {
  69  |   const textarea = editor.locator('textarea')
  70  |   const renderer = editor.locator('[data-markdown-renderer]')
  71  |   // Mode class contract: the root carries the active mode modifier.
  72  |   await expect(editor).toHaveClass(new RegExp(`el-markdown-editor--${mode}`))
  73  |   // Single logical input/selection owner: the source textarea stays the
  74  |   // owner in source/live/split and only preview hides it. The renderer
  75  |   // element belongs to split/preview only; live composes decorations over
  76  |   // the input owner instead of a second surface.
  77  |   await expect(textarea).toHaveCount(1)
  78  |   if (mode === 'preview') {
  79  |     await expect(textarea).toBeHidden()
  80  |   } else {
  81  |     await expect(textarea).toBeVisible()
  82  |   }
  83  |   await expect(renderer).toHaveCount(
  84  |     mode === 'split' || mode === 'preview' ? 1 : 0,
  85  |   )
  86  |   if (mode === 'split' || mode === 'preview') {
  87  |     await expect(renderer).toBeVisible()
  88  |     await expect
  89  |       .poll(async () => (await renderer.textContent())?.length ?? 0, {
  90  |         timeout: 30_000,
  91  |       })
  92  |       .toBeGreaterThan(0)
  93  |   }
  94  |   if (mode === 'live') {
  95  |     // Live projection decorations exist over the single input owner; they
  96  |     // are aria-hidden presentation, never a second editable surface.
  97  |     await expect(
  98  |       editor.locator('[data-markdown-live-decorations]'),
  99  |     ).toHaveCount(1)
  100 |   }
  101 | }
  102 | 
  103 | const expectChromeRegions = async (
  104 |   page: Page,
  105 |   editor: ReturnType<Page['locator']>,
  106 |   chrome: string,
  107 | ) => {
  108 |   // No empty shells: each region renders only when its chrome keeps it.
  109 |   await expect(editor.locator('.el-markdown-editor__toolbar')).toHaveCount(
  110 |     chrome === 'minimal' ? 0 : 1,
  111 |   )
  112 |   await expect(editor.locator('.el-markdown-editor__status')).toHaveCount(
  113 |     chrome === 'framed' ? 1 : 0,
  114 |   )
  115 |   // One editor instance, one scroll container pair, no second surface.
  116 |   await expect(editor).toHaveCount(1)
  117 |   await expect(page.locator('[data-markdown-scroll-container]')).toHaveCount(2)
  118 | }
  119 | 
  120 | const expectModeSwitcher = async (
  121 |   editor: ReturnType<Page['locator']>,
  122 |   chrome: string,
  123 | ) => {
  124 |   // The minimal chrome leaves mode composition to the caller.
  125 |   await expect(editor.locator('[role="tablist"]')).toHaveCount(
  126 |     chrome === 'minimal' ? 0 : 1,
  127 |   )
  128 | }
  129 | 
  130 | test.beforeEach(async ({ page }) => {
  131 |   diagnostics.set(page, attachPageDiagnostics(page))
  132 | })
  133 | 
  134 | test.afterEach(async ({ page }) => {
> 135 |   expect(diagnostics.get(page) ?? []).toEqual([])
      |                                       ^ Error: expect(received).toEqual(expected) // deep equality
  136 | })
  137 | 
  138 | test.describe('markdown editor chrome variants matrix (#429)', () => {
  139 |   for (const chrome of CHROME_VARIANTS) {
  140 |     for (const mode of MODES) {
  141 |       visualTest(
  142 |         `renders ${chrome} chrome in ${mode} mode with correct geometry and semantics`,
  143 |         async ({ page }, testInfo) => {
  144 |           const editor = await openChromeCell(page, testInfo.project.name, {
  145 |             chrome,
  146 |             mode,
  147 |           })
  148 | 
  149 |           await expectChromeRegions(page, editor, chrome)
  150 |           await expectModeSwitcher(editor, chrome)
  151 |           await expectSurfacePlan(editor, mode)
  152 | 
  153 |           // Focus ring stays on the control contract for every chrome, and
  154 |           // the textarea keeps its accessible label while it is the visible
  155 |           // input owner (preview hides it from the accessibility tree).
  156 |           await expect(editor).toHaveAttribute('data-markdown-instance', /.+/)
  157 |           if (mode !== 'preview') {
  158 |             await expect(editor.locator('textarea')).toHaveAccessibleName(/.+/)
  159 |           }
  160 | 
  161 |           // Chrome must not add decoration: no card/badge/glass artifacts on
  162 |           // the preview surface, and embedded/minimal drop the outer material.
  163 |           const rootBorder = await editor.evaluate((element) => {
  164 |             const style = getComputedStyle(element)
  165 |             return {
  166 |               borderColor: style.borderTopColor,
  167 |               borderStyle: style.borderTopStyle,
  168 |               borderRadius: style.borderTopLeftRadius,
  169 |             }
  170 |           })
  171 |           if (chrome === 'framed') {
  172 |             expect(rootBorder.borderStyle).not.toBe('none')
  173 |           } else {
  174 |             expect(rootBorder.borderStyle).toBe('none')
  175 |           }
  176 | 
  177 |           await expect(page).toHaveScreenshot([
  178 |             'chrome-matrix',
  179 |             `${chrome}-${mode}.png`,
  180 |           ])
  181 |         },
  182 |       )
  183 |     }
  184 |   }
  185 | 
  186 |   visualTest(
  187 |     'keeps one editor instance through rapid mode switches',
  188 |     async ({ page }, testInfo) => {
  189 |       const editor = await openChromeCell(page, testInfo.project.name, {
  190 |         chrome: 'framed',
  191 |         mode: 'source',
  192 |         state: 'long',
  193 |       })
  194 |       const textarea = editor.locator('textarea')
  195 |       const instanceId = await editor.getAttribute('data-markdown-instance')
  196 |       const valueBefore = await textarea.inputValue()
  197 |       await textarea.click()
  198 |       await textarea.evaluate((element) => {
  199 |         ;(element as HTMLTextAreaElement).setSelectionRange(2, 10, 'forward')
  200 |       })
  201 | 
  202 |       for (let round = 0; round < 2; round += 1) {
  203 |         for (const label of ['live', 'split', 'preview', 'source']) {
  204 |           // Locale labels are translated; switch by the stable mode class.
  205 |           // Compact mobile layouts keep only source and preview switchable;
  206 |           // hidden tabs stay in the DOM but must not be clicked.
  207 |           const tab = editor.locator(
  208 |             `[role="tablist"] button.${nsModeClass(label)}`,
  209 |           )
  210 |           if (!(await tab.isVisible())) continue
  211 |           await tab.click()
  212 |           await expect(editor).toHaveClass(
  213 |             new RegExp(`el-markdown-editor--${label}`),
  214 |           )
  215 |           if (label === 'preview') {
  216 |             await expect(
  217 |               editor.locator('[data-markdown-renderer]'),
  218 |             ).toBeVisible()
  219 |           }
  220 |         }
  221 |       }
  222 | 
  223 |       await expect(textarea).toBeVisible()
  224 |       await expect(editor).toHaveAttribute(
  225 |         'data-markdown-instance',
  226 |         instanceId ?? '',
  227 |       )
  228 |       expect(await textarea.inputValue()).toBe(valueBefore)
  229 |       expect(
  230 |         await textarea.evaluate(
  231 |           (element) =>
  232 |             `${(element as HTMLTextAreaElement).selectionStart}:${
  233 |               (element as HTMLTextAreaElement).selectionEnd
  234 |             }`,
  235 |         ),
```