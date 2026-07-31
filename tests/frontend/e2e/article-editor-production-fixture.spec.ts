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
  surface: 'title' | 'editor' | 'command' | 'inspector' | 'recovery' = 'title',
  inspectorState: 'empty' | 'loading' | 'error' | 'success' | 'partial' = 'success',
  inspectorView?: typeof contract.inspectorViews[number]
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
    state: inspectorState
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
        const toolbar = page.getByRole('toolbar')
        const editor = page.getByRole('textbox', { name: '正文' })
        await expect(titleInput).toBeVisible()
        await expect(toolbar).toBeVisible()
        await expect(editor).toBeVisible()

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

  test('150% zoom keeps the toolbar in the first fold', async ({ page }) => {
    await openFixture(page, 'long', 'light')
    await page.evaluate(() => {
      document.documentElement.style.zoom = '1.5'
    })

    const toolbarBox = await page.getByRole('toolbar').boundingBox()
    expect(toolbarBox).not.toBeNull()
    expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(900)
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

test.describe('article editor production fixture mode and save status', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('exposes only task copy and keeps all status transitions on a 40px baseline', async ({ page }) => {
    await openFixture(page, 'short', 'light', 'editor')

    const header = page.locator('.editor-shell__header')
    const status = page.getByRole('status')
    const heights: number[] = []
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
      heights.push(await header.evaluate((element) => element.getBoundingClientRect().height))
    }
    expect(new Set(heights)).toEqual(new Set([40]))
    await expect(status).toHaveClass(/editor-shell__status--danger/u)

    const productionText = await page.locator('.editor-shell-minimal').innerText()
    expect(productionText).not.toMatch(/FsusUI|Element Plus|adapter|component|MarkdownEditor/iu)
    await expect(page.getByText('正文', { exact: true })).toBeVisible()
    await expect(page.getByRole('radio', { name: '编辑' })).toBeChecked()
    await page.getByText('分屏', { exact: true }).click()
    await expect(page.getByRole('radio', { name: '分屏' })).toBeChecked()
    await page.getByText('预览', { exact: true }).click()
    await expect(page.getByRole('radio', { name: '预览' })).toBeChecked()
  })

  test('375/768/1440 light/dark keep the mode/status row stable', async ({ page }) => {
    await openFixture(page, 'short', 'light', 'editor')
    const header = page.locator('.editor-shell__header')
    for (const viewport of contract.viewports.filter(({ width }) => [375, 768, 1440].includes(width))) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      for (const theme of contract.themes) {
        await page.evaluate((nextTheme) => {
          document.documentElement.classList.toggle('dark', nextTheme === 'dark')
          document.documentElement.dataset.themeResolved = nextTheme
        }, theme)
        await expect(header).toBeVisible()
        expect(await header.evaluate((element) => element.getBoundingClientRect().height)).toBe(40)
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
          .toBeLessThanOrEqual(1)
        await expect(page.getByRole('radio', { name: '编辑' })).toBeVisible()
        await expect(page.getByRole('radio', { name: '预览' })).toBeVisible()
        await expect(page.getByRole('radio', { name: '分屏' }))
          .toHaveCount(viewport.width < 768 ? 0 : 1)
      }
    }
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
