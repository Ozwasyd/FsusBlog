import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

import contract from '../fixtures/article-editor-production-contract.json' with { type: 'json' };

test.setTimeout(180_000);

const fixtureModule = `/@fs/${fileURLToPath(
    new URL('../fixtures/articleEditorProductionVisual.ts', import.meta.url)
).replaceAll('\\', '/')}`;

async function openFixture(
  page: Page,
  title: keyof typeof contract.titles,
  theme: 'light' | 'dark',
  surface: 'title' | 'editor' | 'outline' | 'command' | 'inspector' | 'recovery' = 'title',
  inspectorState: 'empty' | 'loading' | 'error' | 'success' | 'partial' = 'success',
  inspectorView?: typeof contract.inspectorViews[number],
  authoringState: typeof contract.authoringStates[number] = 'ready',
  outlineHeadingCount = 8,
  outlineArticle: 'a' | 'b' = 'a'
): Promise<void> {
  await page.route('**/__article-editor-production-fixture**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>文章编辑器 production fixture</title></head>
          <body>
            <div id="article-editor-production-fixture"></div>
            <script type="module" src="/@vite/client"></script>
            <script type="module">
              const fixtureModule = ${JSON.stringify(fixtureModule)}
              let moduleAttempt = 0
              for (let attempt = 0; attempt < 45; attempt += 1) {
                try {
                  const fixture = await Promise.race([
                    import(fixtureModule + '?fixture-attempt=' + moduleAttempt),
                    new Promise((_, reject) => window.setTimeout(
                      () => reject(new Error('fixture_import_pending')),
                      1500
                    ))
                  ])
                  await fixture.mountArticleEditorProductionFixture()
                  break
                } catch (error) {
                  document.documentElement.dataset.articleEditorFixtureBootstrapAttempt =
                    String(attempt + 1)
                  moduleAttempt += 1
                  if (attempt === 44) {
                    document.documentElement.dataset.articleEditorFixtureBootstrapError =
                      error instanceof Error ? error.message : String(error)
                    throw error
                  }
                  await new Promise((resolve) => window.setTimeout(resolve, 1500))
                }
              }
            </script>
          </body>
        </html>`
    })
  })

  const search = new URLSearchParams({
    title,
    theme,
    surface,
    state: inspectorState,
    authoring: authoringState,
    outlineCount: String(outlineHeadingCount),
    article: outlineArticle
  })
  if (inspectorView) {
    search.set('view', inspectorView)
  }
  await page.goto(`/__article-editor-production-fixture?${search}`, {
    waitUntil: 'domcontentloaded'
  })
  const waitForFixtureReady = (timeout: number) => expect.poll(() => page.evaluate(() => (
    document.documentElement.dataset.articleEditorFixtureReady
  )), {
    intervals: [100, 250, 500, 1000],
    timeout
  }).toBe('true')

  try {
    await waitForFixtureReady(70_000)
  } catch (initialError) {
    const bootstrapError = await page.evaluate(() => (
      document.documentElement.dataset.articleEditorFixtureBootstrapError
    ))
    if (bootstrapError) {
      throw new Error(`article_editor_fixture_bootstrap_failed:${bootstrapError}`, {
        cause: initialError
      })
    }

    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForFixtureReady(50_000)
  }
}


test.describe('inspector external focus lifecycle in the production fixture', () => {
    test('desktop opener replaced by compact launcher returns focus after Escape', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await openFixture(page, 'mixed', 'light', 'inspector');
        await page.getByRole('button', { name: '检查', exact: true }).click();
        await page.setViewportSize({ width: 375, height: 823 });
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await page.getByRole('button', { name: '资源', exact: true }).click();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        const launcher = page.getByRole('button', { name: '打开文章检查器', exact: true });
        await expect(launcher).toBeVisible();
        await expect(launcher).toBeFocused();
    });

    test('compact opener replaced by desktop rail returns to the current external view', async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 823 });
        await openFixture(page, 'mixed', 'dark', 'inspector');
        await page.getByRole('button', { name: '打开文章检查器', exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.getByRole('button', { name: '资源', exact: true }).click();
        await page.setViewportSize({ width: 1440, height: 900 });
        await expect(page.locator('aside[role="complementary"]')).toBeVisible();
        await page.getByRole('button', { name: '关闭文章检查器', exact: true }).click();
        await expect(page.locator('aside[role="complementary"]')).toBeHidden();
        await expect(page.getByRole('button', { name: '资源', exact: true })).toBeFocused();
    });

    test('a late desktop closed notification cannot steal focus after reopening', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await openFixture(page, 'mixed', 'light', 'inspector');
        await page.getByRole('button', { name: '检查', exact: true }).click();
        await page.evaluate(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
            const fixture = window as Window & {
                __articleEditorFixtureOpenInspector?: (view: 'resources') => void;
            };
            fixture.__articleEditorFixtureOpenInspector?.('resources');
            const close = document.querySelector<HTMLButtonElement>('.article-write-inspector-pane__close');
            close?.focus();
        });
        await expect(page.locator('[data-inspector-view="resources"]')).toHaveAttribute('aria-hidden', 'false');
        await page.evaluate(() => new Promise<void>((resolve) => {
            window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
        }));
        await expect(page.getByRole('button', { name: '关闭文章检查器', exact: true })).toBeFocused();
    });
});
