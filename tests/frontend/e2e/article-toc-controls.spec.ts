import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';

const fixtureModule = `/@fs/${fileURLToPath(new URL('../fixtures/articleTocControlsVisual.ts', import.meta.url))}`;
const visualStates: Array<{ theme: 'light' | 'dark'; reducedMotion: 'no-preference' | 'reduce' }> = [
    { theme: 'light', reducedMotion: 'no-preference' },
    { theme: 'dark', reducedMotion: 'no-preference' },
    { theme: 'light', reducedMotion: 'reduce' },
    { theme: 'dark', reducedMotion: 'reduce' }
];

async function openFixture(page: Page, theme: string, empty = false): Promise<string[]>
{
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.route('**/__article-toc-controls**', (route: Route) => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="article-toc-controls-fixture"></div><script type="module" src="${fixtureModule}"></script></body></html>`
    }));
    await page.goto(`/__article-toc-controls?theme=${theme}&empty=${empty ? '1' : '0'}`);
    await expect(page.locator('html[data-article-toc-controls-ready="true"]')).toHaveCount(1);
    return errors;
}

for (const { theme, reducedMotion } of visualStates)
{
    test(`desktop ${theme} ${reducedMotion} preserves chapter identity, keyboard activation and long headings`, async ({ page }: { page: Page }) =>
    {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.emulateMedia({ reducedMotion });
        const errors = await openFixture(page, theme);
        const buttons = page.locator('.article-toc-panel__nav button');
        await expect(buttons).toHaveCount(3);
        await expect(buttons.first()).toHaveAccessibleName('引言 Introduction');
        await expect(buttons.first()).toHaveAttribute('type', 'button');
        await expect(buttons.first()).toHaveAttribute('aria-current', 'location');
        await buttons.first().focus();
        await page.keyboard.press('Tab');
        await expect(buttons.nth(1)).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(buttons.nth(1)).toHaveAttribute('aria-current', 'location');
        await expect(buttons.first()).not.toHaveAttribute('aria-current', 'location');
        await expect(page.getByLabel('目录事件记录')).toHaveText('[{"event":"navigate","value":"chapter-long"}]');
        await page.keyboard.press('Space');
        await expect(page.getByLabel('目录事件记录')).toHaveText('[{"event":"navigate","value":"chapter-long"},{"event":"navigate","value":"chapter-long"}]');

        for (const zoom of [1, 2])
        {
            await page.evaluate((value: number) => document.documentElement.style.zoom = String(value), zoom);
            const geometry = await buttons.nth(1).evaluate((button: HTMLButtonElement) => ({
                width: button.clientWidth,
                contentWidth: button.scrollWidth,
                height: button.getBoundingClientRect().height,
                outline: getComputedStyle(button).boxShadow,
                marker: getComputedStyle(button, '::after').width
            }));
            expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.width + 1);
            expect(geometry.height).toBeGreaterThanOrEqual(40 * zoom);
            expect(geometry.outline).not.toBe('none');
            expect(geometry.marker).toBe('2px');
        }
        await page.screenshot({ path: `.tmp/pr-4403-toc-desktop-${theme}-${reducedMotion}.png`, fullPage: true });
        expect(errors).toEqual([]);
    });
}

test('empty article has no desktop chapter controls', async ({ page }: { page: Page }) =>
{
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = await openFixture(page, 'light', true);
    await expect(page.locator('.article-toc-panel')).toHaveCount(0);
    expect(errors).toEqual([]);
});

test.describe('mobile coarse-pointer chapter controls', () =>
{
    test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
    for (const { theme, reducedMotion } of visualStates)
    {
        test(`${theme} ${reducedMotion} navigates before closing and restores launcher focus`, async ({ page }: { page: Page }) =>
        {
            await page.emulateMedia({ reducedMotion });
            const errors = await openFixture(page, theme);
            const launcher = page.getByRole('button', { name: '打开文章目录' });
            await launcher.tap();
            const drawer = page.getByRole('dialog');
            await expect(drawer).toBeVisible();
            const buttons = drawer.locator('.article-toc-drawer__nav button');
            await expect(buttons).toHaveCount(3);
            await expect(buttons.first()).toHaveAttribute('aria-current', 'location');
            await buttons.nth(1).tap();
            await expect(drawer).not.toBeVisible();
            await expect(page.getByLabel('目录事件记录')).toHaveText('[{"event":"navigate","value":"chapter-long"},{"event":"mobileOpen","value":false}]');
            await expect(launcher).toBeFocused();
            await launcher.tap();
            await expect(drawer).toBeVisible();
            await expect.poll(() => drawer.evaluate((element: HTMLElement) =>
                Math.abs(window.innerHeight - element.getBoundingClientRect().bottom)
            )).toBeLessThanOrEqual(1);
            await expect(buttons.nth(1)).toHaveAttribute('aria-current', 'location');
            expect(await buttons.nth(1).evaluate((button: HTMLButtonElement) => getComputedStyle(button, '::after').pointerEvents)).toBe('none');
            await page.screenshot({ path: `.tmp/pr-4403-toc-mobile-${theme}-${reducedMotion}.png`, fullPage: true });
            await page.keyboard.press('Escape');
            await expect(drawer).not.toBeVisible();
            await expect(launcher).toBeFocused();
            await expect(page.getByLabel('目录事件记录')).toHaveText('[{"event":"navigate","value":"chapter-long"},{"event":"mobileOpen","value":false},{"event":"mobileOpen","value":false}]');
            expect(errors).toEqual([]);
        });
    }
});
