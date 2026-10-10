import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const fixtureModule = `/@fs/${fileURLToPath(new URL('../fixtures/articleEditorProductionVisual.ts', import.meta.url))}`

async function openOutline(page: Page, count: number, theme = 'light'): Promise<void> {
    await page.addInitScript(() => window.localStorage.removeItem('fsusblog.article-outline.rail-open.v1'))
    await page.route('**/__article-editor-production-fixture**', (route) => route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
            <div id="article-editor-production-fixture"></div>
            <script type="module">
                import { mountArticleEditorProductionFixture } from ${JSON.stringify(fixtureModule)};
                await mountArticleEditorProductionFixture();
            </script></body></html>`
    }))
    await page.goto(`/__article-editor-production-fixture?title=short&theme=${theme}&surface=outline&outlineCount=${count}&article=a`, {
        waitUntil: 'domcontentloaded'
    })
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.articleEditorFixtureReady), {
        timeout: 90_000
    }).toBe('true')
}

test.describe('article outline current rendered contract', () => {
    test.setTimeout(180_000)
    for (const count of [0, 1, 10, 100, 1000, 10000]) {
        test(`renders ${count} canonical headings with styled scroll and accessible truncation`, async ({ page }) => {
            await page.setViewportSize({ width: 1440, height: 900 })
            await openOutline(page, count)
            await page.getByRole('button', { name: '打开文章大纲' }).click()
            const panel = page.locator('[data-article-outline-panel="true"]')
            await expect(panel).toBeVisible()
            await expect(panel.getByRole('treeitem')).toHaveCount(count)
            if (count === 0) {
                await expect(panel.getByText('正文中暂无标题。')).toBeVisible()
                return
            }
            await expect(panel.getByRole('treeitem').first()).toHaveCSS('display', 'flex')
            await expect(panel.locator('.article-write-outline-tree-wrap')).toHaveCSS('overflow-y', 'auto')
            await expect(panel.locator('.article-write-outline-item-text').first()).toHaveCSS('white-space', 'nowrap')
            await expect(panel.locator('.article-write-outline-item-text').first()).toHaveCSS('text-overflow', 'ellipsis')
            await expect(panel.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1)
            if (count > 1) {
                const titleBox = await panel.locator('.article-write-outline-item-text').nth(1).boundingBox()
                const panelBox = await panel.boundingBox()
                expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width)
                const padding = await panel.getByRole('treeitem').evaluateAll((nodes) => nodes.slice(0, 2).map(
                    (node) => Number.parseFloat(getComputedStyle(node).paddingInlineStart)
                ))
                expect(padding[1]).toBeGreaterThan(padding[0]!)
            }
            if (count === 10) await page.screenshot({ path: '.tmp/ui-evidence/outline-styled-1440-light.png' })
        })
    }

    for (const width of [375, 768, 1024, 1366, 1440]) {
        for (const theme of ['light', 'dark']) {
            test(`${width} ${theme} preserves canvas width and returns keyboard focus`, async ({ page }) => {
                await page.setViewportSize({ width, height: 900 })
                await page.emulateMedia({ reducedMotion: 'reduce' })
                await openOutline(page, 10, theme)
                const editor = page.locator('#article-content')
                const before = await editor.boundingBox()
                const launcher = page.getByRole('button', { name: '打开文章大纲' })
                await launcher.click()
                const panel = page.locator('[data-article-outline-panel="true"]')
                await expect(panel).toBeVisible()
                const after = await editor.boundingBox()
                expect(Math.abs(after!.width - before!.width)).toBeLessThanOrEqual(8)
                const items = panel.getByRole('treeitem')
                await items.first().focus()
                await page.keyboard.press('ArrowDown')
                await expect(items.nth(1)).toBeFocused()
                await expect(panel.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1)
                // Capture the tested viewport; fullPage briefly resizes it to 1px in this managed Chromium.
                await page.screenshot({ path: `.tmp/ui-evidence/outline-open-${width}-${theme}.png` })
                await page.keyboard.press('Escape')
                await expect(launcher).toBeFocused()
            })
        }
    }

    test('consumes canonical empty diagnostics and resets expanded state for same-source A/B', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 })
        await openOutline(page, 10)
        await page.getByRole('button', { name: '打开文章大纲' }).click()
        const panel = page.locator('[data-article-outline-panel="true"]')
        const editor = page.locator('#article-content')
        await editor.fill('#\n\n#  \n')
        await expect(panel.getByRole('treeitem')).toHaveCount(2)
        await expect(panel.getByRole('button', { name: '空标题', exact: true })).toHaveCount(2)
        await panel.getByRole('button', { name: '空标题', exact: true }).first().click()
        await expect(editor).toBeFocused()
        await editor.fill('# Same\n\n## Child\n\n# Same\n')
        const before = await panel.getByRole('treeitem').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-outline-node-id')))
        await panel.getByRole('treeitem').first().focus()
        await page.keyboard.press('ArrowLeft')
        await expect(panel.getByRole('treeitem')).toHaveCount(2)
        await page.evaluate(() => (window as Window & {
            __articleEditorFixtureSwitchOutlineArticle?: (article: 'a' | 'b') => void;
        }).__articleEditorFixtureSwitchOutlineArticle?.('b'))
        await expect(panel.getByRole('treeitem')).toHaveCount(3)
        const after = await panel.getByRole('treeitem').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-outline-node-id')))
        expect(after.some((id) => before.includes(id))).toBe(false)
        await editor.fill('# Different article\n\n## Other\n')
        await expect(panel.getByRole('treeitem').first()).toHaveAccessibleName('Different article')
        // A newly assigned canonical parent is initially collapsed; navigate its disclosure before counting its child.
        await panel.getByRole('treeitem').first().focus()
        await page.keyboard.press('ArrowRight')
        await expect(panel.getByRole('treeitem')).toHaveCount(2)
        await expect(panel.getByRole('treeitem').first()).toHaveAccessibleName('Different article')
    })

    test('mobile reveal releases the Drawer focus trap before returning to the editor', async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 812 })
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await openOutline(page, 10, 'dark')
        await page.getByRole('button', { name: '打开文章大纲' }).click()
        const drawer = page.getByRole('dialog', { name: '文章大纲' })
        await drawer.getByRole('treeitem').nth(1).click()
        await expect(drawer).toBeHidden()
        await expect(page.locator('#article-content')).toBeFocused()
    })
})

test.describe('article outline touch navigation', () => {
    test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })
    test('touch selects the canonical heading and returns editing focus', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await openOutline(page, 10, 'light')
        await page.getByRole('button', { name: '打开文章大纲' }).tap()
        const drawer = page.getByRole('dialog', { name: '文章大纲' })
        await drawer.getByRole('treeitem').nth(1).tap()
        await expect(drawer).toBeHidden()
        await expect(page.locator('#article-content')).toBeFocused()
    })
})
