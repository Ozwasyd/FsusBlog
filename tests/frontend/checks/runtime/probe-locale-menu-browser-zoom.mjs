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
        report.observations.realBrowserZoom = { method: 'chrome.tabs.setZoom/getZoom', factor: zoom, before, variants: [], focusPaintFailures: [], surfacePaintFailures: [], qualification: false };
        const trigger = page.locator('[data-locale-selector-trigger]');
        const menu = page.locator('[data-locale-selector-menu]');
        const item = (code) => page.locator(`[data-locale-code="${code}"]`);
        const readFocusPaint = (element) =>
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
        };
        const hasFocusPaint = (paint) => paint.focusVisible && (paint.boxShadow !== 'none'
            || (paint.outlineStyle !== 'none' && Number.parseFloat(paint.outlineWidth) > 0)
            || (paint.afterContent !== 'none' && paint.afterBorderStyle !== 'none' && Number.parseFloat(paint.afterBorderWidth) > 0));
        const captureViewport = async (width, fileName) =>
        {
            // Wait for committed paint frames after a diagnostic underlay/style mutation.
            await page.evaluate(() => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
            const session = await context.newCDPSession(page);
            try
            {
                const capture = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                const png = Buffer.from(capture.data, 'base64');
                expect(png.readUInt32BE(16)).toBe(width);
                expect(png.readUInt32BE(20)).toBe(900);
                if (fileName)
                {
                    await fs.writeFile(path.join(evidenceRoot, fileName), png);
                }
                return capture.data;
            }
            finally
            {
                await session.detach();
            }
        };
        for (const variant of [
            { width: 375, theme: 'light', rtl: false, forcedColors: 'none' },
            { width: 1440, theme: 'dark', rtl: true, forcedColors: 'none' },
            { width: 375, theme: 'light', rtl: false, forcedColors: 'active' },
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
            const surfacePaint = await menu.evaluate((element) =>
            {
                const canvas = globalThis.document.createElement('span');
                canvas.style.backgroundColor = 'Canvas';
                globalThis.document.body.append(canvas);
                const canvasColor = globalThis.getComputedStyle(canvas).backgroundColor;
                canvas.remove();
                const ancestors = [];
                for (let current = element; current && current !== globalThis.document.body; current = current.parentElement)
                {
                    const style = globalThis.getComputedStyle(current);
                    ancestors.push({ tag: current.tagName, className: current.className, backgroundColor: style.backgroundColor, opacity: style.opacity, forcedColorAdjust: style.forcedColorAdjust });
                }
                return { canvasColor, ancestors };
            });
            const focusPaint = await item('ru-RU').evaluate(readFocusPaint);
            if (variant.forcedColors === 'active' && !hasFocusPaint(focusPaint))
            {
                report.observations.realBrowserZoom.focusPaintFailures.push('forced-colors-focus-paint');
            }
            const observation = { ...variant, geometry, focusPaint, surfacePaint };
            report.observations.realBrowserZoom.variants.push(observation);
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
            await captureViewport(variant.width, `consumer-${variant.width}-${variant.theme}-real-browser-zoom2-${variant.forcedColors}.png`);
            const afterCapture = await page.evaluate(() => ({ innerWidth: globalThis.innerWidth, dpr: globalThis.devicePixelRatio }));
            expect(afterCapture).toEqual({ innerWidth: geometry.innerWidth, dpr: geometry.dpr });
            if (variant.forcedColors === 'active')
            {
                const compareUnderlay = async (label) =>
                {
                    await menu.evaluate((element) =>
                    {
                        const panel = element.closest('.el-popper');
                        const underlay = globalThis.document.createElement('div');
                        underlay.dataset.localeSurfaceUnderlay = '';
                        underlay.style.cssText = `position: fixed; inset: 0; z-index: ${Number(globalThis.getComputedStyle(panel).zIndex) - 1}; pointer-events: none; forced-color-adjust: none;`;
                        globalThis.document.body.append(underlay);
                    });
                    try
                    {
                        const shots = [];
                        for (const color of ['black', 'white'])
                        {
                            await page.locator('[data-locale-surface-underlay]').evaluate((element, value) => element.style.backgroundColor = value, color);
                            shots.push(await captureViewport(variant.width, `surface-${variant.theme}-${label}-${color}.png`));
                        }
                        return await page.evaluate(async ({ shots: images, panel, dpr }) =>
                        {
                            const readPixels = async (data) =>
                            {
                                const image = new globalThis.Image();
                                image.src = `data:image/png;base64,${data}`;
                                await image.decode();
                                const canvas = globalThis.document.createElement('canvas');
                                canvas.width = image.naturalWidth;
                                canvas.height = image.naturalHeight;
                                const paint = canvas.getContext('2d');
                                paint.drawImage(image, 0, 0);
                                return paint.getImageData(0, 0, canvas.width, canvas.height);
                            };
                            const [black, white] = await Promise.all(images.map(readPixels));
                            // Exclude only the rounded edge and border; retain all text and item states.
                            const region = { left: Math.ceil((panel.left + 14) * dpr), right: Math.floor((panel.right - 14) * dpr), top: Math.ceil((panel.top + 14) * dpr), bottom: Math.floor((panel.bottom - 14) * dpr) };
                            let changedPixels = 0;
                            let maxChannelDelta = 0;
                            let inspectedPixels = 0;
                            for (let y = region.top; y < region.bottom; y++)
                            {
                                for (let x = region.left; x < region.right; x++)
                                {
                                    const offset = (y * black.width + x) * 4;
                                    const delta = Math.max(...[0, 1, 2].map((channel) => Math.abs(black.data[offset + channel] - white.data[offset + channel])));
                                    if (delta > 0)
                                    {
                                        changedPixels++;
                                    }
                                    maxChannelDelta = Math.max(maxChannelDelta, delta);
                                    inspectedPixels++;
                                }
                            }
                            return { region, inspectedPixels, changedPixels, maxChannelDelta };
                        }, { shots, panel: geometry.panel, dpr: geometry.dpr });
                    }
                    finally
                    {
                        await page.locator('[data-locale-surface-underlay]').evaluate((element) => element.remove());
                    }
                };
                observation.surfaceUnderlay = await compareUnderlay('current');
                if (observation.surfaceUnderlay.changedPixels !== 0)
                {
                    report.observations.realBrowserZoom.surfacePaintFailures.push(`forced-colors-${variant.theme}-background-bleed`);
                }
                const originalStyle = await menu.evaluate((element) =>
                {
                    const panel = element.closest('.el-popper');
                    const value = panel.getAttribute('style');
                    panel.style.setProperty('background-color', 'var(--el-bg-color-overlay)', 'important');
                    return value;
                });
                try
                {
                    observation.surfaceUnderlayNegative = await compareUnderlay('alpha-negative');
                    expect(observation.surfaceUnderlayNegative.changedPixels).toBeGreaterThan(0);
                }
                finally
                {
                    await menu.evaluate((element, value) =>
                    {
                        const panel = element.closest('.el-popper');
                        if (value === null)
                        {
                            panel.removeAttribute('style');
                        }
                        else
                        {
                            panel.setAttribute('style', value);
                        }
                    }, originalStyle);
                }
                observation.surfaceUnderlayRestored = await compareUnderlay('restored');
                expect(observation.surfaceUnderlayRestored).toEqual(observation.surfaceUnderlay);
                expect(await page.locator('[data-locale-surface-underlay]').count()).toBe(0);
            }
            if (variant.forcedColors === 'active')
            {
                const negativeStyle = await page.addStyleTag({ content: '[data-locale-code="ru-RU"]::after { content: none !important; }' });
                try
                {
                    observation.focusPaintNegative = await item('ru-RU').evaluate(readFocusPaint);
                    expect(hasFocusPaint(observation.focusPaintNegative)).toBe(false);
                }
                finally
                {
                    await negativeStyle.evaluate((element) => element.remove());
                }
                expect(await item('ru-RU').evaluate(readFocusPaint)).toEqual(focusPaint);
            }
            await page.keyboard.press('Escape');
            await expect(trigger).toBeFocused();
            await expect(menu).not.toBeAttached();
            observation.triggerFocusPaint = await trigger.evaluate(readFocusPaint);
            if (variant.forcedColors === 'active' && !hasFocusPaint(observation.triggerFocusPaint))
            {
                report.observations.realBrowserZoom.focusPaintFailures.push('forced-colors-trigger-focus-paint');
            }
        }
    }
    finally
    {
        await context?.close();
        await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
}
