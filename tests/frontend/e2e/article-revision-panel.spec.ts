import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const fixtureModule = `/@fs/${fileURLToPath(new URL('../fixtures/articleRevisionPanelVisual.ts', import.meta.url)).replaceAll('\\', '/')}`;

async function openPanel(page: Page): Promise<void>
{
    await page.route('**/__revision-panel-fixture', (route) => route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <title>修订历史真实组件验收</title>
            <style>#revision-panel-fixture { max-width: 720px; margin: 0 auto; }</style>
            </head><body><main id="revision-panel-fixture"></main>
            <script type="module">
                import { mountArticleRevisionPanelFixture } from ${JSON.stringify(fixtureModule)};
                mountArticleRevisionPanelFixture();
            </script></body></html>`
    }));
    await page.goto('/__revision-panel-fixture');
    await expect(page.locator('button.revision-row')).toHaveCount(2);
    await expect(page).toHaveTitle('修订历史真实组件验收');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
}

test('revision rows retain keyboard activation, busy suppression and rollback controls', async ({ page }) =>
{
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openPanel(page);
    const rows = page.locator('button.revision-row');

    await page.getByRole('button', { name: '刷新修订历史' }).focus();
    await page.keyboard.press('Tab');
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(rows.first()).toHaveAttribute('aria-current', 'true');
    await expect(rows.last()).not.toHaveAttribute('aria-current', 'true');

    for (const busy of ['loading', 'rollbacking'] as const)
    {
        await page.evaluate((key) => { window.revisionPanelFixture.state[key] = true; }, busy);
        await expect(rows.first()).toBeDisabled();
        await expect(rows.last()).toBeDisabled();
        await rows.last().evaluate((button: HTMLButtonElement) => button.click());
        expect(await page.evaluate(() => window.revisionPanelFixture.events)).toEqual([{ event: 'select', id: 'revision-3' }]);
        await page.evaluate((key) => { window.revisionPanelFixture.state[key] = false; }, busy);
    }

    await page.getByRole('button', { name: '刷新修订历史' }).click();
    const rollback = page.getByRole('button', { name: '从此版本创建新版本' });
    await page.locator('textarea').fill('太短');
    await expect(rollback).toBeDisabled();
    await page.locator('textarea').fill('  恢复此前经过确认的完整历史版本  ');
    await expect(rollback).toBeEnabled();
    await rollback.click();
    expect(await page.evaluate(() => window.revisionPanelFixture.events)).toEqual([
        { event: 'select', id: 'revision-3' }, { event: 'refresh' },
        { event: 'rollback', targetStatus: 2, reason: '恢复此前经过确认的完整历史版本' }
    ]);
    await rows.last().focus();
    await page.keyboard.press('Space');
    await expect(rows.last()).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('textarea')).toHaveValue('');
    await expect(rollback).toBeDisabled();
    expect(errors).toEqual([]);
});

for (const theme of ['light', 'dark'] as const)
{
    test(`revision rows preserve long content inside the button at narrow widths and 200% zoom (${theme})`, async ({ page }) =>
    {
        await openPanel(page);
        await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
        for (const width of [320, 375])
        {
            await page.setViewportSize({ width, height: 900 });
            for (const zoom of [1, 2])
            {
                await page.evaluate((value) => { document.documentElement.style.zoom = String(value); }, zoom);
                const bounds = await page.locator('button.revision-row').first().evaluate((button) =>
                {
                    const row = button.getBoundingClientRect();
                    const actor = button.querySelector('.revision-row__actor')!.getBoundingClientRect();
                    const title = button.querySelector('.revision-row__title')!.getBoundingClientRect();
                    return { rowRight: row.right, actorRight: actor.right, titleWidth: title.width };
                });
                expect(bounds.titleWidth, `${width}px ${zoom * 100}% title remains visible`).toBeGreaterThan(0);
                expect(bounds.actorRight, `${width}px ${zoom * 100}% actor stays inside its button`).toBeLessThanOrEqual(bounds.rowRight);
                await expect(page.locator('.revision-row__actor').first()).toHaveText('Admin #9223372036854775807');
                await page.screenshot({ path: test.info().outputPath(`${theme}-${width}-zoom-${zoom}.png`), animations: 'disabled', fullPage: true });
            }
        }
    });
}
