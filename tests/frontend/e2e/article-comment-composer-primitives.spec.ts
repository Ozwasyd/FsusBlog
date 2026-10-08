import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import type {} from '../fixtures/articleCommentComposer'

const fixtureModule = `/@fs/${fileURLToPath(new URL('../fixtures/articleCommentComposer.ts', import.meta.url)).replaceAll('\\', '/')}`

async function openComposer(page: Page, theme = 'light', fixtureParams = ''): Promise<void> {
    await page.route('**/__article-comment-composer-fixture**', route => route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Comment composer fixture</title></head><body><main id="article-comment-composer-fixture"></main><script type="module" src="${fixtureModule}"></script></body></html>`
    }))
    await page.goto(`/__article-comment-composer-fixture?theme=${theme}${fixtureParams}`, { waitUntil: 'domcontentloaded' })
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.commentComposerFixtureReady)).toBe('true')
}

const normalEditor = (page: Page) => page.locator('.comment-composer-editor').getByRole('textbox', { name: '发表评论' })
const expandedDialog = (page: Page) => page.getByRole('dialog', { name: '扩展编辑评论' })
const selection = (editor: ReturnType<typeof normalEditor>) => editor.evaluate(element => {
    const textarea = element as HTMLTextAreaElement
    return [textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]
})

for (const policy of ['matching', 'changed']) {
    test(`restored ${policy} policy draft preserves private text and requires review then a new Checkbox choice`, async ({ page }) => {
        await openComposer(page, 'light', `&draft=${policy}&priorIdentity=public&privateBody=1`)
        const checkbox = page.getByRole('checkbox', { name: /公开显示我的名称/ })
        await expect(checkbox).not.toBeChecked()
        await expect(checkbox).toBeDisabled()
        await expect(normalEditor(page)).toHaveValue('当前私密正文')
        const storedBefore = await page.evaluate(() => ({ ...localStorage }))
        await normalEditor(page).press('Control+Enter')
        await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
        expect(await page.evaluate(() => ({ ...localStorage }))).toEqual(storedBefore)
        expect(await page.evaluate(() => window.articleCommentComposerFixture.submissions)).toEqual([])

        await page.getByRole('button', { name: '审查草稿', exact: true }).click()
        await expect(normalEditor(page)).toHaveValue('待审公开草稿')
        await expect(checkbox).not.toBeChecked()
        await expect(checkbox).toBeEnabled()
        expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('fsus:comment-public-draft:v3:')))).toEqual([])
        const nonDraftStorage = await page.evaluate(() => Object.fromEntries(
            Object.entries({ ...localStorage }).filter(([key]) => !key.startsWith('fsus:comment-public-draft:v3:'))
        ))
        const cookies = await page.context().cookies()
        await page.getByText('公开显示我的名称', { exact: true }).click()
        await expect(checkbox).toBeChecked()
        expect(await page.evaluate(() => window.articleCommentComposerFixture.submissions)).toEqual([])
        expect(await page.evaluate(() => Object.fromEntries(
            Object.entries({ ...localStorage }).filter(([key]) => !key.startsWith('fsus:comment-public-draft:v3:'))
        ))).toEqual(nonDraftStorage)
        expect(await page.context().cookies()).toEqual(cookies)
        await normalEditor(page).press('Control+Enter')
        const submissions = await page.evaluate(() => window.articleCommentComposerFixture.submissions)
        expect(submissions).toEqual([expect.objectContaining({ content: '待审公开草稿', authorMode: 'public', confirmed: true })])
        if (policy === 'matching') expect(submissions[0]!.mutationId).toBe('018ff003-1234-7abc-8def-0123456789ab')
        else expect(submissions[0]!.mutationId).not.toBe('018ff003-1234-7abc-8def-0123456789ab')
    })
}

for (const theme of ['light', 'dark']) {
    for (const width of [375, 768, 1440]) {
        test(`content, backward selection and focus survive repeated expansion: ${theme}/${width}`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 })
            await page.emulateMedia({ reducedMotion: 'reduce' })
            await openComposer(page, theme)
            const editor = normalEditor(page)
            const content = '中文评论，保留光标和 selection direction。'
            await editor.fill(content)
            await editor.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(2, 8, 'backward'))
            const trigger = page.getByRole('button', { name: '扩展编辑', exact: true })
            for (const closeWithEscape of [false, true]) {
                await trigger.click()
                const dialog = expandedDialog(page)
                const expanded = dialog.getByRole('textbox', { name: '发表评论' })
                await expect(expanded).toBeFocused()
                await expect(expanded).toHaveValue(content)
                expect(await selection(expanded)).toEqual([2, 8, 'backward'])
                await dialog.getByRole('radio', { name: '预览', exact: true }).click()
                await expect(dialog.getByRole('textbox')).toHaveCount(0)
                await dialog.getByRole('radio', { name: '编写', exact: true }).click()
                expect(await selection(expanded)).toEqual([2, 8, 'backward'])
                if (closeWithEscape) await expanded.press('Escape')
                else await dialog.getByRole('button', { name: '收起', exact: true }).click()
                await expect(dialog).not.toBeVisible()
                await expect(trigger).toBeFocused()
                await expect(editor).toHaveValue(content)
                expect(await selection(editor)).toEqual([2, 8, 'backward'])
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
            await page.screenshot({ path: test.info().outputPath(`composer-${theme}-${width}.png`), fullPage: true })
        })
    }
}

test('checkbox label and Space affect only this submission; the next composer uses the privacy default', async ({ page }) => {
    await openComposer(page)
    const checkbox = page.getByRole('checkbox', { name: '公开显示我的名称', exact: true })
    await expect(checkbox).not.toBeChecked()
    const storageBefore = await page.evaluate(() => ({ ...localStorage }))
    const cookiesBefore = await page.context().cookies()
    await page.getByText('公开显示我的名称', { exact: true }).click()
    await expect(checkbox).toBeChecked()
    expect(await page.evaluate(() => window.articleCommentComposerFixture.submissions)).toEqual([])
    expect(await page.evaluate(() => ({ ...localStorage }))).toEqual(storageBefore)
    expect(await page.context().cookies()).toEqual(cookiesBefore)
    await checkbox.focus()
    await checkbox.press('Space')
    await expect(checkbox).not.toBeChecked()
    await checkbox.press('Space')
    await normalEditor(page).fill('本次明确公开署名')
    await normalEditor(page).press('Control+Enter')
    expect(await page.evaluate(() => window.articleCommentComposerFixture.submissions)).toEqual([
        expect.objectContaining({ content: '本次明确公开署名', authorMode: 'public', confirmed: true })
    ])
    await page.evaluate(() => window.articleCommentComposerFixture.newSession())
    await expect(checkbox).not.toBeChecked()
})

test('Ctrl/Cmd+Enter are shared by both editor surfaces and disabled submits stay blocked', async ({ page }) => {
    await openComposer(page)
    await normalEditor(page).fill('快捷键评论')
    await normalEditor(page).press('Control+Enter')
    await page.getByRole('button', { name: '扩展编辑', exact: true }).click()
    const expanded = expandedDialog(page).getByRole('textbox', { name: '发表评论' })
    await expanded.fill('扩展快捷键评论')
    await expanded.press('Meta+Enter')
    expect(await page.evaluate(() => window.articleCommentComposerFixture.submissions.map(item => item.content))).toEqual(['快捷键评论', '扩展快捷键评论'])
    await page.evaluate(() => window.articleCommentComposerFixture.update({ isSubmitting: true }))
    await expect(expanded).toBeDisabled()
    await expect(expandedDialog(page).getByRole('button', { name: '发送中...' })).toBeDisabled()
})

test('composition commits before expansion and cannot trigger an early submit', async ({ page }) => {
    await openComposer(page)
    const editor = normalEditor(page)
    await editor.focus()
    await editor.dispatchEvent('compositionstart', { data: '' })
    await editor.evaluate(element => {
        (element as HTMLTextAreaElement).value = '输入中的中文'
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中文', isComposing: true }))
    })
    await editor.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true })
    expect(await page.evaluate(() => window.articleCommentComposerFixture.submissions)).toEqual([])
    await page.getByRole('button', { name: '扩展编辑', exact: true }).dispatchEvent('click')
    await expect(expandedDialog(page)).not.toBeVisible()
    await editor.dispatchEvent('compositionend', { data: '中文' })
    const expanded = expandedDialog(page).getByRole('textbox', { name: '发表评论' })
    await expect(expanded).toHaveValue('输入中的中文')
    await expanded.press('Control+Enter')
    expect(await page.evaluate(() => window.articleCommentComposerFixture.submissions)).toHaveLength(1)
})

test('disabled reasons remain in the accessible checkbox label at 200% zoom', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 })
    await openComposer(page, 'dark')
    await page.evaluate(() => { document.documentElement.style.zoom = '2' })
    for (const [props, reason] of [
        [{ isBanned: true }, '当前账号已被禁言'],
        [{ isBanned: false, publicCommentsEnabled: false }, '不允许公开署名评论'],
        [{ publicCommentsEnabled: true, isPowCalculating: true }, '正在准备发送'],
        [{ isPowCalculating: false, isSubmitting: true }, '正在发送评论']
    ] as const) {
        await page.evaluate(update => window.articleCommentComposerFixture.update(update), props)
        const checkbox = page.getByRole('checkbox', { name: new RegExp(reason) })
        await expect(checkbox).toBeDisabled()
        await expect(page.locator('.comment-identity-choice')).toContainText(reason)
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
    }
    await page.screenshot({ path: test.info().outputPath('disabled-dark-zoom-200.png'), fullPage: true })
})

test('touch activates the public checkbox without introducing a device-specific identity control', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })
    try {
        const page = await context.newPage()
        await openComposer(page)
        await page.getByText('公开显示我的名称', { exact: true }).tap()
        await expect(page.getByRole('checkbox')).toBeChecked()
        await expect(page.getByRole('checkbox')).toHaveCount(1)
        await expect(page.getByRole('switch')).toHaveCount(0)
    } finally {
        await context.close()
    }
})
