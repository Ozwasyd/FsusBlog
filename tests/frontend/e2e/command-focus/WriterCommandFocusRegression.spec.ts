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
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
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
    await testInfo.attach('focus-and-selection.json', {
        body: JSON.stringify(await page.evaluate(() =>
        {
            const focused = document.activeElement;
            const body = document.querySelector<HTMLTextAreaElement>('#article-content');
            return {
                url: window.location.href,
                focused: focused ? {
                    tag: focused.tagName, id: focused.id,
                    role: focused.getAttribute('role'),
                    label: focused.getAttribute('aria-label'), text: focused.textContent?.trim()
                } : null,
                body: body ? {
                    value: body.value, start: body.selectionStart, end: body.selectionEnd,
                    direction: body.selectionDirection, focused: focused === body
                } : null
            };
        }), null, 2), contentType: 'application/json'
    });
    await testInfo.attach('rendered-page.png', {
        body: await page.screenshot(), contentType: 'image/png'
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
    await expect.soft(body).toBeFocused();
    expect(await body.evaluate((element: HTMLTextAreaElement) => ({
        start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection
    }))).toEqual({ start: 18, end: 30, direction: 'backward' });
    await expect(body).toHaveValue('# Integration\n\nUnsaved body selection remains here.');
});

test('repeated shortcut and pointer entry closes with Escape without replacing the dirty editor', async ({ page }) =>
{
    await mountWriter(page);
    const body = page.getByRole('region', { name: '正文', exact: true }).getByRole('textbox');
    const content = 'Unconfirmed text 中文 é 🧭\nsecond line';
    await body.fill(content);
    const original = await body.elementHandle();
    const entry = page.getByRole('button', { name: '文章检查器', exact: true });
    for (const entrypoint of ['shortcut', 'pointer', 'shortcut'])
    {
        await body.focus();
        await body.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(4, 13, 'backward'));
        if (entrypoint === 'pointer') await entry.click();
        else await body.press('Control+p');
        const palette = page.getByRole('dialog', { name: '命令面板' });
        await expect(palette).toHaveCount(1);
        await expect(palette.getByRole('combobox')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(palette).toHaveCount(0);
        await expect(body).toBeFocused();
        expect(await body.evaluate((element: HTMLTextAreaElement) => [
            element.selectionStart, element.selectionEnd, element.selectionDirection
        ])).toEqual([4, 13, 'backward']);
        await expect(body).toHaveValue(content);
        expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    }
});

test('body composition and repeated keydown cannot open the palette before composition ends', async ({ page }) =>
{
    await mountWriter(page);
    const body = page.getByRole('region', { name: '正文', exact: true }).getByRole('textbox');
    await body.fill('中文 composition remains unsaved');
    await body.dispatchEvent('compositionstart', { data: '中' });
    const prevented = await body.evaluate(element => [
        { key: 'p', ctrlKey: true, isComposing: true },
        { key: 'p', ctrlKey: true, keyCode: 229 },
        { key: 'p', ctrlKey: true, repeat: true }
    ].map(options =>
    {
        const event = new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    }));
    expect(prevented).toEqual([false, false, false]);
    await expect(page.getByRole('dialog', { name: '命令面板' })).toHaveCount(0);
    await body.dispatchEvent('compositionend', { data: '中文' });
    const repeatClaimed = await body.evaluate(element =>
    {
        const event = new KeyboardEvent('keydown', {
            key: 'p', ctrlKey: true, repeat: true, bubbles: true, cancelable: true
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    });
    expect(repeatClaimed).toBe(false);
    await expect(page.getByRole('dialog', { name: '命令面板' })).toHaveCount(0);
    await body.press('Control+p');
    await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(body).toHaveValue('中文 composition remains unsaved');
});

test('composing Enter in palette search cannot launch an inspector command', async ({ page }) =>
{
    await mountWriter(page);
    const body = page.getByRole('region', { name: '正文', exact: true }).getByRole('textbox');
    await body.fill('IME command boundary');
    await body.press('Control+p');
    const palette = page.getByRole('dialog', { name: '命令面板' });
    const search = palette.getByRole('combobox');
    await search.fill('检查');
    await expect(palette.getByRole('option')).toHaveCount(1);
    await search.dispatchEvent('compositionstart', { data: '查' });
    await search.dispatchEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true
    });
    await expect.soft(palette).toBeVisible();
    await expect.soft(page.locator('[data-inspector-view="check"][aria-hidden="false"]')).toHaveCount(0);
    await expect(body).toHaveValue('IME command boundary');
});

