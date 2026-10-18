import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

import contract from '../fixtures/article-editor-production-contract.json' with { type: 'json' }

test.setTimeout(180_000)

const fixtureModule = `/@fs/${fileURLToPath(
  new URL('../fixtures/articleEditorProductionVisual.ts', import.meta.url)
).replaceAll('\\', '/')}`

async function openFixture(
  page: Page,
  title: keyof typeof contract.titles,
  theme: 'light' | 'dark',
  surface: 'title' | 'editor' | 'outline' | 'command' | 'inspector' | 'recovery' = 'title',
  inspectorState: 'empty' | 'loading' | 'error' | 'success' | 'partial' = 'success',
  inspectorView?: typeof contract.inspectorViews[number],
  authoringState: typeof contract.authoringStates[number] = 'ready',
  outlineHeadingCount = 8,
  outlineArticle: 'a' | 'b' = 'a'
): Promise<void> {
  await page.route('**/__article-editor-production-fixture**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>文章编辑器 production fixture</title></head>
          <body>
            <div id="article-editor-production-fixture"></div>
            <script type="module" src="/@vite/client"></script>
            <script type="module">
              const fixtureModule = ${JSON.stringify(fixtureModule)}
              let moduleAttempt = 0
              for (let attempt = 0; attempt < 45; attempt += 1) {
                try {
                  const fixture = await Promise.race([
                    import(fixtureModule + '?fixture-attempt=' + moduleAttempt),
                    new Promise((_, reject) => window.setTimeout(
                      () => reject(new Error('fixture_import_pending')),
                      1500
                    ))
                  ])
                  await fixture.mountArticleEditorProductionFixture()
                  break
                } catch (error) {
                  document.documentElement.dataset.articleEditorFixtureBootstrapAttempt =
                    String(attempt + 1)
                  moduleAttempt += 1
                  if (attempt === 44) {
                    document.documentElement.dataset.articleEditorFixtureBootstrapError =
                      error instanceof Error ? error.message : String(error)
                    throw error
                  }
                  await new Promise((resolve) => window.setTimeout(resolve, 1500))
                }
              }
            </script>
          </body>
        </html>`
    })
  })

  const search = new URLSearchParams({
    title,
    theme,
    surface,
    state: inspectorState,
    authoring: authoringState,
    outlineCount: String(outlineHeadingCount),
    article: outlineArticle
  })
  if (inspectorView) {
    search.set('view', inspectorView)
  }
  await page.goto(`/__article-editor-production-fixture?${search}`, {
    waitUntil: 'domcontentloaded'
  })
  const waitForFixtureReady = (timeout: number) => expect.poll(() => page.evaluate(() => (
    document.documentElement.dataset.articleEditorFixtureReady
  )), {
    intervals: [100, 250, 500, 1000],
    timeout
  }).toBe('true')

  try {
    await waitForFixtureReady(70_000)
  } catch (initialError) {
    const bootstrapError = await page.evaluate(() => (
      document.documentElement.dataset.articleEditorFixtureBootstrapError
    ))
    if (bootstrapError) {
      throw new Error(`article_editor_fixture_bootstrap_failed:${bootstrapError}`, {
        cause: initialError
      })
    }

    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForFixtureReady(50_000)
  }
}

async function openAuthoringFixture(
  page: Page,
  authoringState: typeof contract.authoringStates[number],
  theme: 'light' | 'dark' = 'light'
): Promise<void> {
  await openFixture(page, 'short', theme, 'editor', 'success', undefined, authoringState)
}

async function openAuthoringPalette(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as Window & { __articleEditorFixtureOpenAuthoringPalette?: () => void }
    ).__articleEditorFixtureOpenAuthoringPalette?.()
  })
  await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible()
}

async function openAuthoringToolbarOverflow(page: Page): Promise<void> {
  await page.getByRole('button', { name: /更多命令/u }).click()
  await expect(page.getByRole('button', { name: '插入提示块' })).toBeVisible()
}

async function clearFixtureRecovery(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (
      window as Window & {
        __articleEditorFixtureClearRecovery?: () => Promise<void>
      }
    ).__articleEditorFixtureClearRecovery?.()
  })
}

async function writeFixtureRecovery(page: Page, content: string): Promise<void> {
  await page.evaluate(async (value) => {
    await (
      window as Window & {
        __articleEditorFixtureWriteRecovery?: (content: string) => Promise<unknown>
      }
    ).__articleEditorFixtureWriteRecovery?.(value)
  }, content)
}

async function failNextRecoveryOperation(
  page: Page,
  kind: 'compare' | 'recover' | 'discard'
): Promise<void> {
  await page.evaluate((operationKind) => {
    (
      window as Window & {
        __articleEditorFixtureFailNextRecoveryOperation?: (value: typeof operationKind) => void
      }
    ).__articleEditorFixtureFailNextRecoveryOperation?.(operationKind)
  }, kind)
}

test.describe('article editor production fixture title hierarchy', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  for (const theme of contract.themes) {
    for (const title of Object.keys(contract.titles) as Array<keyof typeof contract.titles>) {
      test(`${title} title remains a task field in ${theme}`, async ({ page }) => {
        await openFixture(page, title, theme)

        const titleInput = page.getByRole('textbox', { name: '文章标题' })
        const editor = page.getByRole('textbox', { name: '正文' })
        await expect(titleInput).toBeVisible()
        await expect(editor).toBeVisible()
        await expect(page.locator('.editor-shell__header')).toHaveCount(0)
        await expect(page.getByRole('radio', { name: '编辑' })).toHaveCount(0)
        await expect(page.getByRole('radio', { name: '分屏' })).toHaveCount(0)
        await expect(page.getByRole('radio', { name: '预览' })).toHaveCount(0)
        await expect(page.getByRole('toolbar')).toHaveCount(0)

        const geometry = await titleInput.evaluate((element) => {
          const style = getComputedStyle(element)
          const box = element.getBoundingClientRect()
          return {
            fontSize: Number.parseFloat(style.fontSize),
            height: box.height,
            scrollHeight: (element as HTMLTextAreaElement).scrollHeight
          }
        })
        expect(geometry.fontSize).toBeLessThanOrEqual(40)
        expect(geometry.height).toBeLessThanOrEqual(160)
        if (title === 'long' || title === 'mixed') {
          expect(geometry.height).toBeGreaterThan(60)
        }

        const editorBox = await editor.boundingBox()
        expect(editorBox).not.toBeNull()
        expect(editorBox!.height).toBeGreaterThanOrEqual(360)
        expect(editorBox!.y + 360).toBeLessThanOrEqual(900)
      })
    }
  }

  test('150% zoom keeps the title and body in the first fold', async ({ page }) => {
    await openFixture(page, 'long', 'light')
    await page.evaluate(() => {
      document.documentElement.style.zoom = '1.5'
    })

    const titleBox = await page.getByRole('textbox', { name: '文章标题' }).boundingBox()
    const editorBox = await page.getByRole('textbox', { name: '正文' }).boundingBox()
    expect(titleBox).not.toBeNull()
    expect(editorBox).not.toBeNull()
    expect(titleBox!.y).toBeLessThan(editorBox!.y)
    expect(Math.abs(titleBox!.x - editorBox!.x)).toBeLessThanOrEqual(1)
    expect(editorBox!.y + Math.min(editorBox!.height, 120)).toBeLessThanOrEqual(900)
  })

  test('long title grows by content instead of a fixed empty shell', async ({ page }) => {
    await openFixture(page, 'empty', 'light')
    const titleInput = page.getByRole('textbox', { name: '文章标题' })
    const emptyHeight = await titleInput.evaluate((element) => element.getBoundingClientRect().height)
    await titleInput.fill(contract.titles.long)
    const longHeight = await titleInput.evaluate((element) => element.getBoundingClientRect().height)

    expect(emptyHeight).toBeLessThanOrEqual(80)
    expect(longHeight).toBeGreaterThan(emptyHeight)
    expect(longHeight).toBeLessThanOrEqual(160)
  })

  test('375/768/1366/1440 widths keep long mixed titles inside the editing column', async ({ page }) => {
    await openFixture(page, 'mixed', 'light')
    const titleInput = page.getByRole('textbox', { name: '文章标题' })

    for (const viewport of contract.viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      for (const theme of contract.themes) {
        await page.evaluate((nextTheme) => {
          document.documentElement.classList.toggle('dark', nextTheme === 'dark')
          document.documentElement.dataset.themeResolved = nextTheme
        }, theme)

        const geometry = await titleInput.evaluate((element) => {
          const style = getComputedStyle(element)
          const box = element.getBoundingClientRect()
          return {
            fontSize: Number.parseFloat(style.fontSize),
            left: box.left,
            right: box.right,
            viewportWidth: window.innerWidth
          }
        })
        expect(geometry.fontSize).toBeLessThanOrEqual(40)
        expect(geometry.left).toBeGreaterThanOrEqual(0)
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth)
      }
    }
  })

  test('public editor-title variant keeps geometry and focus ring across themes and breakpoints', async ({ page }) => {
    await openFixture(page, 'short', 'light')

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 375, height: 812 }
    ]) {
      await page.setViewportSize(viewport)

      for (const theme of contract.themes) {
        await page.evaluate((nextTheme) => {
          document.documentElement.classList.toggle('dark', nextTheme === 'dark')
          document.documentElement.dataset.themeResolved = nextTheme
        }, theme)

        const titleInput = page.getByRole('textbox', { name: '文章标题' })
        const titleRoot = page.locator('[data-textarea-variant="editor-title"]')
        await expect(titleRoot).toBeVisible()

        await page.getByRole('button', { name: '发布' }).focus()
        await page.keyboard.press('Tab')
        await expect(titleInput).toBeFocused()

        const geometry = await titleInput.evaluate((element) => {
          const style = getComputedStyle(element)
          const placeholderStyle = getComputedStyle(element, '::placeholder')
          const box = element.getBoundingClientRect()
          return {
            bottom: box.bottom,
            boxShadow: style.boxShadow,
            fontSize: Number.parseFloat(style.fontSize),
            fontWeight: style.fontWeight,
            left: box.left,
            placeholderWeight: placeholderStyle.fontWeight,
            right: box.right,
            top: box.top,
            viewportWidth: window.innerWidth
          }
        })

        expect(geometry.left).toBeGreaterThanOrEqual(0)
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth)
        expect(geometry.bottom).toBeGreaterThan(geometry.top)
        expect(geometry.fontSize).toBe(viewport.width === 375 ? 30 : 40)
        expect(geometry.fontWeight).toBe('700')
        expect(geometry.placeholderWeight).toBe('500')
        expect(geometry.boxShadow).not.toBe('none')

        const count = titleRoot.locator('.el-input__count')
        if (viewport.width === 375) {
          await expect(count).toBeHidden()
        } else {
          await expect(count).toBeVisible()
        }
      }
    }
  })
})

test.describe('article editor production fixture recovery prompt', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('stays silent normally, separates tab ownership and cleans exact server confirmation', async ({ context, page }) => {
    await openFixture(page, 'short', 'light', 'recovery')
    await clearFixtureRecovery(page)

    await expect(page.locator('[data-article-recovery-prompt]')).toHaveCount(0)
    await expect(page.getByRole('status')).toHaveCount(0)

    const unsynced = '进程退出前尚未确认的正文 🧭\nclient revision belongs to writer tab'
    await writeFixtureRecovery(page, unsynced)
    await expect(page.getByRole('textbox', { name: '未同步正文编辑区' })).toHaveValue(unsynced)
    await expect(page.locator('[data-article-recovery-prompt]')).toHaveCount(0)

    const observer = await context.newPage()
    try {
      await openFixture(observer, 'short', 'light', 'recovery')
      const prompt = observer.locator('[data-article-recovery-prompt]')
      await expect(prompt).toBeVisible()
      await expect(prompt).toHaveAttribute('aria-live', 'polite')
      await expect(observer.getByRole('group', { name: '选择要恢复的未同步正文版本' })).toBeVisible()
      await expect(observer.getByRole('radio')).toHaveCount(1)
      await expect(observer.getByText(/client revision 独立归属/u)).toBeVisible()
      await expect(observer.getByText(/未加密/u)).toBeVisible()
      await expect(observer.getByText(/最长 7 天/u)).toBeVisible()
      await expect(observer.getByText(/服务端确认、发布、删除、登出或显式丢弃后立即删除/u)).toBeVisible()

      for (const action of ['比较所选正文', '恢复所选正文', '丢弃所选正文']) {
        const button = observer.getByRole('button', { name: action })
        const box = await button.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.height).toBeGreaterThanOrEqual(44)
      }
      expect(await observer.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
        .toBeLessThanOrEqual(1)

      await failNextRecoveryOperation(observer, 'compare')
      await observer.getByRole('button', { name: '比较所选正文' }).click()
      await expect(prompt).toHaveAttribute('aria-busy', 'true')
      await expect(observer.getByRole('status', { name: '' })).toContainText('正在比较所选正文')
      for (const action of ['比较所选正文', '恢复所选正文', '丢弃所选正文']) {
        await expect(observer.getByRole('button', { name: action })).toBeDisabled()
      }
      await expect(observer.getByRole('alert')).toContainText('所选正文比较失败')
      await expect(prompt).toBeVisible()

      await observer.getByRole('button', { name: '比较所选正文' }).click()
      const comparison = observer.locator('[data-article-recovery-comparison]')
      await expect(comparison).toContainText('未同步正文')
      await expect(comparison).toContainText('初始化时的服务端权威正文')
      await expect(prompt).toHaveAttribute('aria-busy', 'false')

      await observer.getByRole('button', { name: '恢复所选正文' }).focus()
      await observer.keyboard.press('Enter')
      await expect(observer.getByRole('textbox', { name: '未同步正文编辑区' })).toHaveValue(unsynced)
      await expect(prompt).toHaveCount(0)

      const confirmed = await observer.evaluate(async () => await (
        window as Window & {
          __articleEditorFixtureConfirmRecovery?: () => Promise<boolean>
        }
      ).__articleEditorFixtureConfirmRecovery?.())
      expect(confirmed).toBe(true)

      const cleanReader = await context.newPage()
      try {
        await openFixture(cleanReader, 'short', 'light', 'recovery')
        await expect(cleanReader.locator('[data-article-recovery-prompt]')).toHaveCount(0)
      } finally {
        await cleanReader.close()
      }
    } finally {
      await clearFixtureRecovery(observer).catch(() => {})
      await observer.close()
    }
  })

  test('shows three tab-owned versions without last-write-wins and supports explicit discard', async ({ context, page }) => {
    await openFixture(page, 'short', 'dark', 'recovery')
    await clearFixtureRecovery(page)
    const writers = [page, await context.newPage(), await context.newPage()]
    const contents = [
      '标签页甲：中文恢复正文',
      '标签页乙：emoji recovery 🧪',
      '标签页丙：independent client revision'
    ]
    try {
      for (let index = 1; index < writers.length; index += 1) {
        await openFixture(writers[index], 'short', 'dark', 'recovery')
      }
      await Promise.all(writers.map((writer, index) => writeFixtureRecovery(writer, contents[index])))

      const observer = await context.newPage()
      try {
        await openFixture(observer, 'short', 'dark', 'recovery')
        await expect(observer.getByRole('heading', { name: '3 个标签页的未同步正文' })).toBeVisible()
        await expect(observer.getByRole('radio')).toHaveCount(3)
        for (const content of contents) {
          await expect(observer.getByText(content, { exact: true })).toBeVisible()
        }
        await observer.getByRole('radio').nth(1).check()
        await failNextRecoveryOperation(observer, 'discard')
        await observer.getByRole('button', { name: '丢弃所选正文' }).click()
        await expect(observer.locator('[data-article-recovery-prompt]')).toHaveAttribute('aria-busy', 'true')
        await expect(observer.getByRole('alert')).toContainText('正文丢弃失败')
        await expect(observer.getByRole('radio')).toHaveCount(3)
        await observer.getByRole('button', { name: '丢弃所选正文' }).click()
        await expect(observer.getByRole('radio')).toHaveCount(2)
      } finally {
        await observer.close()
      }
    } finally {
      await clearFixtureRecovery(page).catch(() => {})
      await Promise.all(writers.slice(1).map(writer => writer.close()))
    }
  })
})

test.describe('article editor production fixture recovery touch', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

  test('keeps the direct decision reachable by touch and screen-reader name at 375px', async ({ context, page }) => {
    await openFixture(page, 'short', 'light', 'recovery')
    await clearFixtureRecovery(page)
    await writeFixtureRecovery(page, '移动端未同步正文 👆')

    const observer = await context.newPage()
    try {
      await openFixture(observer, 'short', 'light', 'recovery')
      const prompt = observer.locator('[data-article-recovery-prompt]')
      await expect(prompt).toBeVisible()
      await expect(observer.getByRole('group', { name: '选择要恢复的未同步正文版本' })).toBeVisible()
      await expect(observer.getByText(/未加密/u)).toBeVisible()
      await observer.getByRole('radio').tap()
      const compare = observer.getByRole('button', { name: '比较所选正文' })
      const restore = observer.getByRole('button', { name: '恢复所选正文' })
      const discard = observer.getByRole('button', { name: '丢弃所选正文' })
      for (const action of [compare, restore, discard]) {
        const box = await action.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.height).toBeGreaterThanOrEqual(44)
      }
      expect(await observer.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
        .toBeLessThanOrEqual(1)
      await compare.tap()
      await expect(prompt).toHaveAttribute('aria-busy', 'true')
      await expect(observer.getByRole('status')).toContainText('正在比较所选正文')
      await expect(observer.locator('[data-article-recovery-comparison]')).toBeVisible()
      await failNextRecoveryOperation(observer, 'recover')
      await restore.tap()
      await expect(observer.getByRole('alert')).toContainText('正文恢复失败')
      await expect(prompt).toBeVisible()
      await restore.tap()
      await expect(observer.getByRole('textbox', { name: '未同步正文编辑区' }))
        .toHaveValue('移动端未同步正文 👆')
    } finally {
      await clearFixtureRecovery(observer).catch(() => {})
      await observer.close()
    }
  })
})

test.describe('article editor production fixture command bar', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('desktop unifies back, state, save feedback, draft and one primary action', async ({ page }) => {
    await openFixture(page, 'short', 'light', 'command')
    const bar = page.locator('.article-write-command-bar')
    const actions = page.locator('.article-write-command-bar__actions')
    await expect(bar).toBeVisible()
    await expect(page.getByRole('button', { name: '返回' })).toBeVisible()
    await expect(page.getByText('已发布', { exact: true })).toHaveCount(0)
    await expect(page.getByText('草稿', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '保存草稿' })).toBeVisible()
    await expect(page.getByRole('button', { name: '更新文章' })).toBeVisible()
    await expect(actions.locator('.el-button--primary')).toHaveCount(1)
    await expect(actions.locator('.article-write-command-bar__save-draft.el-button--primary')).toHaveCount(0)

    const barBox = await bar.boundingBox()
    expect(barBox).not.toBeNull()
    expect(barBox!.height).toBeGreaterThanOrEqual(56)
    const buttonGeometry = await actions.getByRole('button').evaluateAll((buttons) => buttons.map((button) => {
      const box = button.getBoundingClientRect()
      return { height: box.height, center: box.y + box.height / 2 }
    }))
    expect(buttonGeometry.every(({ height }) => height >= 44)).toBe(true)
    expect(Math.max(...buttonGeometry.map(({ center }) => center))
      - Math.min(...buttonGeometry.map(({ center }) => center))).toBeLessThanOrEqual(1)

    for (const state of ['saving', 'failed', 'saved', 'published'] as const) {
      await page.evaluate((nextState) => {
        const controller = (
          window as Window & {
            __articleEditorFixtureSetState?: (value: typeof nextState) => void
          }
        ).__articleEditorFixtureSetState
        controller?.(nextState)
      }, state)
      if (state === 'failed') {
        await expect(page.getByRole('button', { name: '保存冲突需处理' })).toBeVisible()
        await expect(page.getByRole('status')).toHaveCount(0)
      } else {
        await expect(page.getByRole('status')).toHaveText({
          saving: '正在保存',
          saved: '已保存',
          published: '发布完成'
        }[state])
      }
    }
    await expect(page.getByText('已发布', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: '返回' }).click()
    await page.getByRole('button', { name: '保存草稿' }).click()
    await page.getByRole('button', { name: '更新文章' }).click()
    await expect(page.getByLabel('缺失标题')).toBeFocused()
    expect(await page.evaluate(() => (
      window as Window & {
        __articleEditorFixtureActionCounts?: { back: number, saveDraft: number, submit: number }
      }
    ).__articleEditorFixtureActionCounts)).toEqual({
      back: 1,
      saveDraft: 1,
      submit: 1
    })
  })

  test('375px bottom bar respects 64px geometry, safe content spacing and keyboard-height viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await openFixture(page, 'short', 'dark', 'command')
    const actions = page.locator('.article-write-command-bar__actions')
    const workspace = page.locator('.write-workspace')
    const primary = page.getByRole('button', { name: '更新文章' })
    const secondary = page.getByRole('button', { name: '保存草稿' })
    const actionBox = await actions.boundingBox()
    expect(actionBox).not.toBeNull()
    expect(actionBox!.height).toBe(64)
    expect(actionBox!.y + actionBox!.height).toBe(812)
    for (const button of [primary, secondary]) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
      .toBeLessThanOrEqual(1)
    expect(await workspace.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom)))
      .toBeGreaterThanOrEqual(80)
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const lastLineBox = await page.locator('[data-fixture-last-line]').boundingBox()
    const scrolledActionBox = await actions.boundingBox()
    expect(lastLineBox).not.toBeNull()
    expect(scrolledActionBox).not.toBeNull()
    expect(lastLineBox!.y + lastLineBox!.height).toBeLessThanOrEqual(scrolledActionBox!.y - 16)

    await page.setViewportSize({ width: 375, height: 420 })
    await page.getByLabel('缺失标题').focus()
    const resizedActionBox = await actions.boundingBox()
    expect(resizedActionBox).not.toBeNull()
    expect(resizedActionBox!.y + resizedActionBox!.height).toBe(420)
    await expect(primary).toBeVisible()
  })
})

test.describe('article editor production fixture canvas and save status', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('keeps a continuous canvas without a write/preview/split header or duplicate save status', async ({ page }) => {
    await openFixture(page, 'short', 'light', 'editor')

    await expect(page.locator('.editor-shell__header')).toHaveCount(0)
    await expect(page.getByRole('radio', { name: '编辑' })).toHaveCount(0)
    await expect(page.getByRole('radio', { name: '分屏' })).toHaveCount(0)
    await expect(page.getByRole('radio', { name: '预览' })).toHaveCount(0)
    await expect(page.locator('[data-markdown-chrome="embedded"]')).toBeVisible()
    await expect(page.locator('[data-status-density="minimal"]')).toBeVisible()

    const status = page.locator('.article-write-command-bar [role="status"]')
    for (const state of ['editing', 'saving', 'saved', 'failed'] as const) {
      await page.evaluate((nextState) => {
        const controller = (
          window as Window & {
            __articleEditorFixtureSetState?: (value: typeof nextState) => void
          }
        ).__articleEditorFixtureSetState
        controller?.(nextState)
      }, state)
      await expect(status).toHaveText({
        editing: '自动保存已就绪',
        saving: '正在保存',
        saved: '已保存',
        failed: '保存失败，请重试'
      }[state])
    }
    await expect(page.locator('[role="status"]')).toHaveCount(1)
    await expect(status).toHaveClass(/article-write-command-bar__save-status--danger/u)

    const productionText = await page.locator('.editor-shell-minimal').innerText()
    expect(productionText).not.toMatch(/FsusUI|Element Plus|adapter|component|MarkdownEditor/iu)
    await expect(page.getByRole('heading', { name: '正文', exact: true })).toHaveCount(1)
    await expect(page.getByRole('button', { name: '实时' })).toBeVisible()
    await expect(page.getByRole('button', { name: '源码' })).toBeVisible()
    await expect(page.getByRole('button', { name: '源码对照' })).toBeVisible()
    await expect(page.getByRole('radio', { name: '实时' })).toHaveCount(0)
    await page.getByRole('button', { name: '实时' }).click()
    await expect(page.getByRole('button', { name: '实时' })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: '源码对照' }).click()
    await expect(page.getByRole('button', { name: '源码对照' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-markdown-chrome="embedded"]')).toHaveCount(1)
  })

  test('375/768/1440 light/dark keep title and body aligned without a four-mode header', async ({ page }) => {
    await openFixture(page, 'short', 'light', 'editor')
    for (const viewport of contract.viewports.filter(({ width }) => [375, 768, 1440].includes(width))) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      for (const theme of contract.themes) {
        await page.evaluate((nextTheme) => {
          document.documentElement.classList.toggle('dark', nextTheme === 'dark')
          document.documentElement.dataset.themeResolved = nextTheme
        }, theme)
        await expect(page.locator('.editor-shell__header')).toHaveCount(0)
        await expect(page.locator('[data-markdown-chrome="embedded"]')).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
          .toBeLessThanOrEqual(1)
        await expect(page.getByRole('button', { name: '实时' })).toBeVisible()
        await expect(page.getByRole('button', { name: '源码' })).toBeVisible()
        await expect(page.getByRole('button', { name: '源码对照' })).toBeVisible()
        await expect(page.getByRole('radio', { name: '编辑' })).toHaveCount(0)
        await expect(page.getByRole('radio', { name: '预览' })).toHaveCount(0)
        await expect(page.getByRole('radio', { name: '分屏' })).toHaveCount(0)
      }
    }
  })
})

test.describe('article editor production fixture outline rail', () => {
  test('desktop outline consumes canonical headings, reveals the source and preserves canvas geometry', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.removeItem('fsusblog.article-outline.rail-open.v1')
    })
    await openFixture(page, 'short', 'light', 'outline', 'success', undefined, 'ready', 10, 'a')

    const editor = page.locator('#article-content')
    const closedBox = await editor.boundingBox()
    const launcher = page.getByRole('button', { name: '打开文章大纲' })
    await expect(launcher).toBeVisible()
    await launcher.click()

    const panel = page.locator('[data-article-outline-panel="true"]')
    await expect(panel).toBeVisible()
    const items = page.getByRole('treeitem')
    await expect(items).toHaveCount(10)
    await expect(items.nth(1)).toHaveAccessibleName(/完整 accessible name/u)
    await expect(items.nth(1)).toHaveAttribute('title', /完整 accessible name/u)

    const openBox = await editor.boundingBox()
    expect(closedBox).not.toBeNull()
    expect(openBox).not.toBeNull()
    expect(Math.abs((openBox?.width ?? 0) - (closedBox?.width ?? 0))).toBeLessThanOrEqual(8)

    await items.nth(1).click()
    await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(editor).toBeFocused()
    const selection = await editor.evaluate((element) => ({
      start: (element as HTMLTextAreaElement).selectionStart,
      end: (element as HTMLTextAreaElement).selectionEnd
    }))
    expect(selection.start).toBeGreaterThan(0)
    expect(selection.end).toBe(selection.start)
    await page.getByRole('button', { name: '实时' }).click()
    await page.getByRole('button', { name: '源码对照' }).click()
    await expect(page.locator('[data-markdown-chrome="embedded"]')).toHaveCount(1)
    await expect(panel).toBeVisible()
    await page.screenshot({ path: '.tmp/ui-evidence/article-outline-desktop-light.png', fullPage: true })
  })

  test('mobile uses the FsusUI Drawer and returns focus to the launcher', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.removeItem('fsusblog.article-outline.rail-open.v1')
    })
    await page.setViewportSize({ width: 375, height: 812 })
    await openFixture(page, 'short', 'dark', 'outline', 'success', undefined, 'ready', 10, 'a')

    const launcher = page.getByRole('button', { name: '打开文章大纲' })
    await launcher.click()
    const drawer = page.getByRole('dialog', { name: '文章大纲' })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('treeitem')).toHaveCount(10)
    await drawer.getByRole('treeitem').first().focus()
    await page.keyboard.press('Escape')
    await expect(launcher).toBeFocused()
    await page.screenshot({ path: '.tmp/ui-evidence/article-outline-mobile-dark.png', fullPage: true })
  })

  test('empty and same-source different-article states stay isolated', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.removeItem('fsusblog.article-outline.rail-open.v1')
    })
    await openFixture(page, 'short', 'light', 'outline', 'success', undefined, 'ready', 0, 'a')
    await page.getByRole('button', { name: '打开文章大纲' }).click()
    await expect(page.getByText('正文中暂无标题。')).toBeVisible()
    await expect(page.getByRole('tree')).toHaveCount(0)

    await page.evaluate(() => window.localStorage.removeItem('fsusblog.article-outline.rail-open.v1'))

    await page.goto('/__article-editor-production-fixture?title=short&theme=light&surface=outline&outlineCount=10&article=a', {
      waitUntil: 'domcontentloaded'
    })
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.articleEditorFixtureReady))
      .toBe('true')
    await page.getByRole('button', { name: '打开文章大纲' }).click()
    const beforeIds = await page.getByRole('treeitem').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-outline-node-id')))
    await page.evaluate(() => (
      window as Window & { __articleEditorFixtureSwitchOutlineArticle?: (article: 'a' | 'b') => void }
    ).__articleEditorFixtureSwitchOutlineArticle?.('b'))
    await expect.poll(() => page.getByRole('treeitem').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-outline-node-id'))))
      .not.toEqual(beforeIds)
  })
})

test.describe('article editor production authoring command registry', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('one command identity is keyboard and screen-reader discoverable on all four surfaces', async ({ page }) => {
    await openAuthoringFixture(page, 'ready')
    const textbox = page.locator('textarea').first()

    const overflow = page.getByRole('button', { name: /更多命令/u })
    await overflow.focus()
    await page.keyboard.press('Enter')
    const toolbarCommand = page.getByRole('button', { name: '插入提示块' })
    await expect(toolbarCommand).toBeVisible()
    await expect(toolbarCommand).toBeEnabled()

    await openAuthoringPalette(page)
    const palette = page.getByRole('dialog', { name: '命令面板' })
    const paletteSearch = palette.getByRole('combobox', { name: '搜索命令' })
    await expect(paletteSearch).toBeFocused()
    await paletteSearch.fill('提示块')
    await expect(palette.getByRole('option', { name: /插入提示块/u })).toHaveCount(1)
    await expect(palette.getByText('1 个命令', { exact: true })).toBeAttached()
    await page.keyboard.press('Escape')
    await expect(textbox).toBeFocused()

    await textbox.fill('/')
    const slashMenu = page.getByRole('menu', { name: '块插入命令' })
    await expect(slashMenu.getByRole('menuitem', { name: '插入提示块' })).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(textbox).toBeFocused()

    await textbox.fill('选择这段正文')
    await textbox.selectText()
    await textbox.dispatchEvent('select')
    const selectionToolbar = page.getByRole('toolbar', { name: '选区工具' })
    await expect(selectionToolbar.getByRole('button', { name: '插入提示块' })).toBeEnabled()
    await selectionToolbar.press('Escape')
    await expect(textbox).toBeFocused()

    await textbox.press(process.platform === 'darwin' ? 'Meta+Shift+K' : 'Control+Shift+K')
    await expect.poll(() => page.evaluate(() => (
      window as Window & { __articleEditorFixtureAuthoringInvocationCount?: () => number }
    ).__articleEditorFixtureAuthoringInvocationCount?.() ?? 0)).toBe(1)
    await expect(textbox).toHaveValue(/由扩展宿主验证的提示/u)
  })

  for (const state of ['permission-denied', 'pending', 'error'] as const) {
    test(`${state} is the same disabled state on toolbar, palette, slash and selection`, async ({ page }) => {
      await openAuthoringFixture(page, state)
      const textbox = page.locator('textarea').first()
      const expectedReason = {
        'permission-denied': 'command-permission-insufficient',
        pending: 'command-pending',
        error: 'command-error'
      }[state]

      await openAuthoringToolbarOverflow(page)
      const toolbarCommand = page.getByRole('button', { name: '插入提示块' })
      await expect(toolbarCommand).toBeDisabled()
      const descriptionId = await toolbarCommand.getAttribute('aria-describedby')
      expect(descriptionId).toBeTruthy()
      await expect(page.locator(`#${descriptionId}`)).toHaveText(expectedReason)

      await openAuthoringPalette(page)
      await expect(page.getByRole('dialog', { name: '命令面板' })
        .getByRole('option', { name: /插入提示块/u })).toBeDisabled()
      await page.keyboard.press('Escape')

      await textbox.fill('/')
      await expect(page.getByRole('menu', { name: '块插入命令' })
        .getByRole('menuitem', { name: '插入提示块' })).toBeDisabled()
      await page.keyboard.press('Escape')

      await textbox.fill('选择这段正文')
      await textbox.selectText()
      await textbox.dispatchEvent('select')
      await expect(page.getByRole('toolbar', { name: '选区工具' })
        .getByRole('button', { name: '插入提示块' })).toBeDisabled()
      expect(await page.evaluate(() => (
        window as Window & { __articleEditorFixtureAuthoringInvocationCount?: () => number }
      ).__articleEditorFixtureAuthoringInvocationCount?.() ?? 0)).toBe(0)
    })
  }

  test('stale revision, selection drift, generation replacement and document abort never commit a late result', async ({ page }) => {
    await openAuthoringFixture(page, 'stale')
    const textbox = page.locator('textarea').first()
    const original = await textbox.inputValue()
    await openAuthoringToolbarOverflow(page)
    await page.getByRole('button', { name: '插入提示块' }).click()
    await expect(textbox).toHaveValue(original)
    await expect(page.locator('[id*="command-state-fixture-author-tools-insert-callout-0"]'))
      .toHaveText('执行失败')

    await page.evaluate(() => (
      window as Window & {
        __articleEditorFixtureSetAuthoringState?: (state: 'generation-replaced') => void
      }
    ).__articleEditorFixtureSetAuthoringState?.('generation-replaced'))
    await openAuthoringToolbarOverflow(page)
    await page.getByRole('button', { name: '插入提示块' }).click()
    await textbox.focus()
    await textbox.selectText()
    await textbox.dispatchEvent('select')
    await page.evaluate(() => (
      window as Window & { __articleEditorFixtureResolveAuthoringCommand?: () => void }
    ).__articleEditorFixtureResolveAuthoringCommand?.())
    await expect(page.locator('[id*="command-state-fixture-author-tools-insert-callout-0"]'))
      .toHaveText('执行失败')
    await expect(textbox).toHaveValue(original)

    await openAuthoringToolbarOverflow(page)
    await page.getByRole('button', { name: '插入提示块' }).click()
    await page.evaluate(() => (
      window as Window & { __articleEditorFixtureReplaceAuthoringGeneration?: () => void }
    ).__articleEditorFixtureReplaceAuthoringGeneration?.())
    await expect(page.locator('[id*="command-state-fixture-author-tools-insert-callout-0"]'))
      .toHaveText('执行失败')
    await expect(textbox).toHaveValue(original)

    await page.evaluate(() => (
      window as Window & { __articleEditorFixtureSetAuthoringState?: (state: 'aborted') => void }
    ).__articleEditorFixtureSetAuthoringState?.('aborted'))
    await openAuthoringToolbarOverflow(page)
    await page.getByRole('button', { name: '插入提示块' }).click()
    await page.evaluate(() => (
      window as Window & { __articleEditorFixtureReplaceAuthoringDocument?: () => void }
    ).__articleEditorFixtureReplaceAuthoringDocument?.())
    await expect(page.locator('[id*="command-state-fixture-author-tools-insert-callout-0"]'))
      .toHaveText('已取消')
    await expect(textbox).toHaveValue(original)
  })

  test('one thousand contributions have bounded palette search, grouping and cancellation', async ({ page }) => {
    await openAuthoringFixture(page, 'thousand')
    const textbox = page.locator('textarea').first()
    const original = await textbox.inputValue()
    await openAuthoringPalette(page)
    const palette = page.getByRole('dialog', { name: '命令面板' })
    await palette.getByRole('combobox', { name: '搜索命令' }).fill('bounded-999')
    await expect(palette.getByRole('option')).toHaveCount(1)
    await expect(palette.getByRole('option', { name: /扩展命令 0999/u })).toBeVisible()
    await expect(palette.getByRole('group', { name: 'extension.insert' })).toBeVisible()
    await expect(palette.getByText('1 个命令', { exact: true })).toBeAttached()
    await palette.getByRole('option', { name: /扩展命令 0999/u }).click()
    await page.evaluate(() => (
      window as Window & { __articleEditorFixtureReplaceAuthoringGeneration?: () => void }
    ).__articleEditorFixtureReplaceAuthoringGeneration?.())
    await page.evaluate(() => (
      window as Window & { __articleEditorFixtureResolveAuthoringCommand?: () => void }
    ).__articleEditorFixtureResolveAuthoringCommand?.())
    await expect(textbox).toHaveValue(original)
    expect(await page.evaluate(() => (
      window as Window & { __articleEditorFixtureAuthoringInvocationCount?: () => number }
    ).__articleEditorFixtureAuthoringInvocationCount?.() ?? 0)).toBe(1)
  })

  test('mobile touch keeps extension commands reachable without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await openAuthoringFixture(page, 'ready', 'dark')
    const overflow = page.getByRole('button', { name: /更多命令/u })
    await expect(overflow).toBeVisible()
    const box = await overflow.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(40)
    await overflow.tap()
    await expect(page.getByRole('button', { name: '插入提示块' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
      .toBeLessThanOrEqual(1)
  })
})

