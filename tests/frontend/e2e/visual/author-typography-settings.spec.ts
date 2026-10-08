import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixtureModule = `/@fs/${fileURLToPath(new URL('../../fixtures/authorTypographySettingsVisual.ts', import.meta.url)).replaceAll('\\', '/')}`;
const states = ['current', 'loading', 'saving', 'saved', 'conflict', 'unavailable', 'permission', 'device', 'default', 'exhausted', 'font-loaded', 'font-loading', 'font-failed', 'font-fallback'] as const;
const themes = ['light', 'dark'] as const;
const viewports = [{ width: 375, height: 812 }, { width: 768, height: 900 }, { width: 1440, height: 900 }];

async function open(page: Page, state: string, theme: string)
{
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request =>
    {
        const url = new URL(request.url());
        if (url.protocol.startsWith('http') && !['127.0.0.1', 'localhost'].includes(url.hostname)) external.push(request.url());
    });
    await page.route('**/__author-typography-fixture**', route => route.fulfill({
        status: 200, contentType: 'text/html',
        body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Typography controlled settings fixture</title></head><body><div id="author-typography-fixture"></div><script type="module" src="${fixtureModule}"></script></body></html>`
    }));
    await page.goto(`/__author-typography-fixture?state=${state}&theme=${theme}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-typography-fixture-ready', 'true');
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    // The actual trusted renderer must finish; source text or a stub is insufficient.
    await expect(page.getByRole('heading', { name: '写作样例' })).toBeVisible();
    return { errors, external };
}

for (const viewport of viewports)
for (const theme of themes)
{
    test.describe(`${viewport.width} ${theme}`, () =>
    {
        test.use({ viewport, contextOptions: { reducedMotion: 'reduce' } });
        test('five disabled dimensions and readable actual sample fit without horizontal page overflow', async ({ page }, testInfo) =>
        {
            const observed = await open(page, 'current', theme);
            await expect(page.getByRole('combobox')).toHaveCount(5);
            for (const name of ['字体', '字号', '行高', '画布宽度', '段落间距'])
            {
                const choice = page.getByRole('combobox', { name, exact: true });
                await expect(choice).toBeDisabled();
                const box = await choice.boundingBox();
                expect(box).not.toBeNull();
                // Measure the public control, not its inner text input.
                const controlHeight = await choice.evaluate(element => element.closest('.el-select')!.getBoundingClientRect().height);
                expect(controlHeight).toBeGreaterThanOrEqual(44);
            }
            await expect(page.getByRole('button', { name: '恢复默认排版' })).toBeDisabled();
            await expect(page.getByText('内容样例 · 排版预览暂不可用，尚未应用所选偏好。')).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
            await expect.poll(() => page.locator('.blog-markdown-renderer p').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
            await expect.poll(() => page.locator('.blog-markdown-renderer p').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth))).toBe(true);
            expect(observed.errors).toEqual([]);
            expect(observed.external).toEqual([]);
            await page.screenshot({ path: testInfo.outputPath(`typography-${viewport.width}-${theme}.png`), fullPage: true });
        });
    });
}

test.describe('controlled states and keyboard', () =>
{
    test.use({ viewport: { width: 375, height: 812 }, contextOptions: { reducedMotion: 'reduce' } });
    for (const state of states)
    {
        test(state, async ({ page }) =>
        {
            const observed = await open(page, state, 'light');
            await expect(page.getByRole('button', { name: '恢复默认排版' })).toBeDisabled();
            await expect(page.getByRole('combobox').first()).toBeDisabled();
            if (state === 'conflict' || state === 'unavailable')
            {
                const reload = page.getByRole('button', { name: '重新读取偏好' });
                await expect(reload).toBeEnabled();
                await page.keyboard.press('Tab');
                await expect(reload).toBeFocused();
                await page.keyboard.press('Enter');
                await expect(page.getByText('当前偏好版本 18。')).toBeVisible();
                expect(await page.evaluate(() => document.documentElement.dataset.typographyReloads)).toBe('1');
                await expect(page.getByRole('button', { name: '重新读取偏好' })).toHaveCount(0);
            }
            if (state === 'loading') await expect(page.getByRole('form', { name: '作者排版设置' })).toHaveAttribute('aria-busy', 'true');
            if (state === 'saving') await expect(page.getByText('正在保存偏好。')).toBeVisible();
            if (state === 'font-loading') await expect(page.getByText('字体正在准备。')).toBeVisible();
            if (state === 'font-loaded') await expect(page.getByText('字体已准备。')).toBeVisible();
            if (state === 'exhausted') await expect(page.getByText('偏好版本已达上限，暂不能保存或重置。')).toBeVisible();
            if (state === 'font-failed') await expect(page.getByText('字体加载失败。')).toBeVisible();
            if (state === 'font-fallback') await expect(page.getByText('正在使用已登记的回退字体。')).toBeVisible();
            expect(await page.evaluate(() => [document.documentElement.dataset.typographyChanges, document.documentElement.dataset.typographyResets])).toEqual([undefined, undefined]);
            expect(observed.errors).toEqual([]);
            expect(observed.external).toEqual([]);
        });
    }
    for (const zoom of [1.5, 2])
    {
        test(`CSS zoom ${zoom} is readable without horizontal page overflow`, async ({ page }, testInfo) =>
        {
            await open(page, 'conflict', 'light');
            // CSS zoom covers reflow, not an OS/browser magnification acceptance gate.
            await page.evaluate(value => { document.body.style.zoom = String(value); }, zoom);
            expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
            const sample = page.getByRole('region', { name: '排版内容样例' });
            expect(await sample.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
            for (const choice of await page.getByRole('combobox').all())
            {
                const box = await choice.boundingBox();
                expect(box).not.toBeNull();
                expect(box!.x + box!.width).toBeLessThanOrEqual(375);
            }
            await expect(page.getByRole('button', { name: '重新读取偏好' })).toBeEnabled();
            await page.screenshot({ path: testInfo.outputPath(`typography-zoom-${zoom}.png`), fullPage: true });
        });
    }
});
