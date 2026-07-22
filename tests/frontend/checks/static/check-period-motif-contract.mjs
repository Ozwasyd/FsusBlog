#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const errors = [];

function read(path)
{
    return readFileSync(resolve(repoRoot, path), 'utf8');
}

function expectIncludes(source, token, label)
{
    if (!source.includes(token))
    {
        errors.push(`${label}: missing ${token}`);
    }
}

function expectNotIncludes(source, token, label)
{
    if (source.includes(token))
    {
        errors.push(`${label}: must not include ${token}`);
    }
}

const owner = read('src/frontend/src/ui-contracts/publicPeriodMotif.ts');
const themeTokens = read('src/frontend/src/ui-tokens/themeTokens.ts');
const articleList = read('src/frontend/src/components/public/PublicArticleList.vue');
const articleDetail = read('src/frontend/src/components/article/ArticleDetailHeader.vue');
const commentsPlaceholder = read('src/frontend/src/components/public/ArticleDetailCommentsPlaceholder.vue');
const homeLoading = read('src/frontend/src/components/home/HomeArticleLoadingState.vue');
const contentState = read('src/frontend/src/components/public/PublicContentState.vue');
const archive = read('src/frontend/src/components/public/pages/PublicArchivePageContent.vue');
const pageAssemblies = read('src/frontend/src/public-renderers/pageAssemblies.ts');
const publicPageCss = read('src/frontend/src/assets/public-page.css');
const componentTests = read('tests/frontend/unit/components/PublicContentSemantics.test.ts');
const visualTests = read('tests/frontend/e2e/visual/public-visual.spec.ts');

for (const token of [
    "glyph: '·'",
    "className: 'fsusblog-dot-loader'",
    "showsForTone: (tone: PublicContentTone): boolean => tone === 'neutral'",
    "metadataSeparatorClass = 'font-normal text-[var(--fsusblog-text-decorative)]'"
])
{
    expectIncludes(owner, token, 'canonical public period motif owner');
}

for (const [source, label, tokens] of [
    [themeTokens, 'theme token adapter', ['publicPeriodMotif.metadata.className', 'publicPeriodMotif.loading.className']],
    [articleList, 'article list', ['publicPeriodMotif.metadata.glyph', 'themeTokens.articleList.metaSeparator']],
    [articleDetail, 'article detail', ['publicPeriodMotif.metadata.glyph', 'themeTokens.articleDetail.metaSeparator']],
    [commentsPlaceholder, 'comments loading state', ['themeTokens.articleDetail.commentsPlaceholderDot', 'role="status"']],
    [homeLoading, 'home loading state', ['publicPeriodMotif.loading.className', 'role="status"', ':aria-label="copy.feedLoadingLabel"']],
    [contentState, 'public content state', ['publicPeriodMotif.contentState.showsForTone(tone)', 'publicPeriodMotif.loading.className']]
])
{
    for (const token of tokens)
    {
        expectIncludes(source, token, label);
    }
}

for (const [source, label] of [
    [themeTokens, 'theme token adapter'],
    [articleList, 'article list'],
    [articleDetail, 'article detail'],
    [homeLoading, 'home loading state'],
    [contentState, 'public content state']
])
{
    expectNotIncludes(source, "'fsusblog-dot-loader'", label);
}
expectNotIncludes(articleList, '>·</span>', 'article list');
expectNotIncludes(articleDetail, '>·</span>', 'article detail');
expectIncludes(archive, 'aria-hidden="true">.</span>', 'archive year anchor remains outside midpoint motif');
expectNotIncludes(archive, 'aria-hidden="true">·</span>', 'archive year anchor');

for (const token of [
    'PublicHomePageContent',
    'PublicArticleDetailPageContent',
    'PublicArchivePageContent',
    'PublicFilterPageContent'
])
{
    expectIncludes(pageAssemblies, token, 'shared SSR/AOT and hydration assemblies');
}

for (const token of [
    ':where(#app, #fsus-aot-shell) .fsusblog-dot-loader {',
    'border-radius: var(--fsus-radius-pill, 999px);',
    'background: var(--fsusblog-text-decorative);'
])
{
    expectIncludes(publicPageCss, token, 'shared SPA and AOT motif style');
}

for (const token of ['findAll(\'[aria-hidden="true"]\')', "findAll('.fsusblog-dot-loader')", "toBe('fsusblog-dot-loader')"])
{
    expectNotIncludes(componentTests, token, 'component behavior tests');
}
for (const token of ['public-home', 'public-article', 'expectStableScreenshot'])
{
    expectIncludes(visualTests, token, 'semantic public visual diagnostics');
}

if (errors.length > 0)
{
    console.error('[period-motif-contract] failed');
    for (const error of errors)
    {
        console.error(`- ${error}`);
    }
    process.exitCode = 1;
}
else
{
    console.log('[period-motif-contract] ok');
}
