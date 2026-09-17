#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const read = (path) => readFileSync(new URL(path, `file://${root}/`), 'utf8');
const require = createRequire(new URL('../../../../src/frontend/package.json', import.meta.url));
const { chromium } = require('playwright');
const workspaceCss = read('src/frontend/src/assets/admin-workspace.css');
const toolbarSource = read('src/frontend/src/components/admin/comment-moderation/CommentModerationToolbar.vue');
const toolbarCss = toolbarSource.match(/<style scoped>([\s\S]*?)<\/style>/u)?.[1] ?? '';
const fixture = JSON.parse(read('tests/frontend/fixtures/comment-moderation-first-screen.json'));
const variables = `
  --fsus-space-1:4px;--fsus-space-2:8px;--fsus-space-3:12px;--fsus-space-4:16px;
  --fsus-space-5:20px;--fsus-space-6:24px;--fsusblog-panel-border:#d8d8dc;
  --fsusblog-page-bg:#fff;--fsusblog-page-bg-soft:#f7f7f8;--fsusblog-surface-bg:#fff;
  --fsusblog-text-primary:#141416;--fsusblog-text-secondary:#343438;
  --fsusblog-text-tertiary:#66666d;--fsusblog-text-muted:#777780;
  --fsusblog-color-primary:#2a599c;--fsusblog-color-focus-ring:#2a599c;
  --fsus-radius-control:6px;--fsus-radius-control-small:4px;
`;

function markup(selectedCount, dark)
{
    const rows = Array.from({ length: 5 }, (_, index) =>
        `<div class="fixture-row">评论 ${index + 1}</div>`).join('');
    return `<!doctype html><style>
      :root{${variables}}*{box-sizing:border-box}body{margin:0;background:${dark ? '#111' : '#fff'}}
      ${workspaceCss}${toolbarCss}
      .fixture-header{height:64px}.fixture-status{width:310px;height:40px}
      .fixture-search{width:320px;height:44px}.fixture-advanced{width:112px;height:44px}
      .fixture-selection-content{height:40px}.fixture-table-header{height:40px}
      .fixture-row{height:48px;padding:12px 16px;border-bottom:1px solid var(--fsusblog-panel-border)}
      @media(width <= 767px){.fixture-status,.fixture-search{width:100%}}
    </style><main class="admin-workspace-frame">
      <header class="fixture-header"></header>
      <section class="collection-workbench">
        <header class="collection-workbench__summary"><div><h2 class="collection-workbench__title">审核队列</h2><p class="collection-workbench__meta">3 / 50 条评论</p></div></header>
        <div class="collection-workbench__toolbar">
          <div class="comment-moderation-primary-filters">
            <div class="comment-moderation-status-tabs fixture-status"></div>
            <div class="comment-moderation-primary-search fixture-search"></div>
          </div>
          <button class="comment-advanced-trigger fixture-advanced">高级筛选</button>
        </div>
        ${selectedCount > 0 ? '<div class="collection-workbench__selection"><div class="fixture-selection-content">已选择</div></div>' : ''}
        <div class="collection-workbench__results"><div class="fixture-table-header"></div>${rows}</div>
      </section>
    </main>`;
}

const systemChrome = '/usr/bin/google-chrome';
const browser = await chromium.launch({
    headless: true,
    ...(existsSync(systemChrome) ? { executablePath: systemChrome } : {})
});
try
{
    for (const viewport of fixture.viewports)
    {
        for (const dark of [false, true])
        {
            const page = await browser.newPage({ viewport });
            await page.setContent(markup(0, dark));
            const geometry = await page.evaluate(() =>
            {
                const rect = (selector) => globalThis.document.querySelector(selector).getBoundingClientRect();
                const header = rect('.fixture-header');
                const workbench = rect('.collection-workbench');
                const toolbar = rect('.collection-workbench__toolbar');
                const status = rect('.fixture-status');
                const search = rect('.fixture-search');
                const advanced = rect('.fixture-advanced');
                const results = rect('.collection-workbench__results');
                const tableHeader = rect('.fixture-table-header');
                const rows = [...globalThis.document.querySelectorAll('.fixture-row')].map((row) => row.getBoundingClientRect());
                return {
                    headerGap: workbench.top - header.bottom,
                    toolbarHeight: toolbar.height,
                    resultsGap: results.top - toolbar.bottom,
                    primaryDirection: globalThis.getComputedStyle(globalThis.document.querySelector('.comment-moderation-primary-filters')).flexDirection,
                    primaryGap: Number.parseFloat(globalThis.getComputedStyle(globalThis.document.querySelector('.comment-moderation-primary-filters')).gap),
                    statusTop: status.top,
                    searchTop: search.top,
                    advancedTop: advanced.top,
                    tableHeaderTop: tableHeader.top,
                    visibleRows: rows.filter((row) => row.bottom <= globalThis.innerHeight).length
                };
            });
            assert.ok(geometry.headerGap >= 20 && geometry.headerGap <= 24);
            assert.ok(geometry.resultsGap >= 20 && geometry.resultsGap <= 24);
            assert.ok(geometry.visibleRows >= viewport.minimumVisibleRows);
            if (viewport.width >= 768)
            {
                assert.equal(geometry.toolbarHeight, 44);
                assert.equal(geometry.primaryDirection, 'row');
                assert.ok(geometry.primaryGap >= 8 && geometry.primaryGap <= 12);
            }
            else
            {
                assert.equal(geometry.primaryDirection, 'column');
                assert.equal(geometry.primaryGap, 8);
                assert.ok(geometry.searchTop > geometry.statusTop);
                assert.ok(geometry.advancedTop > geometry.searchTop);
            }
            await page.close();
        }
    }

    const page = await browser.newPage({ viewport: fixture.viewports[0] });
    await page.setContent(markup(0, false));
    assert.equal(await page.locator('.collection-workbench__selection').count(), 0);
    await page.setContent(markup(10, false));
    const selectionHeight = await page.locator('.collection-workbench__selection').evaluate((node) =>
        node.getBoundingClientRect().height);
    assert.ok(selectionHeight >= 48 && selectionHeight <= 56, `selection height was ${selectionHeight}px`);
    await page.close();
}
finally
{
    await browser.close();
}

console.log('[comment-moderation-geometry] production CSS geometry passed for 4 viewports and both themes');