test('revoked permission disables current palette commands without changing the unsaved body', async ({ page }) =>
{
    await mountWriter(page);
    const body = page.getByRole('region', { name: '正文', exact: true }).getByRole('textbox');
    await body.fill('Permission boundary pending body');
    await body.press('Control+p');
    const palette = page.getByRole('dialog', { name: '命令面板' });
    const search = palette.getByRole('combobox');
    await search.fill('检查');
    const option = palette.getByRole('option');
    await expect(option).toBeEnabled();
    await page.evaluate(() => (window as unknown as {
        writerCommandFocusFixture: { revokePermission: () => void; }
    }).writerCommandFocusFixture.revokePermission());
    await expect(option).toBeDisabled();
    await search.press('Enter');
    await expect(palette).toBeVisible();
    await expect(page.locator('[data-inspector-view][aria-hidden="false"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(body).toHaveValue('Permission boundary pending body');
});

test('dirty leave confirmation gates palette entry and cancellation retains the real editor', async ({ page }) =>
{
    await mountWriter(page);
    const body = page.getByRole('region', { name: '正文', exact: true }).getByRole('textbox');
    await body.fill('Dirty body cannot be discarded by tool navigation');
    const original = await body.elementHandle();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    const leave = page.getByRole('dialog', { name: '离开编辑器', exact: true });
    await expect(leave).toBeVisible();
    await expect(page.getByRole('button', { name: '文章检查器', exact: true })).toBeDisabled();
    const claimed = await body.evaluate(element =>
    {
        const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    });
    expect(claimed).toBe(false);
    await expect(page.getByRole('dialog', { name: '命令面板' })).toHaveCount(0);
    await leave.getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(leave).toBeHidden();
    await expect(body).toHaveValue('Dirty body cannot be discarded by tool navigation');
    expect(await original!.evaluate(element => element.isConnected)).toBe(true);
});

test('source compare transitions retain one editor, backward selection and palette focus restoration', async ({ page }) =>
{
    await mountWriter(page);
    const body = page.getByRole('region', { name: '正文', exact: true }).getByRole('textbox');
    const content = 'Paragraph before tool.\n\nAnother paragraph after tool.';
    await body.fill(content);
    await body.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(3, 12, 'backward'));
    const original = await body.elementHandle();
    const compare = page.getByRole('button', { name: '源码对照', exact: true });
    for (const opened of [true, false])
    {
        await compare.click();
        await expect(compare).toHaveAttribute('aria-pressed', String(opened));
        await expect(body).toHaveCount(1);
        expect(await original!.evaluate(element => element.isConnected)).toBe(true);
        await body.focus();
        await body.press('Control+p');
        await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(body).toBeFocused();
        expect(await body.evaluate((element: HTMLTextAreaElement) => [
            element.selectionStart, element.selectionEnd, element.selectionDirection
        ])).toEqual([3, 12, 'backward']);
        await expect(body).toHaveValue(content);
    }
});

test('palette focus trap and active-descendant identity remain valid before inspector handoff', async ({ page }) =>
{
    await mountWriter(page);
    await page.getByRole('region', { name: '正文', exact: true }).getByRole('textbox').press('Control+p');
    const palette = page.getByRole('dialog', { name: '命令面板' });
    await expect(palette).toHaveAttribute('aria-modal', 'true');
    const search = palette.getByRole('combobox');
    await search.fill('检查');
    const active = await search.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    await expect(palette.getByRole('option')).toHaveAttribute('id', active!);
    await expect(palette.getByRole('option')).toHaveAttribute('aria-selected', 'true');
    await search.press('Shift+Tab');
    await expect(palette.getByRole('option')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(search).toBeFocused();
    await search.press('Enter');
    const inspector = page.locator('[data-inspector-view="check"][aria-hidden="false"]');
    await expect(inspector).toBeVisible();
    await expect.poll(() => inspector.evaluate(element => element.contains(document.activeElement))).toBe(true);
});

test('Escape closes the palette alone while a rail-opened inspector remains active', async ({ page }) =>
{
    await mountWriter(page);
    const body = page.getByRole('region', { name: '正文', exact: true }).getByRole('textbox');
    await body.fill('Two overlays preserve the same dirty document');
    const rail = page.getByRole('navigation', { name: '文章检查器', exact: true });
    const check = rail.getByRole('button', { name: '检查', exact: true });
    await check.click();
    const inspector = page.locator('[data-inspector-view="check"][aria-hidden="false"]');
    await expect(inspector).toBeVisible();
    await body.press('Control+p');
    const palette = page.getByRole('dialog', { name: '命令面板' });
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    await expect(inspector).toBeVisible();
    await expect(body).toBeFocused();
    await inspector.focus();
    await page.keyboard.press('Escape');
    await expect(inspector).toBeHidden();
    await expect(check).toBeFocused();
    await expect(body).toHaveValue('Two overlays preserve the same dirty document');
});

test.describe('touch input on the composed Writer', () =>
{
    test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, colorScheme: 'dark' });
    test('visible palette entry and touch inspector command remain reachable in the modal host', async ({ page }) =>
    {
        await mountWriter(page);
        await page.evaluate(() => document.documentElement.classList.add('dark'));
        const body = page.getByRole('region', { name: '正文', exact: true }).getByRole('textbox');
        await body.fill('Touch unsaved editor body');
        await body.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(3, 12, 'backward'));
        await page.getByRole('button', { name: '文章检查器', exact: true }).tap({ timeout: 10_000 });
        const palette = page.getByRole('dialog', { name: '命令面板' });
        await palette.getByRole('combobox').fill('检查');
        await palette.getByRole('option').tap();
        await expect(palette).toBeHidden();
        const inspector = page.getByRole('dialog', { name: '检查', exact: true });
        await expect(inspector).toBeVisible();
        await expect(inspector).toHaveAttribute('aria-modal', 'true');
        await page.keyboard.press('Escape');
        await expect(inspector).toBeHidden();
        await expect.soft(body).toBeFocused();
        expect(await body.evaluate((element: HTMLTextAreaElement) => [
            element.selectionStart, element.selectionEnd, element.selectionDirection
        ])).toEqual([3, 12, 'backward']);
        await expect(body).toHaveValue('Touch unsaved editor body');
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    });
});
