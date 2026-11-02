import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import type { ArticleWorkspaceTabFixture } from '../fixtures/articleWorkspaceTabStrip';

const fixtureModule = `/@fs/${fileURLToPath(new URL('../fixtures/articleWorkspaceTabStrip.ts', import.meta.url))}`;
type FixtureWindow = Window & { articleWorkspaceTabFixture?: ArticleWorkspaceTabFixture };
const errorsByPage = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) =>
{
    const errors: string[] = [];
    errorsByPage.set(page, errors);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message =>
    {
        if (message.type() === 'error')
        {
            errors.push(message.text());
        }
    });
});

test.afterEach(({ page }) =>
{
    expect(errorsByPage.get(page)).toEqual([]);
});

async function openFixture(page: Page, count: number, theme: 'light' | 'dark'): Promise<void>
{
    await page.route('**/__article-workspace-tab-fixture**', route => route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <title>Article workspace tab fixture</title></head><body>
            <main id="article-workspace-tab-fixture"></main><script type="module">
            import { mountArticleWorkspaceTabFixture } from ${JSON.stringify(fixtureModule)};
            await mountArticleWorkspaceTabFixture(${count}, ${JSON.stringify(theme)});
            </script></body></html>`
    }));
    // Static module dependencies participate in load; readiness then measures the mounted fixture.
    await page.goto(`/__article-workspace-tab-fixture?count=${count}&theme=${theme}`);
    await expectFixtureReady(page);
}

async function expectFixtureReady(page: Page): Promise<void>
{
    await expect(page.locator('html')).toHaveAttribute('data-workspace-tab-fixture-ready', 'true');
    await expect(page).toHaveTitle('Article workspace tab fixture');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
}

for (const theme of ['light', 'dark'] as const)
{
    test(`desktop projection keeps readable tab width and public focus paths in ${theme}`, async ({ page }, testInfo) =>
    {
        await page.setViewportSize({ width: 1440, height: 900 });
        await openFixture(page, 2, theme);
        const restingWidth = await page.locator('.article-workspace-tabs__item').first().evaluate(element => element.getBoundingClientRect().width);
        for (const count of [0, 1, 20, 100])
        {
            await page.evaluate((nextCount: number) => (window as FixtureWindow).articleWorkspaceTabFixture!.reset(nextCount), count);
            await expectFixtureReady(page);
            expect(await page.evaluate(() => (window as FixtureWindow).articleWorkspaceTabFixture!.snapshot().entries.length)).toBe(count);
            await expect(page.getByRole('tab')).toHaveCount(Math.min(count, 24));
        }
        await expect(page.locator('button button')).toHaveCount(0);
        const target = await page.getByRole('tab').evaluateAll(nodes =>
        {
            const index = nodes.findIndex(node => node.getAttribute('aria-selected') === 'true');
            return nodes[(index - 1 + nodes.length) % nodes.length].id;
        });
        await page.getByRole('tab', { selected: true }).press('ArrowLeft');
        await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('id', target);
        await expect(page.getByRole('tab', { selected: true })).toBeFocused();
        for (const key of ['Home', 'End'])
        {
            const edge = key === 'Home' ? page.getByRole('tab').first() : page.getByRole('tab').last();
            const targetId = await edge.getAttribute('id');
            await page.getByRole('tab', { selected: true }).press(key);
            await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('id', targetId!);
            await expect(page.getByRole('tab', { selected: true })).toBeFocused();
        }
        await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/一个非常长的工作区文章标题 Long workspace article title，已固定，当前/u);
        const activeTabId = await page.evaluate(() => (window as FixtureWindow).articleWorkspaceTabFixture!.snapshot().active!.tabId);
        await page.getByRole('tab', { selected: true }).click({ button: 'middle' });
        await expect.poll(() => page.evaluate(tabId => (window as FixtureWindow).articleWorkspaceTabFixture!.snapshot().entries.find(entry => entry.tabId === tabId)?.closeRequestRef, activeTabId)).toBeTruthy();
        const trigger = page.getByRole('button', { name: '更多标签（100）' });
        await trigger.click();
        await page.getByRole('menu').press('ArrowDown');
        await expect(page.getByRole('menuitem').first()).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
        const crowdedWidth = await page.locator('.article-workspace-tabs__item').first().evaluate(element => element.getBoundingClientRect().width);
        expect(crowdedWidth).toBeCloseTo(restingWidth, 0);
        await testInfo.attach(`desktop-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    });

    for (const compact of [false, true])
    {
        test(`${compact ? 'compact' : 'desktop'} blocked menu activation returns native focus in ${theme}`, async ({ page }, testInfo) =>
        {
            await page.setViewportSize({ width: compact ? 412 : 1440, height: 900 });
            await openFixture(page, 2, theme);
            await page.evaluate(() => (window as FixtureWindow).articleWorkspaceTabFixture!.block());
            const trigger = page.locator(compact ? '.article-workspace-tabs__compact-trigger' : '.article-workspace-tabs__overflow');
            await trigger.click();
            await page.locator(compact ? '.article-workspace-tabs__compact-tab' : '.article-workspace-tabs__overflow-tab').last().click();
            await expect(page.getByRole('menu')).toHaveCount(0);
            await expect(trigger).toBeFocused();
            await testInfo.attach(`${compact ? 'compact' : 'desktop'}-blocked-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
        });
    }
}

test('deferred ready activation focuses the live tab and survives unmount/remount', async ({ page }) =>
{
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFixture(page, 2, 'light');
    await page.evaluate(() => (window as FixtureWindow).articleWorkspaceTabFixture!.defer());
    await page.getByRole('button', { name: '更多标签（2）' }).click();
    await page.locator('.article-workspace-tabs__overflow-tab').last().click();
    await expect.poll(() => page.evaluate(() => (window as FixtureWindow).articleWorkspaceTabFixture!.snapshot().pending)).toBe(true);
    await expect(page.getByRole('menu')).toBeVisible();
    await page.evaluate(() => (window as FixtureWindow).articleWorkspaceTabFixture!.release());
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('tab', { selected: true })).toBeFocused();
    expect(await page.evaluate(() =>
    {
        const snapshot = (window as FixtureWindow).articleWorkspaceTabFixture!.snapshot();
        const entry = snapshot.entries.find(value => value.tabId === snapshot.active?.tabId);
        return snapshot.route === `/user/manage/article/edit/${entry?.identity.articleId}`;
    })).toBe(true);

    await page.getByRole('button', { name: '更多标签（2）' }).click();
    await page.locator('.article-workspace-tabs__overflow-tab').first().click();
    await expect.poll(() => page.evaluate(() => (window as FixtureWindow).articleWorkspaceTabFixture!.snapshot().pending)).toBe(true);
    await page.evaluate(() => (window as FixtureWindow).articleWorkspaceTabFixture!.remount());
    const trigger = page.getByRole('button', { name: '更多标签（2）' });
    await trigger.focus();
    await page.evaluate(() => (window as FixtureWindow).articleWorkspaceTabFixture!.release());
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
});

test.describe('coarse pointer with a keyboard', () =>
{
    test.use({ hasTouch: true });
    for (const theme of ['light', 'dark'] as const)
    {
        test(`retains the public two-pixel inset ring for the hovered active tab in ${theme}`, async ({ page }, testInfo) =>
        {
            await page.setViewportSize({ width: 412, height: 900 });
            await openFixture(page, 2, theme);
            const trigger = page.locator('.article-workspace-tabs__compact-trigger');
            await trigger.tap();
            await page.keyboard.press('Tab');
            await page.keyboard.press('Shift+Tab');
            await expect(trigger).toBeFocused();
            await trigger.evaluate(async element =>
            {
                getComputedStyle(element).boxShadow;
                await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined)));
            });
            const focusState = () => trigger.evaluate(element =>
            {
                const style = getComputedStyle(element);
                return {
                    coarse: matchMedia('(pointer: coarse)').matches,
                    hovered: element.matches(':hover'),
                    focusVisible: element.matches(':focus-visible'),
                    outlineStyle: style.outlineStyle,
                    outlineWidth: style.outlineWidth,
                    outlineOffset: style.outlineOffset,
                    outlineColor: style.outlineColor,
                    boxShadow: style.boxShadow
                };
            });
            try
            {
                await expect.poll(() => trigger.evaluate(element => ({
                    coarse: matchMedia('(pointer: coarse)').matches,
                    hovered: element.matches(':hover'),
                    focusVisible: element.matches(':focus-visible')
                }))).toEqual({ coarse: true, hovered: true, focusVisible: true });
                await expect.poll(() => trigger.evaluate(element => getComputedStyle(element).boxShadow))
                    .toMatch(/0px 0px 0px 2px inset/u);
            }
            finally
            {
                await testInfo.attach(`coarse-focus-${theme}`, {
                    contentType: 'application/json',
                    body: JSON.stringify(await focusState())
                });
            }
        });
    }
});
