#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const failures = [];

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/');
const read = (file) => fs.readFileSync(file, 'utf8');

const writePath = path.join(repoRoot, 'src/frontend/src/views/admin/article/Write.vue');
const sidebarPath = path.join(repoRoot, 'src/frontend/src/components/admin/article/ArticleWriteSidebar.vue');
const inspectorShellPath = path.join(
    repoRoot,
    'src/frontend/src/components/admin/article/ArticleWriteInspectorShell.vue'
);
const inspectorRailPath = path.join(
    repoRoot,
    'src/frontend/src/components/admin/article/ArticleWriteInspectorRail.vue'
);
const inspectorStatePath = path.join(
    repoRoot,
    'src/frontend/src/composables/useArticleWriteInspector.ts'
);
const seoPath = path.join(repoRoot, 'src/frontend/src/components/admin/article/ArticleSeoPreviewPanel.vue');
const titleFieldPath = path.join(repoRoot, 'src/frontend/src/components/admin/article/ArticleWriteTitleField.vue');
const commandBarPath = path.join(repoRoot, 'src/frontend/src/components/admin/article/ArticleWriteCommandBar.vue');
const markdownEditorPath = path.join(repoRoot, 'src/frontend/src/components/ui/MarkdownTextEditor.vue');
const accessibilityPath = path.join(repoRoot, 'src/frontend/src/components/admin/article/articleEditorAccessibility.ts');
const productionFixturePath = path.join(repoRoot, 'tests/frontend/fixtures/articleEditorProductionVisual.ts');
const productionFixtureContractPath = path.join(repoRoot, 'tests/frontend/fixtures/article-editor-production-contract.json');
const productionFixtureSpecPath = path.join(repoRoot, 'tests/frontend/e2e/article-editor-production-fixture.spec.ts');
const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json');

function fail(file, line, message)
{
    failures.push(`${rel(file)}:${line}: ${message}`);
}

function lineOf(source, token)
{
    const index = source.indexOf(token);
    if (index < 0)
    {
        return 1;
    }

    return source.slice(0, index).split(/\r?\n/).length;
}

const write = read(writePath);
const sidebar = read(sidebarPath);
const inspectorShell = read(inspectorShellPath);
const inspectorRail = read(inspectorRailPath);
const inspectorState = read(inspectorStatePath);
const seo = read(seoPath);
const titleField = read(titleFieldPath);
const commandBar = read(commandBarPath);
const markdownEditor = read(markdownEditorPath);
const accessibility = read(accessibilityPath);
const productionFixture = read(productionFixturePath);
const productionFixtureContract = JSON.parse(read(productionFixtureContractPath));
const productionFixtureSpec = read(productionFixtureSpecPath);

for (const [file, source, tokens] of [
    [writePath, write, [
        'account-page-eyebrow',
        '内容编辑',
        'write-side-tabs',
        'v-model="sidePanelTab"',
        'label="发布设置" name="publish"',
        'label="内容检查" name="check"',
        'label="预览" name="preview"',
        'label="历史版本" name="versions"',
        'label="资源" name="resources"',
        'layoutModeDescription',
        'openPreviewInspector',
        'setEditorLayoutMode',
        'editorLayoutModeLabel',
        '视图：{{ editorLayoutModeLabel }}',
        'write-layout-control',
        'rightsPanelOpen',
        'checkPanelOpen',
        'previewPanelOpen',
        'versionsPanelOpen',
        'resourcesPanelOpen',
        'editorLayoutMode',
        'ElCollapseTransition',
        'write-inspector',
        '生成摘要草稿',
        '检查草稿',
        '使用这版摘要',
        '根据当前标题与正文生成摘要草稿、标题备选、标签匹配和结构检查结果。'
    ]],
    [sidebarPath, sidebar, [
        'text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]',
        '发布状态',
        '文章头图',
        '所属分类',
        '标签索引',
        '内容摘要',
        'rounded-[var(--fsus-radius-popover)]',
        'border-dashed',
        'cover-action-overlay',
        'opacity-0',
        'group-hover:opacity-100'
    ]],
    [seoPath, seo, ['<dt>Slug</dt>', '<dt>Title</dt>', '<dt>Description</dt>']]
])
{
    for (const token of tokens)
    {
        if (source.includes(token))
        {
            fail(file, lineOf(source, token), `Article editor workspace must not include ${token}`);
        }
    }
}

