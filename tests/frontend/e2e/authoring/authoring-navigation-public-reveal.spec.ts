import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const fixture = `/@fs${fileURLToPath(new URL('../../fixtures/authoring-navigation/index.html', import.meta.url))}`;
for (const [action, width] of [['exact', 1280], ['exact', 390], ['rebased', 1280], ['anchorless', 1280]] as const)
{
    test(`original retained navigation ${action} completes through public reveal at ${width}`, async ({ page }, testInfo) =>
    {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(fixture);
        await expect(page).toHaveTitle('Original authoring navigation integration');
        await expect(page.locator('#ready')).toHaveText('ready');
        await page.evaluate(() => document.fonts.ready);
        const result = await page.evaluate(action => Reflect.get(window, 'runNavigation')(action), action);
        expect(result.receipt.status, result.receipt.reason).toBe('completed');
        expect(result.after.entries).toHaveLength(1);
        expect(result.after.cursor).toBe(0);
        expect(result.echoes).toBe(1);
        expect(result.documentSession).not.toBe(result.registrySession);
        if (action !== 'anchorless')
        {
            expect(result.receipt.anchor.kind).toBe(action === 'rebased' ? 'rebased' : 'exact');
            const selection = await page.locator('textarea').evaluate((element: HTMLTextAreaElement) => ({
                start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection,
                text: element.value.slice(element.selectionStart, element.selectionEnd), scroll: element.scrollTop
            }));
            expect(selection).toMatchObject({ ...result.receipt.anchor.range, direction: 'backward', text: 'Paragraph 60' });
            expect(selection.scroll).toBeGreaterThan(0);
        }
        await expect(page.locator('textarea')).toBeFocused();
        await expect(page.locator('vite-error-overlay')).toHaveCount(0);
        expect(errors).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`${action}-${width}.png`) });
    });
}

for (const action of ['partial', 'cancel', 'retire', 'unmount', 'epoch', 'same-id-remount', 'source', 'focus-fail',
    'cancel-after-focus', 'retire-after-focus', 'route-source', 'route-retire', 'back-cancel', 'back-focus-fail'])
{
    test(`original native ${action} cannot append or advance navigation`, async ({ page }) =>
    {
        await page.goto(fixture);
        await expect(page.locator('#ready')).toHaveText('ready');
        await page.evaluate(() => document.fonts.ready);
        const result = await page.evaluate(action => Reflect.get(window, 'runNavigation')(action), action);
        expect(result.receipt.status).not.toBe('completed');
        expect(result.after.cursor).toBe(result.before.cursor);
        expect(result.after.entries).toHaveLength(result.before.entries.length);
        if (action === 'partial') expect(result.receipt.anchor.kind).toBe('partial');
        if (action.includes('focus-fail')) expect(result.receipt.reason).toContain('focus-lost');
        if (action === 'route-source') expect(result.sourceRevision).toBe(1);
    });
}

test('a newer actual intent supersedes the old request and route echo records once', async ({ page }) =>
{
    await page.goto(fixture);
    await expect(page.locator('#ready')).toHaveText('ready');
    await page.evaluate(() => document.fonts.ready);
    const result = await page.evaluate(() => Reflect.get(window, 'runNavigation')('newer'));
    expect(result.old.status).not.toBe('completed');
    expect(result.latest.status, result.latest.reason).toBe('completed');
    expect(result.after.entries).toHaveLength(1);
    expect(result.echoes).toBe(1);
});

// UI1060 review #6247223727: keep this real failure visible until the owning UI successor is fixed and re-reviewed.
test('partial opaque occlusion must refuse full visibility and navigation commit', async ({ page }, testInfo) =>
{
    await page.goto(fixture);
    await expect(page.locator('#ready')).toHaveText('ready');
    await page.evaluate(() => document.fonts.ready);
    const result = await page.evaluate(() => Reflect.get(window, 'runNavigation')('partial-overlay'));
    expect(result.overlayHit).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('ui1060-partial-occlusion.png') });
    expect(result.receipt.status, 'UI1060 P1: full visibility is not qualified').not.toBe('completed');
    expect(result.after.cursor).toBe(result.before.cursor);
});