const inspectorLabels: Record<string, string> = {
  publish: '发布',
  rights: '版权',
  check: '检查',
  preview: '预览',
  versions: '版本',
  resources: '资源'
}

async function readStableDocumentState(page: Page) {
  return page.evaluate(() => {
    const column = document.querySelector<HTMLElement>('[data-editor-document-column="stable"]')
    const paragraph = document.querySelector<HTMLElement>('[data-document-wrap-signature]')
    const editor = document.querySelector<HTMLElement>('[data-editor-instance]')
    if (!column || !paragraph || !editor) {
      throw new Error('article_editor_inspector_geometry_missing')
    }
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    const paragraphBox = paragraph.getBoundingClientRect()
    const wrapSignature = Array.from(range.getClientRects()).map((rect) => [
      Math.round(rect.top - paragraphBox.top),
      Math.round(rect.width),
      Math.round(rect.height)
    ].join(':')).join('|')
    const columnBox = column.getBoundingClientRect()
    return {
      columnWidth: columnBox.width,
      content: editor.dataset.editorContent,
      selection: editor.dataset.editorSelection,
      history: editor.dataset.editorHistory,
      route: column.dataset.routeState,
      draft: column.dataset.draftState,
      editorIdentityStable: editor === (
        window as Window & { __articleEditorFixtureEditorNode?: Element }
      ).__articleEditorFixtureEditorNode,
      wrapSignature
    }
  })
}

