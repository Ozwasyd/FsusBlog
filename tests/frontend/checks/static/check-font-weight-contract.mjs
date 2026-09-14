#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../../..');
const sourceRoot = resolve(repoRoot, 'src/frontend/src');
const layoutRulesPath = resolve(repoRoot, 'docs/design/reading-typography.md');
const markdownPath = resolve(sourceRoot, 'assets/markdown.css');
const commentComposerPath = resolve(sourceRoot, 'components/article/ArticleCommentComposer.vue');
const articleTocPath = resolve(sourceRoot, 'components/article/ArticleTocPanel.vue');
const sourceExtensions = new Set(['.css', '.scss', '.vue', '.ts', '.tsx', '.js', '.jsx']);
const allowedNumericWeights = new Set(['400', '500', '700']);
const forbiddenUtilityPattern = /\bfont-(thin|extralight|light|semibold|extrabold|black)\b/gu;
const arbitraryWeightPattern = /\bfont-\[(\d{3})\]\b/gu;
const numericDeclarationPattern = /font-weight\s*:\s*(\d{3})(?:\s*!important)?\s*;/gu;
const errors = [];
let scannedFileCount = 0;

function expectRuleFontWeight(source, path, label, rulePattern, expectedWeight)
{
    const ruleBody = rulePattern.exec(source)?.groups?.body ?? '';
    if (ruleBody.length === 0 || !new RegExp(`font-weight\\s*:\\s*${expectedWeight};`, 'u').test(ruleBody))
    {
        errors.push(`${relativePath(path)}: ${label} must keep font-weight ${expectedWeight}`);
    }
}

function collectSourceFiles(directory)
{
    const files = [];

    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)))
    {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory())
        {
            files.push(...collectSourceFiles(path));
        }
        else if (entry.isFile() && sourceExtensions.has(extname(entry.name)))
        {
            files.push(path);
        }
    }

    return files;
}

function lineNumberAt(source, index)
{
    return source.slice(0, index).split('\n').length;
}

function relativePath(path)
{
    return path.slice(repoRoot.length + 1);
}

function recordMatches(path, source, pattern, describe)
{
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern))
    {
        const message = describe(match);
        if (message)
        {
            errors.push(`${relativePath(path)}:${lineNumberAt(source, match.index)} ${message}`);
        }
    }
}

for (const path of collectSourceFiles(sourceRoot))
{
    const source = readFileSync(path, 'utf8');
    scannedFileCount += 1;

    recordMatches(path, source, numericDeclarationPattern, (match) =>
    {
        const weight = match[1];
        return allowedNumericWeights.has(weight)
            ? null
            : `font-weight ${weight} is outside the 400/500/700 whitelist`;
    });
    recordMatches(path, source, forbiddenUtilityPattern, (match) => (
        `utility ${match[0]} requests a font weight outside the 400/500/700 whitelist`
    ));
    recordMatches(path, source, arbitraryWeightPattern, (match) =>
    {
        const weight = match[1];
        return allowedNumericWeights.has(weight)
            ? null
            : `utility ${match[0]} requests a font weight outside the 400/500/700 whitelist`;
    });
}

const commentComposer = readFileSync(commentComposerPath, 'utf8');
for (const [label, rulePattern] of [
    ['identity label', /\.comment-identity-label\s*\{(?<body>[^}]*)\}/u],
    ['identity badge', /\.comment-identity-badge\s*\{(?<body>[^}]*)\}/u],
    ['identity toggle', /\.comment-identity-toggle\s*\{(?<body>[^}]*)\}/u],
    ['draft status', /\.comment-composer-draft\s*\{(?<body>[^}]*)\}/u],
    ['empty preview', /\.comment-composer-preview\.is-empty\s*\{(?<body>[^}]*)\}/u],
    ['feedback', /\.comment-composer-feedback\s*\{(?<body>[^}]*)\}/u],
    ['metrics', /\.comment-composer-metrics\s*\{(?<body>[^}]*)\}/u]
])
{
    expectRuleFontWeight(commentComposer, commentComposerPath, label, rulePattern, '700');
}

const articleToc = readFileSync(articleTocPath, 'utf8');
expectRuleFontWeight(
    articleToc,
    articleTocPath,
    'desktop TOC title',
    /\.article-toc-panel__title\s*\{(?<body>[^}]*)\}/u,
    '700'
);

const markdown = readFileSync(markdownPath, 'utf8');
expectRuleFontWeight(
    markdown,
    markdownPath,
    'Markdown root',
    /\.markdown-body\s*\{(?<body>[^}]*)\}/u,
    '400'
);
const blockquoteRule = /\.markdown-body blockquote\s*\{(?<body>[^}]*)\}/u.exec(markdown)?.groups?.body ?? '';
if (blockquoteRule.length === 0 || /font-weight\s*:/u.test(blockquoteRule))
{
    errors.push('src/frontend/src/assets/markdown.css: blockquote must inherit the loaded 400 Markdown root weight');
}

const layoutRules = readFileSync(layoutRulesPath, 'utf8');
for (const requiredText of [
    '## 加载字重',
    '只允许真实加载的 `400`、`500`、`700`',
    '`font-normal`、`font-medium`、`font-bold`',
    '不得依赖浏览器合成缺失的粗体或细体'
])
{
    if (!layoutRules.includes(requiredText))
    {
        errors.push(`docs/design/reading-typography.md: missing font-weight contract text: ${requiredText}`);
    }
}

if (errors.length > 0)
{
    console.error('[check-font-weight-contract] failed');
    for (const error of errors)
    {
        console.error(`- ${error}`);
    }
    process.exitCode = 1;
}
else
{
    console.log(`[check-font-weight-contract] ok (${scannedFileCount} source files; weights=400/500/700)`);
}
