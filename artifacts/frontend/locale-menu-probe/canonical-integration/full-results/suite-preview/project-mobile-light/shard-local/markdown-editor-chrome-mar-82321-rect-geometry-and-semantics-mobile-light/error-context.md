# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: markdown-editor-chrome.spec.ts >> markdown editor chrome variants matrix (#429) >> renders minimal chrome in live mode with correct geometry and semantics
- Location: vue/tests/visual/markdown-editor-chrome.spec.ts:141:17

# Error details

```
Error: expect(page).toHaveScreenshot(expected) failed

  17761 pixels (ratio 0.04 of all image pixels) are different.

  Snapshot: chrome-matrix/minimal-live.png

Call log:
  - Expect "toHaveScreenshot(chrome-matrix/minimal-live.png)" with timeout 20000ms
    - verifying given screenshot expectation
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - 17761 pixels (ratio 0.04 of all image pixels) are different.
  - waiting 100ms before taking screenshot
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - captured a stable screenshot
  - 17761 pixels (ratio 0.04 of all image pixels) are different.

```

# Page snapshot

```yaml
- generic [ref=e4]:
  - heading "Markdown Editor Chrome" [level=2] [ref=e5]
  - article [ref=e6]:
    - heading "FsusUI 2.4 发布说明" [level=1] [ref=e7]
    - paragraph [ref=e8]: 编辑器 chrome 变体验收样张 · minimal / live
    - region "Markdown 编辑器" [ref=e9]:
      - generic [ref=e10]:
        - textbox "Markdown 实时编辑区" [ref=e11]:
          - /placeholder: ""
          - text: "# FsusUI 2.4 发布说明 - 统一事务模型：value、selection、history 全部走单一 transaction store。 - Live 模式：语法 marker reveal 与 caret/scroll 稳定性达标。 - Avalonia 端：FsusMarkdownEditor 共享同一 source 事务合同。 > 兼容 Element Plus 公共 API，主题 token 保持 `--el-*` 优先。"
        - button [ref=e12]
    - generic [ref=e14]:
      - heading "变更摘要" [level=2] [ref=e15]
      - paragraph [ref=e16]: 本页把同一个编辑器实例嵌入真实文档版式，用于验收 framed、embedded、 minimal 三种 chrome 在 source、live、split、preview 四个 mode 下的 geometry、focus、语义与可访问性表现。
```

# Test source

```ts
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
  135 |   expect(diagnostics.get(page) ?? []).toEqual([])
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
> 177 |           await expect(page).toHaveScreenshot([
      |                              ^ Error: expect(page).toHaveScreenshot(expected) failed
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
  236 |       ).toBe('2:10')
  237 |     },
  238 |   )
  239 | 
  240 |   visualTest(
  241 |     'reaches editor controls by keyboard in every chrome',
  242 |     async ({ page }, testInfo) => {
  243 |       for (const chrome of CHROME_VARIANTS) {
  244 |         const editor = await openChromeCell(page, testInfo.project.name, {
  245 |           chrome,
  246 |           mode: 'source',
  247 |         })
  248 |         const textarea = editor.locator('textarea')
  249 |         let reached = false
  250 |         for (let step = 0; step < 24; step += 1) {
  251 |           if (
  252 |             await textarea.evaluate(
  253 |               (element) => element === element.ownerDocument.activeElement,
  254 |             )
  255 |           ) {
  256 |             reached = true
  257 |             break
  258 |           }
  259 |           await page.keyboard.press('Tab')
  260 |         }
  261 |         expect(reached, `${chrome}: keyboard reaches the input owner`).toBe(
  262 |           true,
  263 |         )
  264 | 
  265 |         const liveTab = editor.locator(
  266 |           `[role="tablist"] button.${nsModeClass('live')}`,
  267 |         )
  268 |         if (await liveTab.count()) {
  269 |           await liveTab.focus()
  270 |           await page.keyboard.press('Enter')
  271 |           await expect(editor).toHaveClass(/el-markdown-editor--live/)
  272 |         }
  273 |       }
  274 |     },
  275 |   )
  276 | 
  277 |   visualTest(
```