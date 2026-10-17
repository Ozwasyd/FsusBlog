import { fileURLToPath } from 'node:url';

import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';

const fixtureModule = `/@fs/${fileURLToPath(new URL('../fixtures/articleCommentTreeControls.ts', import.meta.url))}`;

for (const theme of ['light', 'dark'])
{
    for (const width of [375, 1440])
    {
        test(`comment controls preserve actions, focus and geometry at ${width}px in ${theme}`, async ({ page }: { page: Page }, testInfo: TestInfo) =>
        {
            await page.setViewportSize({ width, height: 900 });
            await page.route('**/__comment-tree-controls?*', (route: Route) => route.fulfill({
                contentType: 'text/html',
                body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="comment-tree-controls"></div><script type="module" src="${fixtureModule}"></script></body></html>`
            }));
            await page.goto(`/__comment-tree-controls?theme=${theme}`);
            await expect(page.locator('html')).toHaveAttribute('data-comment-tree-controls-ready', 'true');
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
                body: JSON.stringify(await deletion.evaluate((element: HTMLElement) => ({
                    classes: element.className,
                    color: getComputedStyle(element).color,
                    danger: getComputedStyle(element).getPropertyValue('--el-color-danger'),
                    hover: getComputedStyle(element).getPropertyValue('--el-button-hover-link-text-color')
                })))
            });
            await expect.poll(() => deletion.evaluate((element: HTMLElement) => getComputedStyle(element).getPropertyValue('--el-button-hover-link-text-color').trim())).not.toBe('');
            await expect.poll(() => deletion.evaluate((element: HTMLElement) =>
            {
                const reference = document.createElement('span');
                reference.style.color = 'var(--el-button-hover-link-text-color)';
                element.append(reference);
                const expected = getComputedStyle(reference).color;
                reference.remove();
                return getComputedStyle(element).color === expected;
            })).toBe(true);
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
