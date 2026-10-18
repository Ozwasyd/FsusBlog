import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
const fixture = `/@fs${fileURLToPath(new URL('../../fixtures/authoring-primary-admission/index.html', import.meta.url))}`;
for (const canonical of [false, true])
{
    test(`actual private primary handoff preserves original Anchor, canonical=${canonical}`, async ({ page }, testInfo) =>
    {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${fixture}?canonical=${canonical ? 1 : 0}`);
        await expect(page).toHaveTitle('Original primary retained admission');
        await expect(page.locator('textarea')).toBeVisible();
        const result = await page.evaluate(() => Reflect.get(window, 'runPrimaryAdmission')('adopt'));
        expect(result).toMatchObject({ sameAnchor: true, sameAdapter: true, current: true, aborted: false, mapAvailable: true });
        expect(result.documentId).toBe(result.targetDocumentId);
        expect(result.documentSession).not.toBe(result.registrySession);
        expect(result.pendingAborted).toBe(canonical);
        if (canonical) expect(result.documentId).not.toBe(result.previousDocumentId);
        const edited = await page.evaluate(() => Reflect.get(window, 'runPrimaryAdmission')('dispatch'));
        expect(edited).toMatchObject({ current: true, sourceRevision: 1, registrySource: 'source-revision:0', mapAvailable: true });
        await expect(page.locator('textarea')).toHaveValue(/^!# Original loaded primary/u);
        await expect(page.locator('vite-error-overlay')).toHaveCount(0);
        expect(errors).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`primary-${canonical}.png`) });
    });
}
for (const action of ['release', 'unmount', 'scope'])
{
    test(`actual primary handoff ${action} revokes the mount and retains real pending custody`, async ({ page }) =>
    {
        await page.goto(fixture);
        await expect(page.locator('textarea')).toBeVisible();
        const result = await page.evaluate(action => Reflect.get(window, 'runPrimaryAdmission')(action), action);
        expect(result).toMatchObject({ current: false, aborted: true, mapAvailable: false, retainedPending: true });
        expect(result.pendingAborted).toBe(action === 'scope');
    });
}
test('out-of-order original Registry observation refuses private primary admission', async ({ page }) =>
{
    await page.goto(fixture);
    await expect(page.locator('textarea')).toBeVisible();
    const result = await page.evaluate(() => Reflect.get(window, 'runPrimaryAdmission')('stale'));
    expect(result).toMatchObject({ adopted: false });
    expect(result.error).toContain('entry-changed');
});
