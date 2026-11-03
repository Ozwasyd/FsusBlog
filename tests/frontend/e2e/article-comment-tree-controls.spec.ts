import { fileURLToPath } from 'node:url';

import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';

const fixtureModule = `/@fs/${fileURLToPath(new URL('../fixtures/articleCommentTreeControls.ts', import.meta.url))}`;

interface DangerHoverColors
{
    actual: string;
    binding: string | null;
    dangerBase: string | null;
    dangerHover: string | null;
    regular: string | null;
    primary: string | null;
}

async function openFixture(page: Page, theme: string, width: number): Promise<void>
{
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/__comment-tree-controls?*', (route: Route) => route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="comment-tree-controls"></div><script type="module" src="${fixtureModule}"></script></body></html>`
    }));
    await page.goto(`/__comment-tree-controls?theme=${theme}`);
    await expect(page.locator('html')).toHaveAttribute('data-comment-tree-controls-ready', 'true');
}

async function readDangerHoverColors(deletion: Locator): Promise<DangerHoverColors>
{
    return deletion.evaluate((element: HTMLElement) =>
    {
        const resolveColor = (scope: HTMLElement, token: string): string | null =>
        {
            if (!getComputedStyle(scope).getPropertyValue(token).trim())
            {
                return null;
            }
            const reference = document.createElement('span');
            reference.style.color = `var(${token})`;
            scope.append(reference);
            const color = getComputedStyle(reference).color;
            reference.remove();
            return color;
        };
        const palette = document.documentElement;
        return {
            actual: getComputedStyle(element).color,
            binding: resolveColor(element, '--el-button-hover-link-text-color'),
            dangerBase: resolveColor(palette, '--el-color-danger'),
            // FsusUI's public danger variant maps link hover to danger-light-5.
            // Read the root semantic palette independently of the mutable Button binding.
            dangerHover: resolveColor(palette, '--el-color-danger-light-5'),
            regular: resolveColor(palette, '--el-text-color-regular'),
            primary: resolveColor(palette, '--el-color-primary')
        };
    });
}

function dangerHoverViolations(colors: DangerHoverColors): string[]
{
    const violations: string[] = [];
    if (!colors.dangerBase || !colors.dangerHover || !colors.regular || !colors.primary)
    {
        violations.push('semantic-danger-palette-missing');
    }
    if (colors.dangerBase === colors.regular || colors.dangerBase === colors.primary
        || colors.dangerHover === colors.regular || colors.dangerHover === colors.primary)
    {
        violations.push('semantic-danger-palette-is-ordinary');
    }
    if (!colors.binding || colors.binding !== colors.dangerHover)
    {
        violations.push('hover-binding-is-not-danger');
    }
    if (!colors.dangerHover || colors.actual !== colors.dangerHover)
    {
        violations.push('rendered-hover-is-not-danger');
    }
    return violations;
}

function assertDangerHover(colors: DangerHoverColors): void
{
    expect(dangerHoverViolations(colors), JSON.stringify(colors)).toEqual([]);
}

async function expectDangerHover(deletion: Locator): Promise<void>
{
    await expect(async () => assertDangerHover(await readDangerHoverColors(deletion))).toPass({ timeout: 15_000 });
}

