#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const failures = [];

const relative = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/');
const read = (file) => fs.readFileSync(file, 'utf8');
const lineOf = (source, token) =>
{
    const index = source.indexOf(token);
    return index < 0 ? 1 : source.slice(0, index).split(/\r?\n/u).length;
};
const requireTokens = (file, source, tokens) =>
{
    for (const token of tokens)
    {
        if (!source.includes(token))
        {
            failures.push(`${relative(file)}:${lineOf(source, token)}: missing ${token}`);
        }
    }
};
const forbidTokens = (file, source, tokens) =>
{
    for (const token of tokens)
    {
        if (source.includes(token))
        {
            failures.push(`${relative(file)}:${lineOf(source, token)}: forbidden ${token}`);
        }
    }
};

// Parse executable statements rather than accepting obsolete focus tokens or
// comments as evidence that the shared modal owner is still respected.
const require = createRequire(import.meta.url);
const ts = require(require.resolve('typescript', { paths: [path.join(repoRoot, 'src/frontend')] }));

export function outlineFocusOwnershipViolations(source)
{
    const violations = [];
    const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/u)?.[1];
    if (!script)
    {
        return ['outline focus ownership requires the real TypeScript setup script'];
    }
    const ast = ts.createSourceFile('ArticleWriteOutlineRail.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const printer = ts.createPrinter({ removeComments: true });
    const text = (node) => printer.printNode(ts.EmitHint.Unspecified, node, ast).replace(/\s+/gu, '');
    const nodes = [];
    const visit = (node) =>
    {
        nodes.push(node);
        ts.forEachChild(node, visit);
    };
    visit(ast);
    const arrow = (name) => nodes.find((node) => ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && ts.isArrowFunction(node.initializer))?.initializer;
    const inside = (node, parent) => parent && node.pos >= parent.pos && node.end <= parent.end;
    const has = (parent, expected) => nodes.some((node) => inside(node, parent) && text(node) === expected);
    const focus = arrow('focusLauncher');
    const close = arrow('requestClose');
    const open = arrow('openRail');
    const invalidate = arrow('invalidateFocusReturn');
    const focusCalls = nodes.filter((node) => ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'focus'
        && text(node.expression.expression) === 'launcherRef.value');
    const focusGuard = nodes.find((node) => inside(node, focus) && ts.isIfStatement(node)
        && text(node.expression) === '!disposed&&generation===focusGeneration&&!isOpen.value&&!isCompact.value'
        && focusCalls.some((call) => inside(call, node.thenStatement)));
    if (focusCalls.length !== 1 || !focusGuard)
    {
        violations.push('desktop launcher focus must be guarded by disposal, generation, closed state and non-modal mode');
    }
    const consume = nodes.find((node) => inside(node, focus) && ts.isExpressionStatement(node) && text(node) === 'pendingFocusIntent=null;');
    const wait = nodes.find((node) => inside(node, focus) && ts.isExpressionStatement(node) && text(node) === 'awaitnextTick();');
    if (!has(focus, 'constgeneration=pendingFocusIntent;') || !has(focus, 'if(generation===null){return;}')
        || !consume || !wait || consume.end > wait.pos || !focusGuard || wait.end > focusGuard.pos)
    {
        violations.push('desktop focus intent must be consumed once before awaiting the DOM flush');
    }
    const compactGuard = nodes.find((node) => inside(node, close) && ts.isIfStatement(node)
        && text(node.expression) === '!isCompact.value'
        && has(node.thenStatement, 'pendingFocusIntent=focusGeneration;')
        && has(node.thenStatement, 'awaitfocusLauncher();'));
    const restoreCalls = nodes.filter((node) => ts.isCallExpression(node)
        && ts.isIdentifier(node.expression) && node.expression.text === 'focusLauncher');
    if (!compactGuard || restoreCalls.length !== 1 || !inside(restoreCalls[0], compactGuard.thenStatement))
    {
        violations.push('compact restoration belongs exclusively to the shared Drawer trap');
    }
    if (!has(invalidate, 'focusGeneration+=1;') || !has(invalidate, 'pendingFocusIntent=null;')
        || !has(open, 'invalidateFocusReturn();') || !has(close, 'invalidateFocusReturn();'))
    {
        violations.push('open and close must invalidate stale desktop focus intents');
    }
    const disposal = nodes.find((node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'onBeforeUnmount' && node.arguments[0]
        && has(node.arguments[0], 'disposed=true;') && has(node.arguments[0], 'invalidateFocusReturn();'));
    if (!disposal || !nodes.some((node) => text(node) === "watch(isCompact,invalidateFocusReturn,{flush:'sync'});")
        || !nodes.some((node) => text(node) === "watch(()=>props.snapshot,invalidateFocusReturn,{flush:'sync'});"))
    {
        violations.push('unmount, breakpoint and article replacement must synchronously invalidate pending desktop focus');
    }
    if (nodes.some((node) => ts.isIdentifier(node) && ['requestAnimationFrame', 'cancelAnimationFrame'].includes(node.text))
        || /@closed\s*=|onClosed\s*:/u.test(source))
    {
        violations.push('product modal restoration must not add a second frame or closed-event handler');
    }
    if (!source.includes('v-if="isCompact || !isOpen"'))
    {
        violations.push('the native compact opener must remain mounted and focusable while the modal is open');
    }
    return violations;
}

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

for (const violation of outlineFocusOwnershipViolations(outlineRail))
{
    failures.push(`${relative(outlineRailPath)}: ${violation}`);
}

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
if (JSON.stringify(headingCounts) !== JSON.stringify([0, 1, 10, 100, 1000, 10000]))
{
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

if (failures.length > 0)
{
    console.error(failures.join('\n'));
    process.exitCode = 1;
}
else
{
    console.log('article outline governance: ok');
}
