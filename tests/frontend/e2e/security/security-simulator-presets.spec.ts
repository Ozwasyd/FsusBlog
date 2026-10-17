import { expect, test } from '@playwright/test'

const presets = [
    { label: '放行', score: 10 },
    { label: '要求验证', score: 50 },
    { label: '进入队列', score: 90 },
    { label: '直接拦截', score: 125 }
] as const

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`${viewport.width}px controls`, () => {
        test.use({ hasTouch: viewport.width < 640 })
        for (const theme of ['light', 'dark'] as const) {
            for (const motion of ['no-preference', 'reduce'] as const) {
                test(`preset controls preserve native activation and row layout in ${theme} with ${motion} motion`, async ({ page }, testInfo) => {
                    const consoleErrors: string[] = []
                    const simulationRequests: string[] = []
                    page.on('pageerror', (error) => consoleErrors.push(error.message))
                    page.on('console', (message) => {
                        if (message.type() === 'error' || message.type() === 'warning') {
                            consoleErrors.push(message.text())
                        }
                    })
                    page.on('request', (request) => {
                        if (new URL(request.url()).pathname.endsWith('/risk-control/simulate')) {
                            simulationRequests.push(request.url())
                        }
                    })
                    await page.setViewportSize(viewport)
                    await page.emulateMedia({ colorScheme: theme, reducedMotion: motion })
                    await page.route('**/__security-simulator-controls-e2e', (route) => route.fulfill({
                        contentType: 'text/html',
                        body: `<!doctype html><html class="${theme}" lang="zh-CN"><head>
                            <meta name="viewport" content="width=device-width, initial-scale=1">
                            <title>Security simulator controls</title></head><body>
                            <main id="simulator-fixture"></main><script type="module">
                            import { createApp } from '/@id/vue';
                            import FsusUI from '/@id/@ozwasyd/element-plus';
                            import Simulator from '/src/views/admin/security/SecuritySimulator.vue';
                            import '/src/assets/main.css';
                            createApp(Simulator).use(FsusUI).mount('#simulator-fixture');
                            </script></body></html>`
                    }))
                    await page.goto('/__security-simulator-controls-e2e')
                    await expect(page).toHaveTitle('Security simulator controls')
                    await expect(page.getByText('风险模拟器', { exact: true })).toBeVisible()
                    await expect(page.locator('vite-error-overlay')).toHaveCount(0)
                    const scoreInput = page.getByRole('spinbutton', { name: '风险分' })
                    const rows = page.locator('.security-simulator-preset')
                    await expect(rows).toHaveCount(presets.length)
                    for (const { label, score } of presets) {
                        const button = page.getByRole('button', { name: new RegExp(`${label}\\s*${score}`) })
                        await expect(button).toHaveAttribute('type', 'button')
                        await expect(button).toBeEnabled()
                        if (viewport.width < 640) {
                            await button.tap()
                        } else {
                            await button.click()
                        }
                        await expect(scoreInput).toHaveValue(String(score))
                    }
                    const first = rows.first()
                    await first.focus()
                    await expect(first).toBeFocused()
                    await page.keyboard.press('Enter')
                    await expect(scoreInput).toHaveValue('10')
                    await page.keyboard.press('Tab')
                    await expect(rows.nth(1)).toBeFocused()
                    await page.keyboard.press('Space')
                    await expect(scoreInput).toHaveValue('50')
                    const boxes = await rows.evaluateAll((buttons) => buttons.map((button) => {
                        const box = button.getBoundingClientRect()
                        const panel = button.parentElement!.getBoundingClientRect()
                        return { left: box.left, right: box.right, width: box.width, height: box.height, panelLeft: panel.left, panelRight: panel.right }
                    }))
                    for (const box of boxes) {
                        expect(box.width).toBeGreaterThan(0)
                        expect(box.height).toBeGreaterThanOrEqual(40)
                        expect(Math.abs(box.left - boxes[0].left)).toBeLessThanOrEqual(1)
                        expect(Math.abs(box.width - boxes[0].width)).toBeLessThanOrEqual(1)
                        expect(box.left).toBeGreaterThanOrEqual(box.panelLeft - 1)
                        expect(box.right).toBeLessThanOrEqual(box.panelRight + 1)
                    }
                    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
                    expect(simulationRequests).toEqual([])
                    expect(consoleErrors).toEqual([])
                    await page.screenshot({ path: testInfo.outputPath(`simulator-${viewport.width}-${theme}-${motion}.png`), fullPage: true })
                })
            }
        }
    })
}