test.describe('article editor production fixture inspector desktop contract', () => {
  for (const viewport of contract.viewports.filter(({ width }) => [1366, 1440].includes(width))) {
    test(`${viewport.width}px keeps the document geometry and editor instance stable for every view`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await openFixture(page, 'mixed', 'light', 'inspector')
      const baseline = await readStableDocumentState(page)

      for (const view of contract.inspectorViews) {
        const trigger = page.getByRole('button', { name: inspectorLabels[view], exact: true })
        await trigger.click()
        await expect(page.locator(`[data-inspector-view="${view}"]`))
          .toHaveAttribute('aria-hidden', 'false')
        await expect(page.locator('[data-inspector-view][aria-hidden="false"]')).toHaveCount(1)
        await expect(page.locator('aside[role="complementary"]')).toBeVisible()
        await expect(page.locator('[aria-modal="true"]')).toHaveCount(0)

        const current = await readStableDocumentState(page)
        expect(Math.abs(current.columnWidth - baseline.columnWidth))
          .toBeLessThanOrEqual(contract.geometry.maximumDocumentWidthDelta)
        expect(current.wrapSignature).toBe(baseline.wrapSignature)
        expect(current.editorIdentityStable).toBe(true)
        expect(current.content).toBe(baseline.content)
        expect(current.selection).toBe(baseline.selection)
        expect(current.history).toBe(baseline.history)
        expect(current.route).toBe(baseline.route)
        expect(current.draft).toBe(baseline.draft)

        for (const inactiveView of contract.inspectorViews.filter((candidate) => candidate !== view)) {
          const inactive = page.locator(`[data-inspector-view="${inactiveView}"]`)
          await expect(inactive).toHaveAttribute('aria-hidden', 'true')
          await expect(inactive).toHaveAttribute('inert', '')
        }
      }

      const loadCounts = await page.evaluate(() => (
        window as Window & {
          __articleEditorFixtureLoadCounts?: Record<string, number>
        }
      ).__articleEditorFixtureLoadCounts)
      expect(loadCounts).toEqual(Object.fromEntries(
        contract.inspectorViews.map((view) => [view, 1])
      ))

      await page.getByRole('button', { name: '检查', exact: true }).click()
      await page.getByRole('button', { name: '关闭文章检查器' }).click()
      await expect(page.getByRole('button', { name: '检查', exact: true })).toBeFocused()
      await expect(page.locator('aside[role="complementary"]')).toBeHidden()

      const closed = await readStableDocumentState(page)
      expect(Math.abs(closed.columnWidth - baseline.columnWidth))
        .toBeLessThanOrEqual(contract.geometry.maximumDocumentWidthDelta)
      expect(closed.wrapSignature).toBe(baseline.wrapSignature)
    })
  }

  test('restores independent scroll positions, lazy-loads once and closes with Escape', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openFixture(page, 'mixed', 'dark', 'inspector')

    const versionsTrigger = page.getByRole('button', { name: '版本', exact: true })
    await versionsTrigger.click()
    const versions = page.locator('[data-inspector-view="versions"]')
    await versions.evaluate((element) => {
      element.scrollTop = 420
      element.dispatchEvent(new Event('scroll'))
    })

    await page.getByRole('button', { name: '资源', exact: true }).click()
    const resources = page.locator('[data-inspector-view="resources"]')
    await resources.evaluate((element) => {
      element.scrollTop = 760
      element.dispatchEvent(new Event('scroll'))
    })

    await versionsTrigger.click()
    await expect.poll(() => versions.evaluate((element) => element.scrollTop)).toBe(420)
    await page.getByRole('button', { name: '资源', exact: true }).click()
    await expect.poll(() => resources.evaluate((element) => element.scrollTop)).toBe(760)

    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '资源', exact: true })).toBeFocused()
    await expect(page.locator('aside[role="complementary"]')).toBeHidden()

    const loadCounts = await page.evaluate(() => (
      window as Window & {
        __articleEditorFixtureLoadCounts?: Record<string, number>
      }
    ).__articleEditorFixtureLoadCounts)
    expect(loadCounts?.versions).toBe(1)
    expect(loadCounts?.resources).toBe(1)
  })

  test('keeps the closed critical summary actionable and returns focus to it', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openFixture(page, 'mixed', 'light', 'inspector')

    const criticalSummary = page.getByRole('button', { name: '120 项发布检查需处理' })
    await expect(criticalSummary).toBeVisible()
    await criticalSummary.click()
    await expect(page.locator('[data-inspector-view="check"]')).toHaveAttribute('aria-hidden', 'false')
    await page.getByRole('button', { name: '关闭文章检查器' }).click()
    await expect(criticalSummary).toBeFocused()
    await expect(page.locator('.article-write-command-bar__critical-status')).toHaveCount(1)
  })

  test('covers real publish composition, all content states and large collections', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openFixture(page, 'mixed', 'light', 'inspector', 'success', 'publish')
    await expect(page.locator('.article-write-sidebar .article-sidebar-section')).toHaveCount(3)
    await expect(page.locator('.article-sidebar-section > button[aria-expanded]')).toHaveCount(0)

    await page.getByRole('button', { name: '版权', exact: true }).click()
    await expect(page.locator('.article-editor-production-fixture__long-rights p')).toHaveCount(24)
    await page.getByRole('button', { name: '检查', exact: true }).click()
    await expect(page.locator('[data-large-list="check"] li')).toHaveCount(120)
    await page.getByRole('button', { name: '版本', exact: true }).click()
    await expect(page.locator('[data-large-list="versions"] li')).toHaveCount(100)
    await page.getByRole('button', { name: '资源', exact: true }).click()
    await expect(page.locator('[data-large-list="resources"] li')).toHaveCount(1000)

    await page.getByRole('button', { name: '版本', exact: true }).click()
    for (const state of ['empty', 'loading', 'error', 'partial'] as const) {
      await page.evaluate((nextState) => {
        (
          window as Window & {
            __articleEditorFixtureSetInspectorState?: (value: typeof nextState) => void
          }
        ).__articleEditorFixtureSetInspectorState?.(nextState)
      }, state)
      await expect(page.locator(
        `[data-inspector-view="versions"] [data-fixture-state="${state}"]`
      )).toBeVisible()
      if (state === 'partial') {
        await expect(page.locator('[data-large-list="versions"] li')).toHaveCount(10)
      }
    }
  })

  test('keeps geometry stable at 100/150/200% zoom in both themes', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openFixture(page, 'mixed', 'light', 'inspector')
    for (const theme of contract.themes) {
      for (const scale of contract.zoom) {
        await page.evaluate(({ nextScale, nextTheme }) => {
          document.documentElement.classList.toggle('dark', nextTheme === 'dark')
          document.documentElement.dataset.themeResolved = nextTheme
          document.documentElement.style.zoom = String(nextScale)
          const controller = (
            window as Window & { __articleEditorFixtureCloseInspector?: () => void }
          ).__articleEditorFixtureCloseInspector
          controller?.()
        }, { nextScale: scale, nextTheme: theme })
        const baseline = await readStableDocumentState(page)
        await page.getByRole('button', { name: '预览', exact: true }).click()
        const opened = await readStableDocumentState(page)
        expect(Math.abs(opened.columnWidth - baseline.columnWidth))
          .toBeLessThanOrEqual(contract.geometry.maximumDocumentWidthDelta)
        expect(opened.wrapSignature).toBe(baseline.wrapSignature)
        expect(opened.editorIdentityStable).toBe(true)
      }
    }
  })
})

