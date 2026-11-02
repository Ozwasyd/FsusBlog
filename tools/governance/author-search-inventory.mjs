#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const inventorySchema = 'fsusblog.author-search-inventory.v1';
const signals = [
    ['search-reference', /\b[\w$]*(?:search|switcher)[\w$]*\b|全文搜索|全文检索|标题搜索|搜索文章/giu],
    ['query-parameter', /\b(?:keyword|articleKeyword|queryText)\b/gu],
    ['database-pattern', /\b(?:LIKE|ILIKE|REGEXP_LIKE|REGEXP|SIMILAR\s+TO)\b|~\*?\s*@/giu],
    ['field-client-match', /\b(?:title|summary|content|body|markdown)\s*\)?\s*\??\.(?:Contains|includes|match|search|indexOf)\s*\(/giu],
    ['field-pattern-call', /\b(?:Contains|Like|ILike|IsMatch)\s*\([^\n;]*(?:title|summary|content|body|markdown)\b/giu],
    ['client-corpus', /\b(?:allArticles|articleCorpus|titleIndex|searchIndex|localSearch|searchArticles)\b/giu],
    ['rendered-search', /\b(?:textContent|innerText|innerHTML|DOMParser|querySelectorAll)\b/gu],
    ['durable-client-state', /\b(?:localStorage|sessionStorage|indexedDB)\b/gu],
    ['fallback-reference', /\b(?:fallback|compat|legacy)[\w-]*\b|降级|兼容/giu],
    ['content-search-label', /full[ -]?text|全文|正文搜索|正文检索/giu]
];

function digest(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function canonical(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonical);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}

function seal(value)
{
    return digest(JSON.stringify(canonical(value)));
}

function git(root, args)
{
    const result = spawnSync('git', ['-C', root, ...args], {
        encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
    });
    if (result.status !== 0)
    {
        throw new Error('author-search-inventory-git-unavailable');
    }
    return result.stdout;
}

function surfaceFor(file)
{
    if (/^(?:tests|benchmarks)\//u.test(file))
    {
        return 'test';
    }
    if (/^(?:docs|records)\//u.test(file) || /\.md$/u.test(file))
    {
        return 'documentation';
    }
    if (/^(?:artifacts|reports)\//u.test(file) || /(?:^|\/)(?:generated|vendor)\//u.test(file))
    {
        return 'evidence-or-generated';
    }
    if (/^src\//u.test(file))
    {
        return 'runtime-source';
    }
    return 'configuration-or-tooling';
}

function ownerFor(file, source)
{
    const hasAuthor = /AuthorFullText|author-full-text|global-author-search|author-search\.current/u.test(source);
    const hasEntity = /quick-switcher|QuickSwitcher|entity-navigation/u.test(source);
    if (hasAuthor && hasEntity)
    {
        return { classification: 'mixed-or-shared', owner: null, disposition: 'review-required' };
    }
    if (hasAuthor)
    {
        return { classification: 'author-content-search', owner: '#2318/#2319', disposition: 'consume-canonical-owner' };
    }
    if (hasEntity)
    {
        return { classification: 'article-entity-navigation', owner: '#2231/#2233', disposition: 'consume-canonical-owner' };
    }
    if (/^src\/frontend\//u.test(file)
        && /CollectionWorkbench/u.test(source) && /搜索文章标题/u.test(source))
    {
        return { classification: 'admin-collection-filter', owner: 'admin-article-collection', disposition: 'retain-owner-review-contract' };
    }
    if (/public-search|published-public-projection|PublicSearchRequestPolicy/u.test(source))
    {
        return { classification: 'public-search', owner: 'public-search', disposition: 'outside-author-cutover' };
    }
    if (/article-relation-index|resolved-link-facts/u.test(source))
    {
        return { classification: 'article-relations', owner: 'article-relations', disposition: 'outside-author-cutover' };
    }
    return { classification: 'unresolved', owner: null, disposition: 'review-required' };
}

/**
 * Discover candidates from every Git-owned or nonignored untracked file. Signals
 * are deliberately inclusive; classifications are proposals, never retirement
 * authorization. Output includes identities/locations only, never source lines.
 * The root must resolve to the Git worktree top level, never a partial subtree.
 */
export function createAuthorSearchInventory(repositoryRoot)
{
    const root = fs.realpathSync(repositoryRoot);
    const gitTopLevel = fs.realpathSync(git(root, ['rev-parse', '--show-toplevel']).replace(/\n$/u, ''));
    if (root !== gitTopLevel)
    {
        throw new Error('author-search-inventory-repository-root-required');
    }
    const repositoryRevision = git(root, ['rev-parse', 'HEAD']).trim();
    const paths = [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
        .split('\0').filter(Boolean))].sort();
    const files = [];
    const findings = [];
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (const file of paths)
    {
        const absolute = path.resolve(root, file);
        if (!absolute.startsWith(`${root}${path.sep}`))
        {
            throw new Error('author-search-inventory-outside-repository');
        }
        if (!fs.existsSync(absolute) && !fs.lstatSync(absolute, { throwIfNoEntry: false }))
        {
            files.push({ path: file, status: 'deleted', contentDigest: null, bytes: 0 });
            continue;
        }
        const stat = fs.lstatSync(absolute);
        if (!stat.isFile() || !fs.realpathSync(absolute).startsWith(`${root}${path.sep}`))
        {
            files.push({ path: file, status: 'nonregular-review-required', contentDigest: null, bytes: 0 });
            continue;
        }
        const bytes = fs.readFileSync(absolute);
        let source;
        try
        {
            source = decoder.decode(bytes);
        }
        catch
        {
            source = null;
        }
        if (source?.includes('\0'))
        {
            source = null;
        }
        const contentDigest = digest(bytes);
        files.push({ path: file, status: source === null ? 'binary' : 'scanned', contentDigest, bytes: bytes.length });
        if (source === null)
        {
            continue;
        }
        const owner = ownerFor(file, source);
        const surface = surfaceFor(file);
        const searchContext = /search|switcher|keyword|全文|搜索/iu.test(`${file}\n${source}`);
        const lineStarts = [0];
        for (let offset = source.indexOf('\n'); offset >= 0; offset = source.indexOf('\n', offset + 1))
        {
            lineStarts.push(offset + 1);
        }
        for (const [signal, pattern] of signals)
        {
            // Generic DOM/storage/fallback operations remain candidates when a
            // file contains search facts; they are not asserted to be a fallback.
            if (['rendered-search', 'durable-client-state', 'fallback-reference'].includes(signal) && !searchContext)
            {
                continue;
            }
            const lines = new Set();
            for (const match of source.matchAll(pattern))
            {
                let low = 0;
                let high = lineStarts.length;
                while (low < high)
                {
                    const middle = (low + high) >>> 1;
                    if (lineStarts[middle] <= match.index)
                    {
                        low = middle + 1;
                    }
                    else
                    {
                        high = middle;
                    }
                }
                lines.add(low);
            }
            for (const line of lines)
            {
                findings.push({ path: file, line, signal, surface, ...owner, contentDigest });
            }
        }
    }
    findings.sort((left, right) => left.path.localeCompare(right.path, 'en')
        || left.line - right.line || left.signal.localeCompare(right.signal, 'en'));
    const report = {
        schema: inventorySchema,
        repositoryRevision,
        qualification: false,
        status: 'inventory-only',
        files,
        findings,
        reviewRequired: findings.filter(finding => finding.disposition === 'review-required').length,
        nonregularFiles: files.filter(file => file.status === 'nonregular-review-required').length,
        rulesDigest: seal({ signals: signals.map(([id, pattern]) => [id, pattern.source, pattern.flags]) })
    };
    return { ...report, contentDigest: seal(report) };
}

/** Recompute the entire corpus; a resealed or omitted finding is still rejected. */
export function verifyAuthorSearchInventory(report, repositoryRoot)
{
    if (!report || report.schema !== inventorySchema)
    {
        return false;
    }
    return JSON.stringify(canonical(report)) === JSON.stringify(canonical(createAuthorSearchInventory(repositoryRoot)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
{
    const args = process.argv.slice(2);
    if (args.length > 1)
    {
        throw new Error('usage: node tools/governance/author-search-inventory.mjs [repository-root]');
    }
    console.log(JSON.stringify(createAuthorSearchInventory(args[0] ?? path.join(import.meta.dirname, '../..')), null, 4));
}
