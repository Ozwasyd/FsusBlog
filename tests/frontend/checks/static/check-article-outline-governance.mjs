#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const failures = [];

const relative = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/');
const read = (file) => fs.readFileSync(file, 'utf8');
const lineOf = (source, token) => {
    const index = source.indexOf(token);
    return index < 0 ? 1 : source.slice(0, index).split(/\r?\n/u).length;
};
const requireTokens = (file, source, tokens) => {
    for (const token of tokens) {
        if (!source.includes(token)) {
            failures.push(`${relative(file)}:${lineOf(source, token)}: missing ${token}`);
        }
    }
};
const forbidTokens = (file, source, tokens) => {
    for (const token of tokens) {
        if (source.includes(token)) {
            failures.push(`${relative(file)}:${lineOf(source, token)}: forbidden ${token}`);
        }
    }
};

const outlineAdapterPath = path.join(repoRoot, 'src/frontend/src/composables/useArticleOutline.ts');
const outlineRailPath = path.join(repoRoot, 'src/frontend/src/components/admin/article/ArticleWriteOutlineRail.vue');
const articleEditorPath = path.join(repoRoot, 'src/frontend/src/components/admin/article/ArticleWriteEditor.vue');
const markdownAdapterPath = path.join(repoRoot, 'src/frontend/src/components/ui/MarkdownEditorAdapter.vue');
const markdownTextEditorPath = path.join(repoRoot, 'src/frontend/src/components/ui/MarkdownTextEditor.vue');
const fixturePath = path.join(repoRoot, 'tests/frontend/fixtures/articleEditorProductionVisual.ts');
const fixtureContractPath = path.join(repoRoot, 'tests/frontend/fixtures/article-editor-production-contract.json');
const fixtureSpecPath = path.join(repoRoot, 'tests/frontend/e2e/article-editor-production-fixture.spec.ts');

const outlineAdapter = read(outlineAdapterPath);
const outlineRail = read(outlineRailPath);
const articleEditor = read(articleEditorPath);
const markdownAdapter = read(markdownAdapterPath);
const markdownTextEditor = read(markdownTextEditorPath);
const fixture = read(fixturePath);
const fixtureContract = JSON.parse(read(fixtureContractPath));
const fixtureSpec = read(fixtureSpecPath);

requireTokens(outlineAdapterPath, outlineAdapter, [
    'createMarkdownOutlineModel',
    'createMarkdownOutlineTree',
    'resolveMarkdownOutlineActive',
    'documentIdentity',
    'sourceRevision',
    'previousProjection',
    'noteOutlineNavigation'
]);
forbidTokens(outlineAdapterPath, outlineAdapter, [
    'querySelector',
    'getElementById',
    'document.query',
    'matchAll',
    'createMarkdownSourceCoordinateMap',
    'localStorage'
]);

requireTokens(outlineRailPath, outlineRail, [
    "useMediaQuery('(max-width: 1023px)', false)",
    "resolveComponent('ElDrawer')",
    'role: \'tree\'',
    "role: 'treeitem'",
    'aria-selected',
    'RAIL_OPEN_STORAGE_KEY',
    'localStorage.setItem',
    'focusReturnPending',
    'ArrowDown',
    'ArrowUp',
    'ArrowLeft',
    'ArrowRight',
    'Escape'
]);
forbidTokens(outlineRailPath, outlineRail, [
    ':deep(',
    '::v-deep',
    'querySelector',
    'getElementById',
    'matchAll',
    'innerWidth',
    'titleMatch',
    'slug',
    'offsetMap',
    'fsusui-token-fork'
]);

requireTokens(articleEditorPath, articleEditor, [
    '<ArticleWriteOutlineRail',
    'useArticleOutline',
    'articleIdentity',
    'documentIdentity',
    'sourceRevision',
    'revealHeading',
    'revealSourceRange',
    'expected:',
    'revision: sourceRevision.value',
    '@viewport-change="handleViewportChange"'
]);
requireTokens(markdownAdapterPath, markdownAdapter, [
    '@selection-change="emit(\'selection-change\', $event)"',
    '@transaction="emit(\'transaction\', $event)"',
    '@viewport-change="emit(\'viewport-change\', $event)"',
    'revealHeading',
    'revealSourceRange'
]);
requireTokens(markdownTextEditorPath, markdownTextEditor, [
    'createMarkdownSourceCoordinateMap',
    '@scroll.capture="trackAuthoringViewport"',
    'emit(\'viewport-change\'',
    'revealHeading',
    'revealSourceRange'
]);

requireTokens(fixturePath, fixture, [
    "'outline'",
    'outlineFixtureContent',
    'outlineCount',
    '__articleEditorFixtureSwitchOutlineArticle',
    'articleIdentity: outlineArticleIdentity.value'
]);
const headingCounts = fixtureContract.outline?.headingCounts;
if (JSON.stringify(headingCounts) !== JSON.stringify([0, 1, 10, 100, 1000, 10000])) {
    failures.push(`${relative(fixtureContractPath)}: outline heading-count matrix must cover 0,1,10,100,1000,10000`);
}
requireTokens(fixtureSpecPath, fixtureSpec, [
    "'article editor production fixture outline rail'",
    'article-outline-desktop-light.png',
    'article-outline-mobile-dark.png',
    'toHaveCount(10)',
    'toHaveAccessibleName',
    'toHaveAttribute(\'aria-selected\', \'true\')',
    'toBeFocused()'
]);

if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
} else {
    console.log('article outline governance: ok');
}