test.describe('article editor production fixture inspector responsive host', () => {
  test.use({ hasTouch: true })

  test('375/768 use the public modal Drawer with touch, reduced motion and focus return', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const viewport of contract.viewports.filter(({ width }) => [375, 768].includes(width))) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await openFixture(page, 'mixed', 'dark', 'inspector')
      const launcher = page.getByRole('button', { name: '打开文章检查器', exact: true })
      await expect(launcher).toBeVisible()
      await launcher.tap()

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      const resourcesTrigger = page.getByRole('button', { name: '资源', exact: true })
      await resourcesTrigger.tap()

      await expect(dialog).toHaveAttribute('aria-modal', 'true')
      await expect(page.locator('aside[role="complementary"]')).toHaveCount(0)
      await expect(page.locator('[data-inspector-view="resources"]'))
        .toHaveAttribute('aria-hidden', 'false')
      await expect(page.locator('[data-inspector-view][aria-hidden="false"]')).toHaveCount(1)
      expect(await page.evaluate(() => (
        window as Window & { __articleEditorFixtureEditorNode?: Element }
      ).__articleEditorFixtureEditorNode === document.querySelector('[data-editor-instance]'))).toBe(true)

      const checkTrigger = page.getByRole('button', { name: '检查', exact: true })
      await checkTrigger.tap()
      await expect(page.locator('[data-inspector-view="check"]'))
        .toHaveAttribute('aria-hidden', 'false')
      await expect(page.locator('[data-inspector-view][aria-hidden="false"]')).toHaveCount(1)

      const safeAreaInset = await page.evaluate(() => (
        getComputedStyle(document.documentElement)
          .getPropertyValue('--fsus-safe-area-inset-bottom')
          .trim()
      ))
      expect(safeAreaInset).not.toBe('')

      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(launcher).toBeFocused()
      await expect(launcher).toBeVisible()

      await launcher.tap()
      await expect(dialog).toBeVisible()
      const closeButton = dialog.getByRole('button', { name: /关闭|close/i }).first()
      await closeButton.tap()
      await expect(dialog).toBeHidden()
      await expect(launcher).toBeFocused()
    }
  })

  test('soft-keyboard height keeps the last resource and Drawer actions inside visualViewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 420 })
    await openFixture(page, 'mixed', 'light', 'inspector', 'success', 'resources')
    const activeView = page.locator('[data-inspector-view="resources"]')
    await activeView.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event('scroll'))
    })
    const lastAsset = page.locator('[data-large-list="resources"] li').last()
    await lastAsset.scrollIntoViewIfNeeded()
    const geometry = await lastAsset.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return {
        bottom: box.bottom,
        visualViewportHeight: window.visualViewport?.height ?? window.innerHeight
      }
    })
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.visualViewportHeight)
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('1024px selects the nonmodal complementary host without duplicating panel content', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await openFixture(page, 'mixed', 'light', 'inspector', 'success', 'rights')
    await expect(page.locator('aside[role="complementary"]')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('[data-inspector-view]')).toHaveCount(contract.inspectorViews.length)
    await expect(page.locator('[data-inspector-view][aria-hidden="false"]')).toHaveCount(1)
  })
})


