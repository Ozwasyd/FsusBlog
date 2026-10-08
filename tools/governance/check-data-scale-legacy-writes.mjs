#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requiredEntries = ['tools/data-scale/seed.sh', 'tools/data-scale/cleanup.sh'];
const scanRoots = ['tools/data-scale', 'tests/tools/scale'];
const sourceExtensions = new Set(['.sh', '.sql', '.mjs', '.cs']);

// This is a residual-write diagnostic. An empty result is not provider parity,
// a complete graph proof, a performance receipt, or terminal acceptance.
const rules = [
    ['private-article-write', /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?:article|article_body|article_tag|article_revision(?:_content_block)?|article_rights_(?:policy|snapshot|proof)|article_responsibility_snapshot|article_publication|article_mutation_outbox(?:_event|_edge)?)"?(?=[\s(;]|$)/giu],
    ['status-modulo', /\bWHEN\s+[^;\n]*%\s*\d+\s*=\s*\d+\s+THEN\s+\d+\b/giu],
    ['manual-derived-write', /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?:article_public_taxonomy_projection|category_public_article_count|tag_public_article_count)"?(?=[\s(;]|$)/giu],
    ['manual-redis-write', /\bredis-cli\b[^\n]*\b(?:SET|MSET|HSET|HDEL|INCR|DECR|DEL|UNLINK|FLUSHDB|FLUSHALL|EVAL)\b/giu],
    ['guessed-owned-article-rows', /\b(?:title|createtime|create_time|published_at|status)\s+LIKE\s*\(/giu],
    ['sentinel-hash', /["'](?:recompute|rights-sentinel|sentinel-hash)["']/giu],
    ['private-policy-hash', /\bsha256\s*\(\s*convert_to\s*\(\s*'data-scale-policy:/giu]
];

function collectSources(root, relative, files)
{
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute))
    {
        return;
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink())
    {
        throw new Error(`data_scale_scan_symlink_refused:${relative}`);
    }
    if (stat.isDirectory())
    {
        for (const entry of fs.readdirSync(absolute).sort())
        {
            collectSources(root, path.posix.join(relative, entry), files);
        }
    }
    else if (sourceExtensions.has(path.extname(relative)))
    {
        files.add(relative);
    }
}

export function scanDataScaleLegacyWrites(root = repositoryRoot)
{
    const violations = [];
    const files = new Set();
    for (const relative of requiredEntries)
    {
        if (!fs.existsSync(path.join(root, relative)))
        {
            violations.push({ file: relative, line: 1, rule: 'missing-entry' });
        }
    }
    for (const relative of scanRoots)
    {
        collectSources(root, relative, files);
    }

    const sources = [];
    for (const relative of [...files].sort())
    {
        const bytes = fs.readFileSync(path.join(root, relative));
        const source = bytes.toString('utf8');
        sources.push({ file: relative, digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` });
        for (const [rule, pattern] of rules)
        {
            for (const match of source.matchAll(pattern))
            {
                violations.push({ file: relative, line: source.slice(0, match.index).split('\n').length, rule });
            }
        }
    }
    violations.sort((left, right) => left.file.localeCompare(right.file)
        || left.line - right.line || left.rule.localeCompare(right.rule));
    return {
        schema: 'fsusblog.data-scale-legacy-write-diagnostic.v1',
        status: violations.length === 0 ? 'clear' : 'failed',
        scope: scanRoots,
        sources,
        violations
    };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
{
    const result = scanDataScaleLegacyWrites();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.violations.length === 0 ? 0 : 1;
}
