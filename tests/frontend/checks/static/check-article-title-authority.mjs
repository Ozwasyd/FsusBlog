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

function expectMatch(source, pattern, label)
{
    if (!pattern.test(source))
    {
        errors.push(`${label}: missing ${pattern}`);
    }
}

const themeTokens = read('src/frontend/src/ui-tokens/themeTokens.ts');
const renderer = read('src/frontend/src/components/ui/MarkdownRenderer.vue');
const markdownCss = read('src/frontend/src/assets/markdown.css');

expectMatch(
    themeTokens,
    /articleDetail:\s*\{[\s\S]*?title: `text-2xl sm:text-3xl font-bold[^`]*leading-\[1\.25\] sm:leading-\[1\.2\]/u,
    'page title authority'
);
expectMatch(
    renderer,
    /'markdown-body--article': props\.mode === 'article',[\s\S]*'markdown-body--document': props\.mode === 'about',[\s\S]*'markdown-body--preview': props\.mode === 'preview' \|\| props\.mode === 'editor'/u,
    'Markdown mode ownership'
);
expectMatch(
    markdownCss,
    /\.markdown-body h1\s*\{[^}]*font-size:\s*1\.5rem;[^}]*font-weight:\s*700;[^}]*text-align:\s*left;/u,
    'shared reading chapter heading'
);
expectMatch(
    markdownCss,
    /\.markdown-body--document\s*\{[^}]*text-align:\s*left;[^}]*letter-spacing:\s*normal;[^}]*text-autospace:\s*normal;/u,
    '#1294 document typography'
);
if (errors.length > 0)
{
    console.error('[article-title-authority] failed');
    for (const error of errors)
    {
        console.error(`- ${error}`);
    }
    process.exitCode = 1;
}
else
{
    console.log('[article-title-authority] ok');
}
