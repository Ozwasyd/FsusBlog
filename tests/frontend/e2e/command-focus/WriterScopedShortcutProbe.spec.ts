import { expect, test, type Locator, type Page } from '@playwright/test';

const diagnostics = new Map<string, string[]>();
type ShortcutOptions = Pick<KeyboardEventInit, 'key' | 'code' | 'ctrlKey' | 'metaKey' |
    'altKey' | 'shiftKey' | 'isComposing' | 'keyCode' | 'repeat'>;

async function mountWriter(page: Page): Promise<Locator>
{
    await page.route('http://127.0.0.1:4317/api/**', route => route.abort('failed'));
    await page.goto('/__writer-command-focus-regression');
    await expect(page).toHaveTitle('Writer command focus integration');
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    const body = page.getByRole('region', { name: '正文', exact: true }).getByRole('textbox');
    await expect(body).toBeVisible();
    await body.fill('Scoped shortcut body remains unsaved');
    await body.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(3, 12, 'backward'));
    return body;
}

async function key(target: Locator, options: ShortcutOptions, handled = false)
{
    return target.evaluate((element, input) =>
    {
        const event = new KeyboardEvent('keydown', {
            key: 'p', ctrlKey: true, bubbles: true, cancelable: true, ...input.options
        });
        if (input.handled) event.preventDefault();
        // A temporary observer belongs to this local surface ancestor, never
        // document/window. It records whether the owner stops propagation.
        const surface = element.closest('[role="dialog"]') ?? element.closest('main');
        const observer = surface?.parentElement ?? element.parentElement;
        if (!observer || observer === document.body || observer === document.documentElement)
        {
            throw new Error('Shortcut observation requires a local surface ancestor.');
        }
        let propagated = false;
        const observe = (): void => { propagated = true; };
        observer.addEventListener('keydown', observe);
        try
        {
            element.dispatchEvent(event);
            return { prevented: event.defaultPrevented, propagated };
        }
        finally
        {
            observer.removeEventListener('keydown', observe);
        }
    }, { options, handled });
}

test.beforeEach(async ({ page }, info) =>
{
    const messages: string[] = [];
    diagnostics.set(info.testId, messages);
    page.on('console', message =>
    {
        if (['error', 'warning'].includes(message.type())) messages.push(`${message.type()}: ${message.text()}`);
    });
    page.on('pageerror', error => messages.push(`pageerror: ${error.stack ?? error.message}`));
});

test.afterEach(async ({ page }, info) =>
{
    await info.attach('console-and-runtime.txt', {
        body: (diagnostics.get(info.testId) ?? []).join('\n'), contentType: 'text/plain'
    });
    diagnostics.delete(info.testId);
    await info.attach('accessibility-tree.txt', {
        body: await page.locator('body').ariaSnapshot(), contentType: 'text/plain'
    });
    await info.attach('rendered-page.png', { body: await page.screenshot(), contentType: 'image/png' });
});

test('valid host repeats are claimed without opening or replacing the selected editor', async ({ page }) =>
{
    const body = await mountWriter(page);
    const original = await body.elementHandle();
    for (const options of [{ ctrlKey: true, metaKey: false }, { ctrlKey: false, metaKey: true }])
    {
        expect(await key(body, { ...options, repeat: true })).toEqual({ prevented: true, propagated: false });
        await expect(page.getByRole('dialog', { name: '命令面板' })).toHaveCount(0);
    }
    await expect(body).toBeFocused();
    await expect(body).toHaveCount(1);
    expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    expect(await body.evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart, element.selectionEnd, element.selectionDirection
    ])).toEqual([3, 12, 'backward']);
    await expect(body).toHaveValue('Scoped shortcut body remains unsaved');
});

test('active teleported palette owns Mod+P and repeats without resetting query or editor', async ({ page }) =>
{
    const body = await mountWriter(page);
    const original = await body.elementHandle();
    await body.press('Control+p');
    const palette = page.getByRole('dialog', { name: '命令面板' });
    const search = palette.getByRole('combobox');
    const originalSearch = await search.elementHandle();
    await search.fill('检查');
    for (const options of [
        { ctrlKey: true, metaKey: false, repeat: false },
        { ctrlKey: true, metaKey: false, repeat: true },
        { ctrlKey: false, metaKey: true, repeat: false },
        { ctrlKey: false, metaKey: true, repeat: true }
    ])
    {
        expect(await key(search, options)).toEqual({ prevented: true, propagated: false });
        await expect(palette).toHaveCount(1);
        await expect(search).toHaveValue('检查');
        await expect(search).toBeFocused();
        expect(await originalSearch!.evaluate(element => element.isConnected)).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await expect(body).toBeFocused();
    expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    expect(await body.evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart, element.selectionEnd, element.selectionDirection
    ])).toEqual([3, 12, 'backward']);
    await expect(body).toHaveValue('Scoped shortcut body remains unsaved');
});