test.describe('article editor production outline acceptance', () => {
  async function settleOutlineFrames(page: Page): Promise<void> {
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    })
  }

  test.describe('compact touch close routes', () => {
    test.use({ hasTouch: true })

    for (const theme of ['light', 'dark'] as const) {
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        test(`compact public close routes preserve the native opener in ${theme}/${reducedMotion}`, async ({ page }, testInfo) => {
          const pageErrors: string[] = []
          page.on('pageerror', (error) => pageErrors.push(error.message))
          await page.emulateMedia({ reducedMotion })
          await page.addInitScript(() => {
            window.localStorage.removeItem('fsusblog.article-outline.rail-open.v1')
          })
          for (const viewport of contract.viewports.filter(({ width }) => width <= contract.outline.drawerBreakpoint)) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height })
            await openFixture(page, 'short', theme, 'outline', 'success', undefined, 'ready', 10, 'a')
            const launcher = page.getByRole('button', { name: '打开文章大纲', exact: true })
            const opener = await launcher.elementHandle()
            if (!opener) throw new Error('outline_native_opener_missing')
            for (const closeRoute of ['builtin', 'custom', 'mask', 'escape'] as const) {
              await launcher.tap()
              const dialog = page.getByRole('dialog', { name: '文章大纲', exact: true })
              await expect(dialog).toBeVisible()
              await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
              await expect(dialog).toHaveAttribute('aria-modal', 'true')
              await expect(dialog.getByRole('treeitem')).toHaveCount(10)
              await expect(launcher).toBeVisible()
              expect(await launcher.evaluate((current, original) => current === original, opener)).toBe(true)
              expect(await opener.evaluate((element) => element.isConnected)).toBe(true)
              const tabbableIndices = await dialog.evaluate((element) => Array.from(element.querySelectorAll('button'))
                .flatMap((button, index) => button.tabIndex >= 0 && !button.disabled && button.getClientRects().length > 0 ? [index] : []))
              expect(tabbableIndices.length).toBeGreaterThanOrEqual(3)
              for (const key of ['Tab', 'Shift+Tab']) {
                const visited = new Set<number>()
                for (let index = 0; index <= tabbableIndices.length; index += 1) {
                  await page.keyboard.press(key)
                  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
                  visited.add(await dialog.evaluate((element) => Array.from(element.querySelectorAll('button'))
                    .findIndex((button) => button === document.activeElement)))
                }
                for (const index of tabbableIndices) expect(visited.has(index)).toBe(true)
              }
              if (closeRoute === 'builtin') {
                await page.screenshot({ path: testInfo.outputPath(`outline-open-${viewport.width}-${theme}-${reducedMotion}.png`), fullPage: true })
                await dialog.getByRole('button', { name: 'Close this dialog', exact: true }).tap()
              } else if (closeRoute === 'custom') {
                await dialog.getByRole('button', { name: '关闭文章大纲', exact: true }).tap()
              } else if (closeRoute === 'mask') {
                const box = await dialog.boundingBox()
                if (!box) throw new Error('outline_dialog_geometry_missing')
                const maskX = viewport.width - 2
                expect(maskX).toBeGreaterThan(box.x + box.width)
                await page.touchscreen.tap(maskX, Math.min(viewport.height - 2, box.y + 40))
              } else {
                await dialog.getByRole('treeitem').first().focus()
                await page.keyboard.press('Escape')
              }
              await expect(dialog).toBeHidden()
              await expect(launcher).toBeFocused()
              expect(await launcher.evaluate((current, original) => current === original, opener)).toBe(true)
              const save = page.getByRole('button', { name: '保存草稿', exact: true })
              await save.focus()
              await settleOutlineFrames(page)
              await expect(save).toBeFocused()
            }
            await opener.dispose()
          }
          expect(pageErrors).toEqual([])
        })
      }
    }
  })

  test('desktop keyboard navigation exposes one tree tab stop and sibling ARIA without implicit source activation', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript(() => window.localStorage.removeItem('fsusblog.article-outline.rail-open.v1'))
    for (const theme of ['light', 'dark'] as const) {
      await openFixture(page, 'short', theme, 'outline', 'success', undefined, 'ready', 10, 'a')
      await page.getByRole('button', { name: '打开文章大纲', exact: true }).click()
      const tree = page.getByRole('tree')
      const items = tree.getByRole('treeitem')
      const tabStop = tree.locator('[role="treeitem"][tabindex="0"]')
      await expect(items).toHaveCount(10)
      await expect(tabStop).toHaveCount(1)
      await expect(items.first()).toHaveAttribute('aria-level', '1')
      await expect(items.first()).toHaveAttribute('aria-posinset', '1')
      await expect(items.first()).toHaveAttribute('aria-setsize', '3')
      await expect(items.nth(1)).toHaveAttribute('aria-level', '2')
      await expect(items.nth(1)).toHaveAttribute('aria-setsize', '1')
      await expect(items.nth(4)).toHaveAttribute('aria-posinset', '2')
      const editor = page.locator('#article-content')
      const selection = await editor.evaluate((element) => ({ start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd }))
      await items.first().focus()
      await page.keyboard.press('ArrowDown')
      await expect(items.nth(1)).toBeFocused()
      await page.keyboard.press('ArrowRight')
      await expect(items.nth(2)).toBeFocused()
      await page.keyboard.press('ArrowLeft')
      await expect(items.nth(2)).toBeFocused()
      await page.keyboard.press('ArrowLeft')
      await expect(items.nth(1)).toBeFocused()
      await page.keyboard.press('ArrowRight')
      await expect(items.nth(2)).toBeFocused()
      await page.keyboard.press('ArrowRight')
      await expect(items).toHaveCount(10)
      await page.keyboard.press('Home')
      await expect(items.first()).toBeFocused()
      await page.keyboard.press('ArrowLeft')
      await expect(items).toHaveCount(7)
      await expect(tabStop).toHaveCount(1)
      await expect(items.first()).toBeFocused()
      await page.keyboard.press('ArrowRight')
      await expect(items).toHaveCount(10)
      await page.keyboard.press('End')
      await expect(items.last()).toBeFocused()
      await page.keyboard.press('ArrowUp')
      await expect(items.nth(8)).toBeFocused()
      expect(await editor.evaluate((element) => ({ start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd }))).toEqual(selection)
      await page.keyboard.press('Enter')
      await expect(editor).toBeFocused()
      await expect.poll(() => editor.evaluate((element) => (element as HTMLTextAreaElement).selectionStart)).toBeGreaterThan(0)
      await page.getByRole('button', { name: '关闭文章大纲', exact: true }).click()
      await expect(page.getByRole('button', { name: '打开文章大纲', exact: true })).toBeFocused()
    }
    expect(pageErrors).toEqual([])
  })

  test('breakpoint replacement and close/reopen preserve current article ownership without a deferred focus steal', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript(() => window.localStorage.removeItem('fsusblog.article-outline.rail-open.v1'))
    await page.setViewportSize({ width: 1023, height: 768 })
    await openFixture(page, 'short', 'light', 'outline', 'success', undefined, 'ready', 10, 'a')
    const launcher = page.getByRole('button', { name: '打开文章大纲', exact: true })
    await launcher.click()
    const dialog = page.getByRole('dialog', { name: '文章大纲', exact: true })
    await expect(dialog).toBeVisible()
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await page.setViewportSize({ width: 1024, height: 768 })
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('[data-article-outline-panel="true"]')).toHaveCount(1)
    await expect(page.getByRole('treeitem')).toHaveCount(10)
    const editor = page.locator('#article-content')
    await editor.focus()
    await settleOutlineFrames(page)
    await expect(editor).toBeFocused()
    await page.setViewportSize({ width: 1023, height: 768 })
    await expect(dialog).toBeVisible()
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await dialog.getByRole('treeitem').first().focus()
    const oldNode = await dialog.getByRole('treeitem').first().elementHandle()
    if (!oldNode) throw new Error('outline_old_article_node_missing')
    const ids = await dialog.getByRole('treeitem').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-outline-node-id')))
    await page.evaluate(() => (
      window as Window & { __articleEditorFixtureSwitchOutlineArticle?: (article: 'a' | 'b') => void }
    ).__articleEditorFixtureSwitchOutlineArticle?.('b'))
    await expect.poll(() => dialog.getByRole('treeitem').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-outline-node-id')))).not.toEqual(ids)
    expect(await oldNode.evaluate((element) => element.isConnected)).toBe(false)
    await oldNode.dispose()
    await dialog.getByRole('treeitem').first().focus()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await launcher.focus()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await expect(dialog.getByRole('treeitem')).toHaveCount(10)
    await settleOutlineFrames(page)
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(launcher).toBeFocused()
    await editor.focus()
    await settleOutlineFrames(page)
    await expect(editor).toBeFocused()
    expect(pageErrors).toEqual([])
  })

  test('a pending native Drawer leave transition can reopen before its close settles', async ({ page }, testInfo) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.setViewportSize({ width: 375, height: 812 })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.addInitScript(() => window.localStorage.removeItem('fsusblog.article-outline.rail-open.v1'))
    for (const theme of ['light', 'dark'] as const) {
      await openFixture(page, 'short', theme, 'outline', 'success', undefined, 'ready', 10, 'a')
      const launcher = page.getByRole('button', { name: '打开文章大纲', exact: true })
      await launcher.click()
      const dialog = page.getByRole('dialog', { name: '文章大纲', exact: true })
      await expect(dialog).toBeVisible()
      await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
      await expect.poll(() => dialog.evaluate((element) => element.getAnimations({ subtree: true })
        .every((animation) => animation.playState !== 'running'))).toBe(true)
      const opener = await launcher.elementHandle()
      const close = await dialog.getByRole('button', { name: '关闭文章大纲', exact: true }).elementHandle()
      if (!opener || !close) throw new Error('outline_native_transition_controls_missing')
      // This is native DOM activation under real motion, not a physical pointer hit
      // through the modal overlay. Physical keyboard interaction is checked below.
      const pending = await dialog.evaluate(async (element, controls) => {
        if (!(controls.opener instanceof HTMLButtonElement) || !(controls.close instanceof HTMLButtonElement)) {
          throw new Error('outline_native_transition_controls_invalid')
        }
        controls.close.click()
        for (let frame = 0; frame < 60; frame += 1) {
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
          const transition = element.getAnimations({ subtree: true }).find((animation) => animation instanceof CSSTransition
            && animation.transitionProperty === 'transform' && animation.playState === 'running'
            && (animation.effect?.getComputedTiming().progress ?? 0) > 0
            && (animation.effect?.getComputedTiming().progress ?? 1) < 1)
          if (transition) {
            const timing = transition.effect?.getComputedTiming()
            const observed = { frame, currentTime: transition.currentTime, progress: timing?.progress, duration: timing?.duration }
            controls.opener.click()
            return observed
          }
        }
        throw new Error('outline_pending_native_leave_transition_not_observed')
      }, { opener, close })
      expect(pending.progress).toBeGreaterThan(0)
      expect(pending.progress).toBeLessThan(1)
      await testInfo.attach(`pending-native-close-${theme}`, { body: JSON.stringify(pending), contentType: 'application/json' })
      await expect(dialog).toBeVisible()
      await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
      // Let the interrupted close and reopened entry settle before actively closing
      // the new session, so a stale close event cannot be hidden by that action.
      await expect.poll(() => dialog.evaluate((element) => element.getAnimations({ subtree: true })
        .every((animation) => !animation.pending && animation.playState !== 'running'))).toBe(true)
      await settleOutlineFrames(page)
      await expect(dialog).toBeVisible()
      await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
      expect(await opener.evaluate((element) => element.isConnected)).toBe(true)
      expect(await launcher.evaluate((current, original) => current === original, opener)).toBe(true)
      await dialog.getByRole('treeitem').first().focus()
      await page.keyboard.press('ArrowDown')
      await expect(dialog.getByRole('treeitem').nth(1)).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(launcher).toBeFocused()
      await page.locator('#article-content').focus()
      await settleOutlineFrames(page)
      await expect(page.locator('#article-content')).toBeFocused()
      await opener.dispose()
      await close.dispose()
    }
    expect(pageErrors).toEqual([])
  })

  test('closing and actually unmounting the editor releases focus to the fixture owner', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript(() => {
      if (window.location.pathname === '/__article-editor-production-fixture') {
        const url = new URL(window.location.href)
        url.searchParams.set('outlineLifecycle', 'unmount')
        window.history.replaceState(null, '', url)
        window.localStorage.removeItem('fsusblog.article-outline.rail-open.v1')
      }
    })
    for (const width of [375, 1440]) {
      for (const theme of ['light', 'dark'] as const) {
        await page.setViewportSize({ width, height: 900 })
        await openFixture(page, 'short', theme, 'outline', 'success', undefined, 'ready', 10, 'a')
        await page.getByRole('button', { name: '打开文章大纲', exact: true }).click()
        if (width <= contract.outline.drawerBreakpoint) {
          const dialog = page.getByRole('dialog', { name: '文章大纲', exact: true })
          await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
        }
        const editor = await page.locator('#article-content').elementHandle()
        const panel = await page.locator('[data-article-outline-panel="true"]').elementHandle()
        const firstNode = await page.getByRole('treeitem').first().elementHandle()
        const opener = width <= contract.outline.drawerBreakpoint
          ? await page.getByRole('button', { name: '打开文章大纲', exact: true }).elementHandle()
          : null
        // Desktop removes its opener while open; the compact modal retains it.
        if (!editor || !panel || !firstNode || (width <= contract.outline.drawerBreakpoint && !opener)) {
          throw new Error('outline_owned_nodes_before_unmount_missing')
        }
        const navigationIdentity = await page.evaluate(() => ({ origin: performance.timeOrigin, href: window.location.href }))
        // The fixture owner activates the real native close button, then removes
        // the actual component in the same host call stack (not a page reload).
        await page.getByRole('button', { name: '关闭文章大纲', exact: true }).evaluate(async (button) => {
          if (!(button instanceof HTMLButtonElement)) throw new Error('outline_native_close_button_required')
          const closeAndUnmount = (window as Window & {
            __articleEditorFixtureCloseAndUnmount?: (closeButton: HTMLButtonElement) => Promise<void>
          }).__articleEditorFixtureCloseAndUnmount
          if (!closeAndUnmount) throw new Error('outline_fixture_lifecycle_control_missing')
          await closeAndUnmount(button)
        })
        await expect(page.locator('#article-content')).toHaveCount(0)
        for (const node of [editor, panel, firstNode, ...(opener ? [opener] : [])]) {
          await expect.poll(() => node.evaluate((element) => element.isConnected)).toBe(false)
        }
        await expect(page.getByRole('dialog', { name: '文章大纲', exact: true })).toHaveCount(0)
        await expect(page.getByRole('button', { name: '打开文章大纲', exact: true })).toHaveCount(0)
        expect(await page.evaluate(() => ({ origin: performance.timeOrigin, href: window.location.href }))).toEqual(navigationIdentity)
        const target = page.locator('[data-outline-fixture-focus-target="true"]')
        await expect(target).toBeFocused()
        await settleOutlineFrames(page)
        await expect(target).toBeFocused()
        for (const node of [editor, panel, firstNode, ...(opener ? [opener] : [])]) await node.dispose()
      }
    }
    expect(pageErrors).toEqual([])
  })

  test('Chrome AX exposes the actual outline hierarchy and keyboard-selected state', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript(() => window.localStorage.removeItem('fsusblog.article-outline.rail-open.v1'))
    const session = await page.context().newCDPSession(page)
    try {
      await session.send('Accessibility.enable')
      for (const theme of ['light', 'dark'] as const) {
        await openFixture(page, 'short', theme, 'outline', 'success', undefined, 'ready', 10, 'a')
        await page.getByRole('button', { name: '打开文章大纲', exact: true }).click()
        const items = page.getByRole('treeitem')
        await expect(items).toHaveCount(10)
        await items.first().focus()
        await page.keyboard.press('ArrowDown')
        await expect(items.nth(1)).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true')
        await expect.poll(async () => {
          const current = await session.send('Accessibility.getFullAXTree')
          return current.nodes.find((node) => !node.ignored && node.role?.value === 'treeitem'
            && node.name?.value === '一个可访问且足够长的标题，用于验证完整 accessible name 与稳定换行行为')
            ?.properties?.find((property) => property.name === 'selected')?.value.value
        }).toBe(true)
        const full = await session.send('Accessibility.getFullAXTree')
        const exposed = full.nodes.filter((node) => !node.ignored)
        expect(exposed.some((node) => node.role?.value === 'tree')).toBe(true)
        const first = exposed.find((node) => node.role?.value === 'treeitem' && node.name?.value === '文章大纲与当前章节导航')
        const second = exposed.find((node) => node.role?.value === 'treeitem'
          && node.name?.value === '一个可访问且足够长的标题，用于验证完整 accessible name 与稳定换行行为')
        expect(first).toBeDefined()
        expect(second).toBeDefined()
        expect(first?.properties?.find((property) => property.name === 'level')?.value.value).toBe(1)
        expect(first?.properties?.find((property) => property.name === 'expanded')?.value.value).toBe(true)
        expect(second?.properties?.find((property) => property.name === 'level')?.value.value).toBe(2)
        expect(second?.properties?.find((property) => property.name === 'selected')?.value.value).toBe(true)
        await testInfo.attach(`actual-chrome-outline-ax-${theme}`, { body: JSON.stringify(full), contentType: 'application/json' })
        await items.first().focus()
        await page.keyboard.press('ArrowLeft')
        await expect(items).toHaveCount(7)
        await expect.poll(async () => {
          const current = await session.send('Accessibility.getFullAXTree')
          return current.nodes.find((node) => !node.ignored && node.role?.value === 'treeitem'
            && node.name?.value === '文章大纲与当前章节导航')?.properties?.find((property) => property.name === 'expanded')?.value.value
        }).toBe(false)
        const collapsed = await session.send('Accessibility.getFullAXTree')
        expect(collapsed.nodes.find((node) => !node.ignored && node.role?.value === 'treeitem'
          && node.name?.value === '文章大纲与当前章节导航')?.properties?.find((property) => property.name === 'expanded')?.value.value).toBe(false)
        await page.keyboard.press('ArrowRight')
        await expect(items).toHaveCount(10)
      }
    } finally {
      await session.detach()
    }
  })

  for (const theme of ['light', 'dark'] as const) {
    for (const scale of contract.zoom) {
      test(`original viewport geometry stays stable at CSS scale ${scale} in ${theme}`, async ({ page }, testInfo) => {
        await page.addInitScript(() => window.localStorage.removeItem('fsusblog.article-outline.rail-open.v1'))
        for (const viewport of contract.viewports) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height })
          await openFixture(page, 'short', theme, 'outline', 'success', undefined, 'ready', 10, 'a')
          await page.evaluate((value) => { document.documentElement.style.zoom = String(value) }, scale)
          const editor = page.locator('#article-content')
          const closed = await editor.boundingBox()
          await page.getByRole('button', { name: '打开文章大纲', exact: true }).click()
          const panel = page.locator('[data-article-outline-panel="true"]')
          await expect(panel).toBeVisible()
          if (viewport.width <= contract.outline.drawerBreakpoint) {
            const dialog = page.getByRole('dialog', { name: '文章大纲', exact: true })
            await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
          }
          for (const visiblePart of [panel, panel.locator('header'), panel.getByRole('button', { name: '关闭文章大纲', exact: true })]) {
            await expect(visiblePart).toBeVisible()
            await expect.poll(() => visiblePart.evaluate((element) => {
              const box = element.getBoundingClientRect()
              return box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0
                && box.right <= window.innerWidth && box.bottom <= window.innerHeight
            })).toBe(true)
          }
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
            && document.body.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
          await expect(panel.getByRole('treeitem')).toHaveCount(10)
          const opened = await editor.boundingBox()
          if (!closed || !opened) throw new Error('outline_document_geometry_missing')
          expect(Math.abs(opened.width - closed.width)).toBeLessThanOrEqual(contract.geometry.maximumDocumentWidthDelta)
          await expect.poll(() => panel.getByRole('treeitem').nth(1).evaluate((element) => {
            const box = element.getBoundingClientRect()
            return box.width > 0 && box.height > 0 && element.scrollWidth <= element.clientWidth
          })).toBe(true)
          await page.screenshot({ path: testInfo.outputPath(`outline-${viewport.id}-${theme}-css-scale-${scale}.png`), fullPage: true })
          await panel.getByRole('button', { name: '关闭文章大纲', exact: true }).click()
          await expect(page.getByRole('button', { name: '打开文章大纲', exact: true })).toBeFocused()
        }
      })
    }
  }
})

