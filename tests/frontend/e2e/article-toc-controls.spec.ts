import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

const fixtureModule = `/@fs/${fileURLToPath(new URL('../fixtures/articleTocControlsVisual.ts', import.meta.url))}`;
const visualStates: Array<{ theme: 'light' | 'dark'; reducedMotion: 'no-preference' | 'reduce' }> = [
    { theme: 'light', reducedMotion: 'no-preference' },
    { theme: 'dark', reducedMotion: 'no-preference' },
    { theme: 'light', reducedMotion: 'reduce' },
    { theme: 'dark', reducedMotion: 'reduce' }
];

async function readingFeedback(button: Locator)
{
    return button.evaluate(async (element: HTMLButtonElement) =>
    {
        await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
        const probe = document.createElement('span');
        probe.style.position = 'fixed';
        probe.style.color = 'var(--fsusblog-color-primary)';
        probe.style.transitionDuration = 'var(--blog-motion-fast)';
        probe.style.transitionTimingFunction = 'var(--blog-motion-ease)';
        document.body.append(probe);
        const primaryColor = getComputedStyle(probe).color;
        const fastDuration = getComputedStyle(probe).transitionDuration;
        const easing = getComputedStyle(probe).transitionTimingFunction;
        probe.style.color = 'var(--fsusblog-color-focus-ring)';
        const focusColor = getComputedStyle(probe).color;
        probe.remove();
        const style = getComputedStyle(element);
        const marker = getComputedStyle(element, '::after');
        return {
            properties: style.transitionProperty,
            duration: style.transitionDuration,
            easing: style.transitionTimingFunction,
            focusVisible: element.matches(':focus-visible'),
            shadow: style.boxShadow,
            transform: style.transform,
            markerWidth: marker.borderLeftWidth,
            markerStyle: marker.borderLeftStyle,
            markerColor: marker.borderLeftColor,
            markerProperties: marker.transitionProperty,
            markerDuration: marker.transitionDuration,
            markerEasing: marker.transitionTimingFunction,
            markerContent: marker.content,
            primaryColor,
            focusColor,
            fastDuration,
            expectedEasing: easing
        };
    });
}

function expectReadingFeedback(
    feedback: Awaited<ReturnType<typeof readingFeedback>>,
    reducedMotion: 'no-preference' | 'reduce',
    keyboardFocus = true
): void
{
    if (reducedMotion === 'reduce')
    {
        expect(feedback.properties).toBe('none');
        expect(feedback.duration).toBe('0s');
    }
    else
    {
        expect(feedback.properties).toBe('background-color, border-color, color, opacity');
        expect(feedback.duration).toBe(Array(4).fill(feedback.fastDuration).join(', '));
        expect(feedback.easing).toBe(Array(4).fill(feedback.expectedEasing).join(', '));
    }
    expect(feedback.transform).toBe('none');
    expect(feedback.markerWidth).toBe('2px');
    expect(feedback.markerStyle).toBe('solid');
    expect(feedback.markerColor).toBe(feedback.primaryColor);
    expect(feedback.markerDuration).toBe(feedback.duration);
    expect(feedback.markerProperties).toBe(feedback.properties);
    expect(feedback.markerEasing).toBe(feedback.easing);
    expect(feedback.markerContent).toBe('""');
    if (keyboardFocus)
    {
        expect(feedback.focusVisible).toBe(true);
        expect(feedback.shadow).toBe(`${feedback.focusColor} 0px 0px 0px 2px inset`);
    }
}

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
        expectReadingFeedback(await readingFeedback(buttons.nth(1)), reducedMotion);
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

