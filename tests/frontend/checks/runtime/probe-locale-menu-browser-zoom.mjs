import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// This supplements the component probe. It is not the live-backend viewport acceptance workflow.
export async function probeLocaleMenuBrowserZoom({ chromium, expect, url, evidenceRoot, report })
{
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'locale-browser-zoom-'));
    const extensionRoot = path.join(temporaryRoot, 'extension');
    let context;
    try
    {
        await fs.mkdir(extensionRoot);
        await fs.writeFile(path.join(extensionRoot, 'manifest.json'), JSON.stringify({
            manifest_version: 3,
            name: 'Locale probe tab zoom',
            version: '1.0',
            permissions: ['tabs'],
            background: { service_worker: 'background.js' }
        }));
        await fs.writeFile(path.join(extensionRoot, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});\n');
        context = await chromium.launchPersistentContext(path.join(temporaryRoot, 'profile'), {
            channel: 'chromium',
            headless: true,
            viewport: { width: 1440, height: 900 },
            args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`]
        });
        const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 10000 });
        const page = context.pages()[0];
        page.setDefaultTimeout(5000);
        page.on('pageerror', (error) => report.errors.push(`real-zoom-browser: ${error.message}`));
        await page.goto(`${url}?consumer`, { timeout: 30000 });
        const before = await page.evaluate(() => ({ innerWidth: globalThis.innerWidth, dpr: globalThis.devicePixelRatio }));
        const zoom = await worker.evaluate(async (targetUrl) =>
        {
            const tab = (await globalThis.chrome.tabs.query({})).find((candidate) => candidate.url === targetUrl);
            if (!tab)
            {
                throw new Error('consumer tab is unavailable to the zoom probe');
            }
            await globalThis.chrome.tabs.setZoomSettings(tab.id, { scope: 'per-tab', mode: 'automatic' });
            await globalThis.chrome.tabs.setZoom(tab.id, 2);
            return globalThis.chrome.tabs.getZoom(tab.id);
        }, page.url());
        expect(zoom).toBe(2);
        await expect.poll(() => page.evaluate(() => globalThis.devicePixelRatio)).toBe(before.dpr * 2);
        report.observations.realBrowserZoom = { method: 'chrome.tabs.setZoom/getZoom', factor: zoom, before, variants: [], focusPaintFailures: [], qualification: false };
        const trigger = page.locator('[data-locale-selector-trigger]');
        const menu = page.locator('[data-locale-selector-menu]');
        const item = (code) => page.locator(`[data-locale-code="${code}"]`);
        for (const variant of [
            { width: 375, theme: 'light', rtl: false, forcedColors: 'none' },
            { width: 1440, theme: 'dark', rtl: true, forcedColors: 'none' },
            { width: 375, theme: 'dark', rtl: true, forcedColors: 'active' }
        ])
        {
            await page.setViewportSize({ width: variant.width, height: 900 });
            await page.emulateMedia({ colorScheme: variant.theme, reducedMotion: 'reduce', forcedColors: variant.forcedColors });
            await page.evaluate(({ theme }) => globalThis.document.documentElement.classList.toggle('dark', theme === 'dark'), variant);
            if ((await page.locator('.consumer').getAttribute('dir') === 'rtl') !== variant.rtl)
            {
                await page.locator('[data-consumer="rtl"]').click();
            }
            await trigger.focus();
            await page.keyboard.press('ArrowDown');
            await expect(item('zh-CN')).toBeFocused();
            await expect(page.getByRole('menuitemradio')).toHaveCount(10);
            await expect(page.getByRole('menuitemradio', { checked: true })).toHaveCount(1);
            await page.keyboard.press('Home');
            await expect(item('zh-CN')).toBeFocused();
            await page.keyboard.press('End');
            await expect(item('ru-RU')).toBeFocused();
            await menu.evaluate(async () => Promise.allSettled(globalThis.document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished)));
            const geometry = await menu.evaluate((element) =>
            {
                const root = globalThis.document.documentElement;
                const panel = element.closest('.el-popper').getBoundingClientRect();
                return {
                    innerWidth: globalThis.innerWidth,
                    innerHeight: globalThis.innerHeight,
                    dpr: globalThis.devicePixelRatio,
                    cssZoom: globalThis.getComputedStyle(root).zoom,
                    clientWidth: root.clientWidth,
                    scrollWidth: root.scrollWidth,
                    panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
                    clippedLabels: [...element.querySelectorAll('[data-locale-selector-item]')].filter((row) =>
                    {
                        const box = row.getBoundingClientRect();
                        return [...row.querySelectorAll('.locale-selector__item-native, .locale-selector__item-english')].some((label) =>
                        {
                            const copy = label.getBoundingClientRect();
                            return copy.top < box.top || copy.bottom > box.bottom || copy.left < box.left || copy.right > box.right;
                        });
                    }).map((row) => row.getAttribute('data-locale-code'))
                };
            });
            const focusPaint = await item('ru-RU').evaluate((element) =>
            {
                const style = globalThis.getComputedStyle(element);
                const after = globalThis.getComputedStyle(element, '::after');
                return {
                    focusVisible: element.matches(':focus-visible'),
                    boxShadow: style.boxShadow,
                    outlineStyle: style.outlineStyle,
                    outlineWidth: style.outlineWidth,
                    afterContent: after.content,
                    afterBorderStyle: after.borderTopStyle,
                    afterBorderWidth: after.borderTopWidth,
                    afterBorderColor: after.borderTopColor
                };
            });
            if (variant.forcedColors === 'active' && (!focusPaint.focusVisible || (
                focusPaint.boxShadow === 'none'
                && (focusPaint.outlineStyle === 'none' || Number.parseFloat(focusPaint.outlineWidth) === 0)
                && (focusPaint.afterContent === 'none' || focusPaint.afterBorderStyle === 'none' || Number.parseFloat(focusPaint.afterBorderWidth) === 0)
            )))
            {
                report.observations.realBrowserZoom.focusPaintFailures.push('forced-colors-focus-paint');
            }
            report.observations.realBrowserZoom.variants.push({ ...variant, geometry, focusPaint });
            expect(geometry.cssZoom).toBe('1');
            expect(geometry.dpr).toBe(before.dpr * 2);
            expect(geometry.innerWidth).toBeLessThan(variant.width);
            expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
            expect(geometry.clippedLabels).toEqual([]);
            expect(geometry.panel.left).toBeGreaterThanOrEqual(-1);
            expect(geometry.panel.right).toBeLessThanOrEqual(geometry.innerWidth + 1);
            expect(geometry.panel.top).toBeGreaterThanOrEqual(-1);
            expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.innerHeight + 1);
            // Capture the physical viewport without Playwright's full-page resize at tab zoom.
            const session = await context.newCDPSession(page);
            try
            {
                const capture = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                const png = Buffer.from(capture.data, 'base64');
                expect(png.readUInt32BE(16)).toBe(variant.width);
                expect(png.readUInt32BE(20)).toBe(900);
                await fs.writeFile(path.join(evidenceRoot, `consumer-${variant.width}-${variant.theme}-real-browser-zoom2-${variant.forcedColors}.png`), png);
                const afterCapture = await page.evaluate(() => ({ innerWidth: globalThis.innerWidth, dpr: globalThis.devicePixelRatio }));
                expect(afterCapture).toEqual({ innerWidth: geometry.innerWidth, dpr: geometry.dpr });
            }
            finally
            {
                await session.detach();
            }
            await page.keyboard.press('Escape');
            await expect(trigger).toBeFocused();
            await expect(menu).not.toBeAttached();
        }
    }
    finally
    {
        await context?.close();
        await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
}
