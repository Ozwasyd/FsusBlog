import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { systemChromiumLaunchOptions } = await import(new URL('../../support/system-chromium.mjs', import.meta.url));

// Real production SFC and public components; no component, data, or theme stubs.
// Run from src/frontend with FSUSBLOG_LOCAL_FSUSUI_ROOT selecting genuine source.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const frontend = path.join(repository, 'src/frontend');
const require = createRequire(path.join(frontend, 'package.json'));
const { createServer, loadConfigFromFile } = await import(require.resolve('vite'));
const { chromium } = require('@playwright/test');
const scratch = path.join(frontend, '.tmp');
fs.mkdirSync(scratch, { recursive: true });
const directory = fs.mkdtempSync(path.join(scratch, 'compact-tag-regression-'));
const results = [];
const failures = [];
let server;
let browser;

async function check(name, run)
{
    try
    {
        await run();
        results.push({ name, status: 'PASS' });
    }
    catch (error)
    {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ name, status: 'FAIL', message });
        failures.push(name);
    }
}

try
{
    fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="./entry.ts"></script></body></html>');
    fs.writeFileSync(path.join(directory, 'entry.ts'), `
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu, ElIcon, ElLink, ElTag } from '@ozwasyd/element-plus';
import Card, { type AdminArticleCompactCardRow } from '@/components/admin/article/AdminArticleCompactCard.vue';
import '@ozwasyd/element-plus/dist/index.css';
import '@ozwasyd/element-plus/dist/el-fsus-theme.css';
import './fixture.css';

const base = {
    id: 42, title: '文章 APIv2', summary: '', views: 12, createTime: '2026-10-09T00:00:00Z',
    category: { id: 8, name: '技术' }, tags: [], createdAtText: '', categoryName: '技术',
    statusText: '已发布', statusTagType: 'success', statusTimeLabel: '发布于',
    statusTimeText: '2026-10-09', statusTimeValue: '2026-10-09T00:00:00Z',
    primaryActionLabel: '编辑', previewActionLabel: '查看', publicPreviewAvailable: true
} satisfies AdminArticleCompactCardRow;
const row = ref<AdminArticleCompactCardRow>(base);
const showSlotProbe = ref(false);
const events: Array<{ action: string; id: number; sameRow: boolean }> = [];
const fixture = defineComponent({
    setup() {
        return () => h('div', { role: 'list' }, [h(Card, {
            row: row.value,
            onEdit: (id: number) => events.push({ action: 'edit', id, sameRow: id === row.value.id }),
            onView: (value: AdminArticleCompactCardRow) => events.push({ action: 'view', id: value.id, sameRow: value === row.value }),
            onMoveToTrash: (value: AdminArticleCompactCardRow) => events.push({ action: 'trash', id: value.id, sameRow: value === row.value })
        }), showSlotProbe.value ? h('div', { class: 'public-slot-probe', 'data-testid': 'public-slot-probe' }, [
            h(ElTag, { size: 'small', type: 'warning', disableTransitions: true, class: 'owned-tag-width' }, () => h('span', { class: 'owned-slot-label' }, row.value.categoryName))
        ]) : null]);
    }
});
const app = createApp(fixture);
for (const component of [ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu, ElIcon, ElLink, ElTag]) app.component(component.name!, component);
app.mount('#app');
Object.assign(window, {
    compactTagRegression: {
        async set(patch: Partial<AdminArticleCompactCardRow>) { row.value = { ...base, ...patch }; events.length = 0; await nextTick(); },
        events,
        async showSlot() { showSlotProbe.value = true; await nextTick(); }
    }
});
`);
    fs.writeFileSync(path.join(directory, 'fixture.css'), `
body { margin: 0; }
#app { width: 100%; }
.flex { display: flex; }
.min-w-0 { min-width: 0; }
.items-start { align-items: flex-start; }
.items-center { align-items: center; }
.flex-wrap { flex-wrap: wrap; }
.inline-flex { display: inline-flex; }
.gap-3 { gap: .75rem; }
.gap-1 { gap: .25rem; }
.gap-x-4 { column-gap: 1rem; }
.gap-y-2 { row-gap: .5rem; }
.mt-3 { margin-top: .75rem; }
.public-slot-probe { display: flex; min-width: 0; max-width: 100%; margin-top: 1rem; }
.owned-tag-width { min-width: 0; max-width: 100%; }
.owned-slot-label { min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
`);
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(frontend, 'vitest.config.ts'));
    assert.ok(loaded, 'canonical source alias configuration must load');
    server = await createServer({
        ...loaded.config,
        configFile: false,
        root: directory,
        server: { ...loaded.config.server, host: '127.0.0.1', port: 0 }
    });
    await server.listen();
    browser = await chromium.launch(systemChromiumLaunchOptions({ headless: true }));
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => Boolean(globalThis.window.compactTagRegression));

    await check('article identity, semantic time and title editing', async () =>
    {
        assert.equal(await page.getByRole('listitem').count(), 1);
        assert.equal(await page.locator('time').getAttribute('datetime'), '2026-10-09T00:00:00.000Z');
        await page.getByText('文章 APIv2', { exact: true }).click();
        assert.deepEqual(await page.evaluate(() => globalThis.window.compactTagRegression.events), [{ action: 'edit', id: 42, sameRow: true }]);
    });

    await check('native keyboard edit, dropdown preview and trash keep row identity', async () =>
    {
        await page.evaluate(() => globalThis.window.compactTagRegression.set({}));
        const edit = page.getByRole('button', { name: '编辑', exact: true });
        await edit.focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
        await page.getByRole('menuitem', { name: '查看', exact: true }).waitFor({ state: 'visible' });
        await page.waitForFunction(() => ['menu', 'menuitem'].includes(globalThis.document.activeElement?.getAttribute('role')));
        await page.keyboard.press('Home');
        await page.waitForFunction(() => globalThis.document.activeElement?.textContent?.trim() === '查看');
        await page.keyboard.press('Enter');
        await page.getByRole('menuitem', { name: '查看', exact: true }).waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: '更多' }).focus();
        await page.waitForFunction(() => globalThis.document.activeElement?.textContent?.includes('更多'));
        await page.keyboard.press('Enter');
        await page.getByRole('menuitem', { name: '移入回收站', exact: true }).waitFor({ state: 'visible' });
        await page.waitForFunction(() => ['menu', 'menuitem'].includes(globalThis.document.activeElement?.getAttribute('role')));
        await page.keyboard.press('End');
        await page.waitForFunction(() => globalThis.document.activeElement?.textContent?.trim() === '移入回收站');
        await page.keyboard.press('Enter');
        assert.deepEqual(await page.evaluate(() => globalThis.window.compactTagRegression.events), [
            { action: 'edit', id: 42, sameRow: true },
            { action: 'view', id: 42, sameRow: true },
            { action: 'trash', id: 42, sameRow: true }
        ]);
    });

    const longCategory = '分类 APIv2-' + 'UnbrokenCategory'.repeat(16);
    const longStatus = '定时发布等待索引同步'.repeat(12);
    for (const theme of ['light', 'dark'])
    {
        for (const width of [160, 320, 768])
        {
            await page.setViewportSize({ width, height: 1200 });
            await page.evaluate(value => globalThis.document.documentElement.classList.toggle('dark', value === 'dark'), theme);
            for (const [state, patch] of [
                ['short', {}],
                ['long-category', { categoryName: longCategory }],
                ['multiple-long-labels', { categoryName: longCategory, statusText: longStatus, statusTagType: 'warning' }],
                ['empty', { categoryName: '', statusText: '', title: '', statusTimeValue: '', statusTimeText: '' }],
                ['draft', { statusText: '草稿', statusTagType: 'info', primaryActionLabel: '继续编辑', publicPreviewAvailable: false }],
                ['danger', { statusText: '归档', statusTagType: 'danger' }]
            ])
            {
                await check(`${theme}/${width}/${state}: full labels bounded without clipping`, async () =>
                {
                    await page.evaluate(value => globalThis.window.compactTagRegression.set(value), patch);
                    const measured = await page.locator('.article-compact-tags').evaluate((tags) =>
                    {
                        const bounds = tags.getBoundingClientRect();
                        return Array.from(tags.children).map(tag =>
                        {
                            const tagBounds = tag.getBoundingClientRect();
                            const range = globalThis.document.createRange();
                            range.selectNodeContents(tag);
                            const textBounds = Array.from(range.getClientRects());
                            const clips = [tag, ...tag.querySelectorAll('*')].filter(element =>
                            {
                                const style = globalThis.getComputedStyle(element);
                                return ['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflowY);
                            });
                            return {
                                text: tag.textContent.trim(),
                                bounded: tagBounds.left >= bounds.left - 1 && tagBounds.right <= bounds.right + 1,
                                readable: textBounds.every(rect => rect.left >= tagBounds.left - 1 && rect.right <= tagBounds.right + 1 && rect.top >= tagBounds.top - 1 && rect.bottom <= tagBounds.bottom + 1),
                                clips: clips.length,
                                foreground: globalThis.getComputedStyle(tag).color
                            };
                        });
                    });
                    assert.equal(measured.length, 2, 'category and status remain distinct public tags');
                    assert.deepEqual(measured.map(tag => tag.text), [patch.categoryName ?? '技术', patch.statusText ?? '已发布']);
                    assert.ok(measured.every(tag => tag.bounded && tag.readable && tag.clips === 0), JSON.stringify(measured));
                    assert.ok(measured.every(tag => tag.foreground !== 'rgba(0, 0, 0, 0)'));
                    assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.window.innerWidth), 'page must not overflow');
                });
            }
        }
    }

    await check('documented default slot and owned width alone contain a multiline small Tag', async () =>
    {
        await page.setViewportSize({ width: 160, height: 1200 });
        await page.evaluate(value => globalThis.window.compactTagRegression.set({ categoryName: value }), longCategory);
        await page.evaluate(() => globalThis.window.compactTagRegression.showSlot());
        const measured = await page.getByTestId('public-slot-probe').evaluate(boundary =>
        {
            const tag = boundary.firstElementChild;
            const label = tag.firstElementChild;
            const tagRect = tag.getBoundingClientRect();
            const labelRect = label.getBoundingClientRect();
            return { tagHeight: tagRect.height, labelHeight: labelRect.height, contained: labelRect.top >= tagRect.top - 1 && labelRect.bottom <= tagRect.bottom + 1 };
        });
        if (process.env.FSUSBLOG_COMPACT_TAG_EVIDENCE_ROOT)
        {
            fs.mkdirSync(process.env.FSUSBLOG_COMPACT_TAG_EVIDENCE_ROOT, { recursive: true });
            await page.screenshot({ path: path.join(process.env.FSUSBLOG_COMPACT_TAG_EVIDENCE_ROOT, 'long-tag-public-slot.png'), fullPage: true });
        }
        assert.ok(measured.contained, JSON.stringify(measured));
    });

    await check('canonical boundary accepts the complete current candidate', () =>
    {
        execFileSync(process.execPath, [path.join(repository, 'tests/frontend/checks/static/check-fsusui-boundary.mjs')], { cwd: repository, stdio: 'pipe' });
    });
}
finally
{
    await browser?.close();
    await server?.close();
    fs.rmSync(directory, { recursive: true, force: true });
    for (const result of results)
    {
        console.log(`${result.status} ${result.name}${result.message ? `: ${result.message}` : ''}`);
    }
}

if (failures.length > 0)
{
    process.exitCode = 1;
}
