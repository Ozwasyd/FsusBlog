#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const failures = [];

const file = (relativePath) => path.join(repoRoot, relativePath);
const read = (relativePath) => fs.readFileSync(file(relativePath), 'utf8');
const requireTokens = (relativePath, tokens) =>
{
    const source = read(relativePath);
    for (const token of tokens)
    {
        if (!source.includes(token))
        {
            failures.push(`${relativePath}: missing ${token}`);
        }
    }
};

const strip = read('src/frontend/src/components/admin/article/ArticleWorkspaceTabStrip.vue');
const tabs = read('src/frontend/src/composables/useArticleWorkspaceTabs.ts');
const router = read('src/frontend/src/services/authoring/articleWorkspaceTabRouter.ts');
const adminFrame = read('src/frontend/src/layouts/AdminWorkspaceFrame.vue');
const list = read('src/frontend/src/composables/useAdminArticleList.ts');
const unitRouter = read('tests/frontend/unit/authoring/articleWorkspaceTabRouter.test.ts');
const unitStrip = read('tests/frontend/unit/components/admin/ArticleWorkspaceTabStrip.test.ts');

requireTokens('src/frontend/src/components/admin/article/ArticleWorkspaceTabStrip.vue', [
    'useArticleWorkspaceTabs',
    'role="tablist"',
    'role="tab"',
    'aria-selected',
    'ArrowRight',
    'ArrowLeft',
    'Home',
    'End',
    'auxclick',
    'overflowOpen',
    'data-article-workspace-tab-strip="mobile"',
    'prefers-reduced-motion',
    'forced-colors'
]);
requireTokens('src/frontend/src/composables/useArticleWorkspaceTabs.ts', [
    'coordinator.listTabs()',
    'coordinator.activateAndNavigate',
    'coordinator.promotePreview',
    'coordinator.unpinTab',
    'coordinator.requestClose',
    'coordinator.subscribe'
]);
requireTokens('src/frontend/src/services/authoring/articleWorkspaceTabRouter.ts', [
    'class ArticleWorkspaceTabRouter',
    'OpenArticleDocumentRegistry',
    'openOrActivateAndNavigate',
    'syncRoute',
    'createArticleWorkspaceSessionPort',
    'calculateOpenArticleDocumentDigest'
]);
requireTokens('src/frontend/src/layouts/AdminWorkspaceFrame.vue', [
    'ArticleWorkspaceTabStrip',
    '#before-content',
    'articleWorkspaceTabRouter.syncRoute'
]);
requireTokens('src/frontend/src/composables/useAdminArticleList.ts', [
    'articleWorkspaceTabRouter.openOrActivateAndNavigate',
    "entrypoint: 'internal-link'",
    "tabKind: options.preview ? 'preview' : 'pinned'"
]);
for (const [relativePath, source] of [
    ['src/frontend/src/components/admin/article/ArticleWorkspaceTabStrip.vue', strip],
    ['src/frontend/src/composables/useArticleWorkspaceTabs.ts', tabs]
])
{
    for (const pattern of [
        /\buseRoute\s*\(/u,
        /\b(?:localStorage|sessionStorage)\b/u,
        /articleTo(?:Tab|Session|Group)(?:Id|Ref)?\s*=\s*new Map/iu,
        /routeLocalArticle(?:Store|Registry)/iu,
        /mirrorArticleSession(?:Map|Registry)/iu,
        /:key\s*=\s*["']?articleId/iu
    ])
    {
        if (pattern.test(source))
        {
            failures.push(`${relativePath}: forbidden route-local or mirror authority ${pattern}`);
        }
    }
}
for (const token of ['markdownBody', 'undoStack', 'parserState', 'projectionState', 'renderCache', 'attachmentBytes', 'localStorage', 'sessionStorage'])
{
    if (router.includes(token))
    {
        failures.push(`src/frontend/src/services/authoring/articleWorkspaceTabRouter.ts: copies editor state via ${token}`);
    }
}
for (const token of [
    'rail',
    'quick-switcher',
    'internal-link',
    'recent-restore',
    'direct-route',
    'browser-new-tab',
    '0, 1, 20, 100',
    'session-result-stale'
])
{
    if (!unitRouter.includes(token))
    {
        failures.push(`tests/frontend/unit/authoring/articleWorkspaceTabRouter.test.ts: missing ${token}`);
    }
}
for (const token of ['0, 1, 20, 100', 'role="tablist"', 'auxclick', 'max-width: 1023px'])
{
    if (!unitStrip.includes(token))
    {
        failures.push(`tests/frontend/unit/components/admin/ArticleWorkspaceTabStrip.test.ts: missing ${token}`);
    }
}

if (failures.length > 0)
{
    console.error('[article-workspace-tab-governance]');
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
}
else
{
    console.log('[article-workspace-tab-governance] registry authority, route sync, projection, bounded UI and a11y contracts passed');
}