const requiredWriteTokens = [
    '<ArticleWriteCommandBar',
    '@save-draft="saveDraftNow"',
    'focusFirstArticleValidationError()',
    '<ArticleWriteInspectorShell',
    ':active-inspector="activeInspector"',
    '@switch="switchInspector"',
    '@open-inspector="openInspector"',
    'data-editor-document-column="stable"',
    '<template #publish>',
    '<template #rights>',
    '<template #check>',
    '<template #preview>',
    '<template #versions>',
    '<template #resources>',
    'useArticleWriteInspector({',
    'criticalInspectorSummary',
    '内容检查',
    '生成摘要建议',
    '检查内容',
    '应用摘要',
    '应用标签',
    '应用标题',
    '应用翻译建议',
    '建议仅供参考，应用前可继续编辑。',
    '发布前 checklist'
];

for (const token of requiredWriteTokens)
{
    if (!write.includes(token))
    {
        fail(writePath, 1, `Article editor workspace contract is missing ${token}`);
    }
}

for (const token of [
    'articleWriteInspectorRegistry',
    "useMediaQuery('(max-width: 1023px)', false)",
    "resolveComponent('ElDrawer')",
    "isCompact.value ? publicDrawer : 'aside'",
    'v-if="!isCompact"',
    'v-if="isCompact"',
    'v-show="activeInspector === null"',
    'aria-label="打开文章检查器"',
    '<ArticleWriteInspectorRail',
    "role: 'complementary'",
    "size: '100%'",
    'modal: true',
    'lockScroll: true',
    'closeOnClickModal: true',
    'destroyOnClose: false',
    ':inert="activeInspector !== view.id"',
    'position: fixed;',
    "event.key === 'Escape'"
])
{
    if (!inspectorShell.includes(token))
    {
        fail(inspectorShellPath, 1, `Article inspector shell contract is missing ${token}`);
    }
}
for (const forbidden of [
    /aria-modal/iu,
    /:deep\(/u,
    /::v-deep/u,
    /\.el-[\w-]+/u,
    /transition\s*:[^;]*(?:width|inline-size)/iu,
    /backdrop-filter/iu,
    /linear-gradient/iu
])
{
    if (forbidden.test(`${inspectorShell}\n${inspectorRail}`))
    {
        fail(inspectorShellPath, 1, `Article inspector shell crosses its public boundary: ${forbidden}`);
    }
}
if ((inspectorShell.match(/\bElDrawer\b/gu) ?? []).length > 1)
{
    fail(inspectorShellPath, 1, 'Article inspector shell must use one responsive public Drawer host');
}
for (const token of [
    'articleWriteInspectorRegistry',
    "placement: 'desktop' | 'drawer'",
    'article-write-inspector-rail--desktop',
    'article-write-inspector-rail--drawer',
    'var(--fsus-control-height-spacious)',
    'registerTriggerElement'
])
{
    if (!inspectorRail.includes(token))
    {
        fail(inspectorRailPath, 1, `Article inspector rail contract is missing ${token}`);
    }
}
if ((inspectorRail.match(/<nav\b/gu) ?? []).length !== 1)
{
    fail(inspectorRailPath, 1, 'Article inspector must define exactly one responsive rail navigation');
}

for (const token of [
    'export const articleWriteInspectorRegistry',
    "const activeInspector = ref<ArticleWriteInspectorView | null>",
    'const requestedViews = shallowReactive(new Set<ArticleWriteInspectorView>())',
    'const scrollPositions = shallowReactive(new Map<ArticleWriteInspectorView, number>())',
    'const pendingLoads = new Map<ArticleWriteInspectorView, Promise<void>>()',
    'const switchTo = (view: ArticleWriteInspectorView): Promise<void> =>',
    'requestedViews.add(view)',
    'target?.focus({ preventScroll: true })'
])
{
    if (!inspectorState.includes(token))
    {
        fail(inspectorStatePath, 1, `Article inspector state contract is missing ${token}`);
    }
}

for (const token of [
    'min-height: 3.5rem;',
    'min-height: 2.75rem;',
    'position: static;',
    'width: 100%;',
    'min-height: var(--fsus-control-height-spacious);',
    'border-top: 1px solid var(--fsusblog-panel-border);',
    'background: var(--fsusblog-page-bg);',
    'padding: var(--fsus-space-3) 0 0;',
    'article-write-command-bar__save-status',
    'article-write-command-bar__save-draft',
    'article-write-command-bar__primary',
    'type="primary"',
    'aria-live="polite"'
])
{
    if (!commandBar.includes(token))
    {
        fail(commandBarPath, 1, `Article editor command bar contract is missing ${token}`);
    }
}
for (const forbidden of [
    /gradient/iu,
    /backdrop-filter/iu,
    /box-shadow/iu,
    /border-radius:\s*999/iu,
    /env\(\s*safe-area-inset-/iu,
    /position:\s*fixed/iu
])
{
    if (forbidden.test(commandBar))
    {
        fail(commandBarPath, 1, `Article editor command bar must not use decorative emphasis matching ${forbidden}`);
    }
}
for (const token of [
    "useMediaQuery('(max-width: 639px)', false)",
    "['h1', 'h2', 'bold', 'italic']",
    "['h1', 'h2', 'bold', 'italic', 'quote', 'link']"
])
{
    if (!markdownEditor.includes(token))
    {
        fail(markdownEditorPath, 1, `Article editor responsive command contract is missing ${token}`);
    }
}
for (const token of ['.el-form-item.is-error', 'target.focus({ preventScroll: true })', "block: 'center'"])
{
    if (!accessibility.includes(token))
    {
        fail(accessibilityPath, 1, `Article editor validation focus contract is missing ${token}`);
    }
}
for (const token of [
    'type="textarea"',
    'textarea-variant="editor-title"',
    ':autosize="{ minRows: 1, maxRows: 3 }"'
])
{
    if (!titleField.includes(token))
    {
        fail(titleFieldPath, 1, `Article title field contract is missing ${token}`);
    }
}

for (const forbidden of [
    /:deep\(/u,
    /::v-deep/u,
    /:global\(/u,
    /\.el-(?:form|input|textarea)/u,
    /!important/u,
    /font-weight:\s*(?:600|650)\b/u,
    /font-size:\s*(?:4rem|[4-9]\dpx)/u,
    /min-height:\s*(?:6\.5rem|10[0-9]px)/u,
    /letter-spacing:\s*-/u,
    /margin(?:-[a-z]+)?:\s*-\d/u,
    /position:\s*absolute/u
])
{
    if (forbidden.test(titleField))
    {
        fail(titleFieldPath, 1, `Article title field exceeds task-surface hierarchy: ${forbidden}`);
    }
}

if (productionFixtureContract.schema !== 'fsusblog.article-editor-production-fixture.v1')
{
    fail(productionFixtureContractPath, 1, 'Article editor production fixture schema is missing or stale');
}
for (const width of [375, 768, 1366, 1440])
{
    if (!productionFixtureContract.viewports.some((viewport) => viewport.width === width))
    {
        fail(productionFixtureContractPath, 1, `Article editor production fixture must cover ${width}px`);
    }
}
for (const title of ['empty', 'short', 'long', 'mixed'])
{
    if (!(title in productionFixtureContract.titles))
    {
        fail(productionFixtureContractPath, 1, `Article editor production fixture must cover ${title} title`);
    }
}
for (const token of ['ArticleWriteTitleField', 'articleEditorFixtureReady'])
{
    if (!productionFixture.includes(token))
    {
        fail(productionFixturePath, 1, `Article editor production fixture is missing ${token}`);
    }
}
for (const token of [
    'ArticleWriteInspectorShell',
    'ArticleWriteSidebar',
    'EditorIdentitySentinel',
    '__articleEditorFixtureLoadCounts',
    'data-document-wrap-signature',
    'rightsParagraphs',
    'revisionItems',
    'assetItems',
    'issueItems'
])
{
    if (!productionFixture.includes(token))
    {
        fail(productionFixturePath, 1, `Article editor inspector fixture is missing ${token}`);
    }
}
for (const [field, value] of [
    ['rightsParagraphs', 24],
    ['revisions', 100],
    ['assets', 1000],
    ['issues', 120]
])
{
    if (productionFixtureContract.largeContent?.[field] !== value)
    {
        fail(
            productionFixtureContractPath,
            1,
            `Article editor inspector fixture must cover ${value} ${field}`
        );
    }
}
for (const state of ['empty', 'loading', 'error', 'success', 'partial'])
{
    if (!productionFixtureContract.states?.includes(state))
    {
        fail(productionFixtureContractPath, 1, `Article editor inspector fixture must cover ${state}`);
    }
}
for (const token of [
    'fontSize).toBeLessThanOrEqual(40)',
    '150% zoom',
    'height).toBeGreaterThanOrEqual(360)',
    'FsusUI|Element Plus|adapter|component|MarkdownEditor',
    'new Set([40])',
    'actionBox!.height).toBe(64)',
    'toBeGreaterThanOrEqual(80)',
    'toBeFocused()',
    'maximumDocumentWidthDelta',
    'data-document-wrap-signature',
    '__articleEditorFixtureEditorNode',
    '__articleEditorFixtureLoadCounts',
    '[data-inspector-view][aria-hidden="false"]',
    "'打开文章检查器'",
    "getByRole('button', { name: /关闭|close/i })",
    '/@vite/client',
    "emulateMedia({ reducedMotion: 'reduce' })"
])
{
    if (!productionFixtureSpec.includes(token))
    {
        fail(productionFixtureSpecPath, 1, `Article editor production fixture acceptance is missing ${token}`);
    }
}

const requiredSidebarTokens = [
    'article-sidebar-section',
    'article-sidebar-publish-title',
    'article-sidebar-info-title',
    'article-sidebar-cover-title',
    '<span>状态</span>',
    '<span>分类</span>',
    '<span>标签</span>',
    '<span>摘要</span>',
    '<span>头图</span>',
    '未设置',
    '建议比例 16:9。用于首页和文章页展示。',
    '移除',
    '留空时使用正文开头。'
];

for (const token of requiredSidebarTokens)
{
    if (!sidebar.includes(token))
    {
        fail(sidebarPath, 1, `Article editor sidebar contract is missing ${token}`);
    }
}

for (const token of ['ElCollapseTransition', 'article-sidebar-summary', 'aria-expanded='])
{
    if (sidebar.includes(token))
    {
        fail(sidebarPath, lineOf(sidebar, token), `Article editor sidebar must be flat and omit ${token}`);
    }
}

for (const token of ['地址片段', '标题长度', '摘要长度'])
{
    if (!seo.includes(token))
    {
        fail(seoPath, 1, `Article editor SEO panel contract is missing ${token}`);
    }
}

const packageJson = JSON.parse(read(packageJsonPath));
const scripts = packageJson.scripts ?? {};
const checkScript = 'node ../../tests/frontend/checks/static/check-article-editor-workspace-governance.mjs';
if (scripts['check:article-editor-workspace-governance'] !== checkScript)
{
    fail(packageJsonPath, 1, 'check:article-editor-workspace-governance script is missing');
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:article-editor-workspace-governance'))
{
    fail(packageJsonPath, 1, 'check:views-constraints must run check:article-editor-workspace-governance');
}

if (failures.length > 0)
{
    console.error(failures.map((failure) => `[article-editor-workspace-governance] ${failure}`).join('\n'));
    process.exit(1);
}

console.log('[article-editor-workspace-governance] ok');