// Inline render functions have no SFC-generated scope attributes on descendants.
// Inspect actual layout and keyboard focus instead of relying on source markers.
test.describe('article editor production outline content styles', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`inline content keeps layout and keyboard focus styles in ${theme}`, async ({ page }, testInfo) => {
      const pageErrors: string[] = []
      page.on('pageerror', (error) => pageErrors.push(error.message))
      await page.addInitScript(() => window.localStorage.removeItem('fsusblog.article-outline.rail-open.v1'))
      for (const width of [375, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        await openFixture(page, 'short', theme, 'outline', 'success', undefined, 'ready', 10, 'a')
        await page.getByRole('button', { name: '打开文章大纲', exact: true }).click()
        const panel = page.locator('[data-article-outline-panel="true"]')
        const content = panel.locator('.article-write-outline-content')
        const header = panel.locator('header')
        const item = panel.getByRole('treeitem').nth(1)
        await expect(panel).toBeVisible()
        await page.keyboard.press('Tab')
        await item.focus()
        await expect(item).toBeFocused()
        await page.screenshot({ path: testInfo.outputPath(`outline-content-${width}-${theme}.png`), fullPage: true })
        expect(await content.evaluate((element) => getComputedStyle(element).display)).toBe('grid')
        expect(await header.evaluate((element) => getComputedStyle(element).display)).toBe('flex')
        expect(await item.evaluate((element) => getComputedStyle(element).display)).toBe('flex')
        expect(await item.evaluate((element) => ({
          style: getComputedStyle(element).outlineStyle,
          width: getComputedStyle(element).outlineWidth,
          offset: getComputedStyle(element).outlineOffset,
          visible: element.matches(':focus-visible')
        }))).toEqual({ style: 'solid', width: '2px', offset: '-2px', visible: true })
        const text = item.locator('.article-write-outline-item-text')
        expect(await text.evaluate((element) => ({
          overflow: getComputedStyle(element).overflow,
          ellipsis: getComputedStyle(element).textOverflow,
          whiteSpace: getComputedStyle(element).whiteSpace
        }))).toEqual({ overflow: 'hidden', ellipsis: 'ellipsis', whiteSpace: 'nowrap' })
        expect(await item.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
        await panel.getByRole('button', { name: '关闭文章大纲', exact: true }).click()
        await expect(page.getByRole('button', { name: '打开文章大纲', exact: true })).toBeFocused()
      }
      expect(pageErrors).toEqual([])
    })
  }
})