for (const theme of ['light', 'dark'])
{
    for (const width of [375, 1440])
    {
        test(`comment controls preserve actions, focus and geometry at ${width}px in ${theme}`, async ({ page }: { page: Page }, testInfo: TestInfo) =>
        {
            await openFixture(page, theme, width);
            const root = page.locator('#comment-7');
            const footer = root.locator(':scope > footer');
            const actions = footer.getByRole('button');
            await expect(actions).toHaveCount(5);
            for (const action of await actions.all())
            {
                await expect(action).toHaveAttribute('type', 'button');
                if (width === 375)
                {
                    const box = await action.boundingBox();
                    expect(box?.width).toBeGreaterThanOrEqual(44);
                    expect(box?.height).toBeGreaterThanOrEqual(44);
                }
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
            const deletion = footer.getByRole('button', { name: '删除评论', exact: true });
            await deletion.hover();
            await testInfo.attach('public-button-styles', {
                contentType: 'application/json',
                body: JSON.stringify(await readDangerHoverColors(deletion))
            });
            await expectDangerHover(deletion);
            await page.screenshot({ path: testInfo.outputPath('comment-controls.png'), fullPage: true });
            const reply = footer.getByRole('button', { name: '回复', exact: true });
            await reply.focus();
            await page.keyboard.press('Space');
            await footer.getByRole('button', { name: '编辑', exact: true }).click();
            await deletion.focus();
            await page.keyboard.press('Enter');
            const bodyFold = footer.getByRole('button', { name: '展开正文', exact: true });
            await bodyFold.click();
            await expect(footer.getByRole('button', { name: '收起正文', exact: true })).toBeVisible();
            const branch = footer.locator('[aria-controls="comment-children-7"]');
            await branch.click();
            await expect(root).toBeFocused();
            await expect(branch).toHaveAttribute('aria-expanded', 'false');
            await expect(page.locator('#comment-children-7')).toHaveCount(0);
            await branch.click();
            await expect(branch).toHaveAttribute('aria-expanded', 'true');
            const loadMore = root.locator(':scope > [role="group"] > .fsus-comment-tree-node__load-more');
            await expect(loadMore).toHaveText('加载本分支更多回复');
            await loadMore.click();
            await expect(loadMore).toBeDisabled();
            await expect(loadMore).toHaveText('加载中…');
            const events = JSON.parse(await page.locator('[data-comment-events]').innerText());
            expect(events.map((event: { action: string }) => event.action)).toEqual(['reply', 'edit', 'delete', 'loadMore']);
            expect(events[0].payload).toMatchObject({ id: '7', rootId: '7', depth: 0 });
            expect(events[1].payload).toMatchObject({ id: '7' });
            expect(events[2].payload).toMatchObject({ id: '7', rootId: '7', parentId: null });
            expect(events[3].payload).toBe('7');
        });
    }
}

for (const ordinaryToken of ['--el-text-color-regular', '--el-color-primary'])
{
    test(`rejects a real danger hover binding corrupted to ${ordinaryToken}`, async ({ page }: { page: Page }, testInfo: TestInfo) =>
    {
        await openFixture(page, 'light', 375);
        const deletion = page.locator('#comment-7 > footer').getByRole('button', { name: '删除评论', exact: true });
        await deletion.hover();
        await expectDangerHover(deletion);
        const before = await readDangerHoverColors(deletion);
        const ordinaryColor = ordinaryToken === '--el-text-color-regular' ? before.regular : before.primary;
        expect(ordinaryColor).not.toBeNull();
        expect(ordinaryColor).not.toBe(before.dangerHover);
        try
        {
            // Test-local fault injection into the real public Button; no production palette change.
            await deletion.evaluate((element: HTMLElement, token: string) =>
                element.style.setProperty('--el-button-hover-link-text-color', `var(${token})`), ordinaryToken);
            await expect.poll(async () =>
            {
                const colors = await readDangerHoverColors(deletion);
                return { actual: colors.actual, binding: colors.binding };
            }).toEqual({ actual: ordinaryColor, binding: ordinaryColor });
            const corrupted = await readDangerHoverColors(deletion);
            // The former self-referential oracle would accept this real rendered wrong color.
            expect(corrupted.actual).toBe(corrupted.binding);
            expect(corrupted.dangerBase).toBe(before.dangerBase);
            expect(corrupted.dangerHover).toBe(before.dangerHover);
            expect(dangerHoverViolations(corrupted)).toEqual([
                'hover-binding-is-not-danger', 'rendered-hover-is-not-danger'
            ]);
            expect(() => assertDangerHover(corrupted)).toThrow();
            await testInfo.attach('rejected-wrong-hover-token', {
                contentType: 'application/json',
                body: JSON.stringify({ ordinaryToken, before, corrupted, violations: dangerHoverViolations(corrupted) })
            });
        }
        finally
        {
            await deletion.evaluate((element: HTMLElement) => element.style.removeProperty('--el-button-hover-link-text-color'));
        }
        await expectDangerHover(deletion);
    });
}