test('flagged composition and unrelated keys remain unclaimed on host and palette', async ({ page }) =>
{
    const body = await mountWriter(page);
    const exclusions: ShortcutOptions[] = [
        { isComposing: true }, { keyCode: 229 }, { isComposing: true, repeat: true },
        { keyCode: 229, repeat: true }, { altKey: true }, { shiftKey: true },
        { metaKey: true }, { ctrlKey: false }, { key: 'o' }
    ];
    for (const options of exclusions)
    {
        expect(await key(body, options)).toEqual({ prevented: false, propagated: true });
        await expect(page.getByRole('dialog', { name: '命令面板' })).toHaveCount(0);
    }
    expect(await key(body, {}, true)).toEqual({ prevented: true, propagated: true });
    await body.press('Control+p');
    const palette = page.getByRole('dialog', { name: '命令面板' });
    const search = palette.getByRole('combobox');
    await search.fill('检查');
    for (const options of exclusions)
    {
        expect(await key(search, options)).toEqual({ prevented: false, propagated: true });
        await expect(search).toHaveValue('检查');
    }
    expect(await key(search, {}, true)).toEqual({ prevented: true, propagated: true });
    await expect(palette).toHaveCount(1);
    await expect(page.locator('[data-inspector-view][aria-hidden="false"]')).toHaveCount(0);
    await expect(body).toHaveValue('Scoped shortcut body remains unsaved');
});

test('active editor composition leaves an unflagged repeated host shortcut native', async ({ page }) =>
{
    const body = await mountWriter(page);
    await body.dispatchEvent('compositionstart', { data: '中' });
    expect.soft(await key(body, { repeat: true })).toEqual({ prevented: false, propagated: true });
    await expect(page.getByRole('dialog', { name: '命令面板' })).toHaveCount(0);
    await body.dispatchEvent('compositionend', { data: '中' });
    expect(await key(body, { repeat: true })).toEqual({ prevented: true, propagated: false });
    await expect(body).toHaveValue('Scoped shortcut body remains unsaved');
});

test('dirty modal disables host admission and unrelated targets stay outside the owner', async ({ page }) =>
{
    const body = await mountWriter(page);
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '离开编辑器', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '文章检查器', exact: true })).toBeDisabled();
    for (const repeat of [false, true])
    {
        expect(await key(body, { repeat })).toEqual({ prevented: false, propagated: true });
    }
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await page.evaluate(() =>
    {
        const fixture = document.getElementById('writer-command-focus-regression');
        if (!fixture) throw new Error('Actual Writer fixture host missing.');
        const button = document.createElement('button');
        button.setAttribute('aria-label', 'Shortcut outside Writer');
        fixture.appendChild(button);
    });
    const unrelated = page.getByRole('button', { name: 'Shortcut outside Writer', exact: true });
    for (const repeat of [false, true])
    {
        expect(await key(unrelated, { repeat })).toEqual({ prevented: false, propagated: true });
    }
    await expect(page.getByRole('dialog', { name: '命令面板' })).toHaveCount(0);
    await expect(body).toHaveValue('Scoped shortcut body remains unsaved');
});

test('retired teleported palette does not retain ownership after real Writer unmount', async ({ page }) =>
{
    const body = await mountWriter(page);
    await body.press('Control+p');
    const search = page.getByRole('dialog', { name: '命令面板' }).getByRole('combobox');
    const retired = await search.elementHandle();
    await page.evaluate(() => (window as unknown as {
        writerCommandFocusFixture: { unmount: () => void; }
    }).writerCommandFocusFixture.unmount());
    await expect(page.locator('main')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '命令面板' })).toHaveCount(0);
    expect(await retired!.evaluate(element =>
    {
        const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, repeat: true, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    })).toBe(false);
});
