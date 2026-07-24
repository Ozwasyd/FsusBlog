import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

import contract from '../fixtures/article-editor-production-contract.json' with { type: 'json' }

const fixtureModule = `/@fs/${fileURLToPath(
  new URL('../fixtures/articleEditorProductionVisual.ts', import.meta.url)
).replaceAll('\\', '/')}`

async function openFixture(
  page: Page,
  title: keyof typeof contract.titles,
  theme: 'light' | 'dark',
  surface: 'title' | 'editor' | 'command' = 'title'
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
            <script type="module" src="${fixtureModule}"></script>
          </body>
        </html>`
    })
  })

  await page.goto(`/__article-editor-production-fixture?title=${title}&theme=${theme}&surface=${surface}`, {
    waitUntil: 'domcontentloaded'
  })
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.dataset.articleEditorFixtureReady
  ))).toBe('true')
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

test.describe('article editor production fixture command bar', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('desktop unifies back, state, save feedback, draft and one primary action', async ({ page }) => {
    await openFixture(page, 'short', 'light', 'command')
    const bar = page.locator('.article-write-command-bar')
    const actions = page.locator('.article-write-command-bar__actions')
    const status = page.getByRole('status')
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
      await expect(status).toHaveText({
        saving: '正在保存',
        failed: '保存失败，请重试',
        saved: '已保存',
        published: '发布完成'
      }[state])
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