for (const { theme, reducedMotion } of visualStates)
{
    test(`visible marker ${theme} ${reducedMotion} retains its color transition through hover and idle`, async ({ page }: { page: Page }) =>
    {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.emulateMedia({ reducedMotion });
        const errors = await openFixture(page, theme);
        const button = page.locator('.article-toc-panel__nav button').nth(2);
        const idle = await button.evaluate((element: HTMLButtonElement) =>
        {
            const marker = getComputedStyle(element, '::after');
            const initial = { content: marker.content, color: marker.borderLeftColor };
            const records: Array<{ type: string; elapsed: number; duration?: number; start?: string; middle?: string }> = [];
            element.dataset.markerTransitions = JSON.stringify(records);
            const record = (event: TransitionEvent): void =>
            {
                if (event.pseudoElement !== '::after' || event.propertyName !== 'border-left-color') return;
                const entry: typeof records[number] = { type: event.type, elapsed: event.elapsedTime };
                if (event.type === 'transitionrun')
                {
                    const animation = element.getAnimations({ subtree: true }).find((candidate) =>
                        candidate instanceof CSSTransition && candidate.transitionProperty === 'border-left-color'
                        && candidate.effect instanceof KeyframeEffect && candidate.effect.pseudoElement === '::after');
                    if (animation?.effect instanceof KeyframeEffect)
                    {
                        const duration = Number(animation.effect.getComputedTiming().duration);
                        animation.pause();
                        animation.currentTime = 0;
                        entry.start = getComputedStyle(element, '::after').borderLeftColor;
                        animation.currentTime = duration / 2;
                        entry.middle = getComputedStyle(element, '::after').borderLeftColor;
                        entry.duration = duration;
                        animation.currentTime = 0;
                        animation.play();
                    }
                }
                records.push(entry);
                element.dataset.markerTransitions = JSON.stringify(records);
            };
            element.addEventListener('transitionrun', record);
            element.addEventListener('transitionend', record);
            return initial;
        });
        await button.hover();
        const feedback = await readingFeedback(button);
        await test.info().attach('visible-marker-feedback', {
            body: JSON.stringify({ idle, feedback }, null, 2),
            contentType: 'application/json'
        });
        expectReadingFeedback(feedback, reducedMotion, false);
        expect(idle.content).toBe('""');
        expect(idle.color).toBe('rgba(0, 0, 0, 0)');
        await page.mouse.move(0, 0);
        await button.evaluate(async (element: HTMLButtonElement) =>
            Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
        const finalMarker = await button.evaluate((element: HTMLButtonElement) =>
        {
            const marker = getComputedStyle(element, '::after');
            return { content: marker.content, color: marker.borderLeftColor };
        });
        expect(finalMarker).toEqual(idle);
        if (reducedMotion === 'reduce')
        {
            await expect(button).toHaveAttribute('data-marker-transitions', '[]');
        }
        else
        {
            await expect.poll(async () => JSON.parse(await button.getAttribute('data-marker-transitions') ?? '[]').length).toBe(4);
            const records: Array<{ type: string; elapsed: number; duration?: number; start?: string; middle?: string }> =
                JSON.parse(await button.getAttribute('data-marker-transitions') ?? '[]');
            const seconds = Number.parseFloat(feedback.fastDuration);
            expect(records.map((entry) => entry.type)).toEqual(['transitionrun', 'transitionend', 'transitionrun', 'transitionend']);
            for (const entry of records.filter((event) => event.type === 'transitionrun'))
            {
                expect(entry.duration).toBe(seconds * 1000);
                expect(entry.middle).not.toBe(entry.start);
                expect(entry.middle).not.toBe(feedback.primaryColor);
                expect(entry.middle).not.toBe(idle.color);
            }
            expect(records.filter((entry) => entry.type === 'transitionend').map((entry) => entry.elapsed)).toEqual([seconds, seconds]);
        }
        expect(errors).toEqual([]);
    });
}

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
            expectReadingFeedback(await readingFeedback(buttons.nth(1)), reducedMotion, false);
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

for (const mutation of ['motion-class', 'chapter-marker', 'focus-ring'])
{
    test(`reading feedback rejects the ${mutation} negative control`, async ({ page }: { page: Page }) =>
    {
        await page.setViewportSize({ width: 1440, height: 900 });
        const errors = await openFixture(page, 'light');
        const buttons = page.locator('.article-toc-panel__nav button');
        await buttons.first().focus();
        await page.keyboard.press('Tab');
        const button = buttons.nth(1);
        expectReadingFeedback(await readingFeedback(button), 'no-preference');
        if (mutation === 'motion-class')
        {
            await button.evaluate((element: HTMLButtonElement) => element.classList.remove('blog-motion-reading-control'));
        }
        else if (mutation === 'chapter-marker')
        {
            await page.addStyleTag({ content: '.article-toc-panel__item::after { border-left-color: transparent !important; }' });
        }
        else
        {
            await button.evaluate((element: HTMLButtonElement) => element.style.setProperty('box-shadow', 'none', 'important'));
        }
        const corrupted = await readingFeedback(button);
        expect(() => expectReadingFeedback(corrupted, 'no-preference')).toThrow();
        expect(errors).toEqual([]);
    });
}
