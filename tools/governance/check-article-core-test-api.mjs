#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const retiredMethodNames = [
    'GetPageListAsync',
    'GetByIdAsync',
    'CreateAsync',
    'UpdateAsync',
    'DeleteAsync',
    'RestoreAsync',
    'PermanentlyDeleteArticleAsync',
    'SearchArticlesAsync',
    'GetHotArticlesAsync',
    'GetFeaturedArticlesAsync',
    'IncreaseViewCountAsync',
    'IncreaseViewCountsAsync'
];

const extensionShape = new RegExp(
    String.raw`\b(?:${retiredMethodNames.join('|')})\s*\(\s*(?:this\s+)?(?:IArticleCoreService|IArticleCoreGateway|ArticleService)\s+\w+\s*,\s*(?:int|string|CreateArticleRequest|UpdateArticleRequest)\b`,
    's'
);

export function inspectArticleCoreTestSource(source, relativePath = '<source>')
{
    const diagnostics = [];
    const rules = [
        ['retired-class', /\bArticleCoreTestCompatibilityExtensions\b/],
        ['retired-namespace', /\bFsusBlog\.Server\.Tests\.Compatibility\b/],
        ['retired-primitive-wrapper-shape', extensionShape]
    ];

    for (const [rule, pattern] of rules)
    {
        const match = pattern.exec(source);
        if (!match)
        {
            continue;
        }
        const line = source.slice(0, match.index).split(/\r?\n/u).length;
        diagnostics.push(`${relativePath}:${line}: ${rule}`);
    }

    return diagnostics;
}

function walkCsFiles(directory)
{
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
    {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            files.push(...walkCsFiles(absolute));
        }
        else if (entry.isFile() && entry.name.endsWith('.cs'))
        {
            files.push(absolute);
        }
    }
    return files;
}

export function inspectArticleCoreTestTree(repositoryRoot)
{
    const backendTests = path.join(repositoryRoot, 'tests', 'backend');
    return walkCsFiles(backendTests).flatMap((absolute) =>
    {
        const relative = path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/');
        return inspectArticleCoreTestSource(fs.readFileSync(absolute, 'utf8'), relative);
    });
}

function main()
{
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const sourceIndex = process.argv.indexOf('--source');
    const sourcePath = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : null;
    if (sourceIndex >= 0 && !sourcePath)
    {
        throw new Error('--source requires a file path');
    }
    const diagnostics = sourcePath
        ? inspectArticleCoreTestSource(fs.readFileSync(sourcePath, 'utf8'), path.basename(sourcePath))
        : inspectArticleCoreTestTree(repositoryRoot);
    if (diagnostics.length > 0)
    {
        process.stderr.write(`${diagnostics.join('\n')}\n`);
        process.exitCode = 1;
        return;
    }
    process.stdout.write('[article-core-test-api] ok\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
