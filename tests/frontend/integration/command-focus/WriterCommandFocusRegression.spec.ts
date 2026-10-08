import { expect, test, type Page } from '@playwright/test';
const consoleMessages = new Map<string, string[]>();

async function mountWriter(page: Page): Promise<void>
{
    // Deliberate unavailable backend, never a fabricated successful AEDS receipt.
    await page.route('http://127.0.0.1:4317/api/**', route => route.abort('failed'));
    await page.goto('/__writer-command-focus-regression');
    await expect(page).toHaveTitle('Writer command focus integration');
    await expect(page.locator('main[aria-labelledby="article-write-title"]')).toBeVisible();
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('region', { name: '正文', exact: true }).getByRole('textbox')).toBeVisible();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
}

test.beforeEach(async ({ page }, testInfo) =>
{
    const messages: string[] = [];
    consoleMessages.set(testInfo.testId, messages);
    page.on('console', message =>
    {
        if (['error', 'warning'].includes(message.type())) messages.push(`${message.type()}: ${message.text()}`);
    });
    page.on('pageerror', error => messages.push(`pageerror: ${error.stack ?? error.message}`));
    page.on('requestfailed', request => messages.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
});

test.afterEach(async ({ page }, testInfo) =>
{
    await testInfo.attach('console-and-runtime.txt', {
        body: (consoleMessages.get(testInfo.testId) ?? []).join('\n'), contentType: 'text/plain'
    });
    consoleMessages.delete(testInfo.testId);
    await testInfo.attach('accessibility-tree.txt', {
        body: await page.locator('body').ariaSnapshot().catch(error => String(error)),
        contentType: 'text/plain'
    });
});

test('Writer palette command hands focus to the real inspector and Escape restores body selection', async ({ page }) =>
{
    await mountWriter(page);
    const body = page.getByRole('region', { name: '正文', exact: true }).getByRole('textbox');
    await body.fill('# Integration\n\nUnsaved body selection remains here.');
    await body.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(18, 30, 'backward'));
    await body.press('Control+p');
    const palette = page.getByRole('dialog', { name: '命令面板' });
    await expect(palette).toBeVisible();
    const search = palette.getByRole('combobox');
    await expect(search).toBeFocused();
    await search.fill('检查');
    await palette.getByRole('option').filter({ hasText: '检查' }).click();
    await expect(palette).toBeHidden();
    const inspector = page.locator('[data-inspector-view="check"][aria-hidden="false"]');
    await expect(inspector).toBeVisible();
    await expect.poll(() => inspector.evaluate(element => element.contains(document.activeElement)))
        .toBe(true);
    await page.keyboard.press('Escape');
    await expect(inspector).toBeHidden();
    await expect(body).toBeFocused();
    expect(await body.evaluate((element: HTMLTextAreaElement) => ({
        start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection
    }))).toEqual({ start: 18, end: 30, direction: 'backward' });
    await expect(body).toHaveValue('# Integration\n\nUnsaved body selection remains here.');
});
