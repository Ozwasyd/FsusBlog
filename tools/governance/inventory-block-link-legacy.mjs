#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const probes = [
    ['caret-url', /#\^[a-zA-Z0-9_-]*/gu],
    ['wikilink', /\[\[[^\]\r\n]*\]\]/gu],
    ['attribute-anchor', /\{#[^}\r\n]+\}/gu],
    ['html-anchor', /<(?:[a-z][a-z0-9-]*)\b[^>\r\n]*\bid\s*=/giu],
    ['sidecar-identity', /(?:sidecar|database|db)[\w -]{0,40}(?:anchor|block)|(?:anchor|block)[\w -]{0,40}(?:sidecar|database|db)/giu],
    ['derived-identity', /(?:hash|offset|dom|text)[\w -]{0,40}(?:anchor|target)|(?:anchor|target)[\w -]{0,40}(?:hash|offset|dom|text)/giu],
    ['anchor-scanner', /(?:regex|scan|querySelector)[\w .-]{0,60}(?:anchor|block)|(?:anchor|block)[\w .-]{0,60}(?:regex|scan|querySelector)/giu],
    ['automatic-anchor', /(?:auto|random|ai)[\w -]{0,30}(?:anchor|suffix)|(?:anchor|suffix)[\w -]{0,30}(?:auto|random|ai)/giu],
    ['refactor-fallback', /(?:global|history|historical|dynamic)[\w -]{0,40}(?:replace|rewrite|requery)/giu],
    ['anchor-reference', /anchor[a-z0-9_-]*/giu],
    ['block-identity', /(?:blockId|block_id|BlockId|BlockAnchor|block-anchor|block-link)/gu]
];
const digest = value => createHash('sha256').update(value).digest('hex');

/** Candidates require owner review; mention counts do not establish active runtime residue. */
export function inventoryBlockLinkLegacySources(sources)
{
    const entries = [];
    for (const [file, source] of [...sources].sort(([left], [right]) => left.localeCompare(right)))
    {
        const sourceDigest = digest(source);
        const lines = [0];
        let newline = source.indexOf('\n');
        while (newline !== -1)
        {
            lines.push(newline + 1);
            newline = source.indexOf('\n', newline + 1);
        }
        const lineAt = offset =>
        {
            let low = 0;
            let high = lines.length;
            while (low < high)
            {
                const middle = Math.floor((low + high) / 2);
                if (lines[middle] <= offset)
                {
                    low = middle + 1;
                }
                else
                {
                    high = middle;
                }
            }
            return low;
        };
        for (const [category, pattern] of probes)
        {
            pattern.lastIndex = 0;
            for (const match of source.matchAll(pattern))
            {
                entries.push({
                    path: file,
                    sourceDigest,
                    category,
                    line: lineAt(match.index),
                    start: match.index,
                    end: match.index + match[0].length,
                    matchDigest: digest(match[0]),
                    classification: 'unreviewed'
                });
            }
        }
    }
    return {
        schema: 'fsusblog.block-link-legacy-inventory.v1',
        scannedFiles: sources.size,
        entries,
        unresolvedCandidates: entries.length,
        deletionAuthorized: false,
        issueAcceptance: false,
        contentDigest: digest(JSON.stringify(entries))
    };
}

function git(...args)
{
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0)
    {
        throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    }
    return result.stdout;
}

export function readBlockLinkInventoryRevision(revision = 'HEAD')
{
    const commit = git('rev-parse', '--verify', `${revision}^{commit}`).trim();
    const files = git('ls-tree', '-rz', commit).split('\0').filter(Boolean);
    const sources = new Map();
    const skipped = [];
    for (const file of files)
    {
        const [metadata, filePath] = file.split('\t');
        if (!/\.(?:cs|cpp|hpp|h|c|ts|tsx|vue|js|mjs|cjs|json|md|yml|yaml|sql|sh|xml|html|cshtml|razor|scss|css|svg|py|rs|lua|ps1|txt|proto)$/u.test(filePath))
        {
            continue;
        }
        const [mode, type, objectId] = metadata.split(' ');
        if (type !== 'blob' || !['100644', '100755'].includes(mode))
        {
            skipped.push({ path: filePath, reason: 'nonregular-source' });
            continue;
        }
        sources.set(filePath, git('cat-file', 'blob', objectId));
    }
    return { ...inventoryBlockLinkLegacySources(sources), commit, skipped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const args = process.argv.slice(2);
    if (args.length !== 2)
    {
        throw new Error('usage: inventory-block-link-legacy.mjs <exact-revision> <output.json>');
    }
    const result = readBlockLinkInventoryRevision(args[0]);
    writeFileSync(args[1], `${JSON.stringify(result, null, 4)}\n`, { flag: 'wx' });
    console.log(`Block-link inventory ${result.commit}: files=${result.scannedFiles}, unreviewed=${result.unresolvedCandidates}, skipped=${result.skipped.length}`);
}
