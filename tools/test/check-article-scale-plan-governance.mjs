#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const backendRoot = 'src/backend';
const planOwnerRoot = 'src/backend/Services/Fixtures/DataScale';
const canonicalPlan = `${planOwnerRoot}/ArticleScalePlan.cs`;

function walkCSharp(repositoryRoot, relativeRoot)
{
    const directory = path.join(repositoryRoot, relativeRoot);
    if (!fs.existsSync(directory))
    {
        return [];
    }
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    {
        const relative = path.posix.join(relativeRoot, entry.name);
        if (entry.isDirectory())
        {
            return entry.name === 'bin' || entry.name === 'obj' ? [] : walkCSharp(repositoryRoot, relative);
        }
        return entry.isFile() && entry.name.endsWith('.cs') ? [relative] : [];
    });
}

function sourceMap(repositoryRoot, overlays)
{
    const sources = new Map(
        walkCSharp(repositoryRoot, backendRoot)
            .map((file) => [file, fs.readFileSync(path.join(repositoryRoot, file), 'utf8')])
    );
    for (const [file, source] of overlays)
    {
        const normalized = String(file).replaceAll('\\', '/');
        if (!normalized.startsWith(`${backendRoot}/`) || !normalized.endsWith('.cs'))
        {
            throw new Error(`article scale governance overlay is outside backend C# scope: ${file}`);
        }
        sources.set(normalized, String(source));
    }
    return sources;
}

function addViolation(violations, ruleId, file, message)
{
    violations.push({ ruleId, file, message });
}

function validateUniqueIdentity(sources, violations, pattern, ruleId, label)
{
    const declarations = [...sources].flatMap(([file, source]) =>
        [...source.matchAll(new RegExp(pattern.source, 'gu'))].map(() => file));
    if (declarations.length !== 1 || declarations[0] !== canonicalPlan)
    {
        addViolation(
            violations,
            ruleId,
            declarations.join(',') || canonicalPlan,
            `${label} must be declared exactly once by ${canonicalPlan}`
        );
    }
}

function containsStatusModulo(source)
{
    for (let index = source.indexOf('%'); index >= 0; index = source.indexOf('%', index + 1))
    {
        const window = source.slice(Math.max(0, index - 240), Math.min(source.length, index + 240));
        if (/\b(?:ArticleScaleVariant|ArticleStatus)\b/u.test(window)
            && /\b(?:id|articleId|articleOrdinal|ordinal|index)\b/iu.test(window))
        {
            return true;
        }
    }
    return false;
}

function containsArticleScaleContext(source)
{
    return /\bArticleScale\w*\b|\barticle[-_ ]scale\b|\bscale[-_ ]plan\b/iu.test(source);
}

export function scanArticleScalePlanGovernance(
    repositoryRoot = defaultRoot,
    { overlays = new Map() } = {})
{
    const sources = sourceMap(repositoryRoot, overlays);
    const violations = [];
    validateUniqueIdentity(
        sources,
        violations,
        /["']fsusblog\.article-scale-plan\.v\d+["']/u,
        'second-plan-schema',
        'article scale plan schema identity'
    );
    validateUniqueIdentity(
        sources,
        violations,
        /\brecord\s+ArticleScalePlan\b/u,
        'second-plan-type',
        'ArticleScalePlan type'
    );

    for (const [file, source] of sources)
    {
        if (containsStatusModulo(source))
        {
            addViolation(violations, 'status-modulo', file, 'state semantics must not derive from numeric modulo');
        }
        if (containsArticleScaleContext(source)
            && (/\bSimplifiedArticleGraph\w*\b/u.test(source)
            || /\b(?:Graph|Variant|Schema|Shape)\w*\s*(?:=|:)\s*["'][^"']*simplified[-_ ]*graph/iu.test(source))
        )
        {
            addViolation(violations, 'simplified-graph', file, 'simplified article graph declarations are forbidden');
        }
        if (containsArticleScaleContext(source)
            && /\b\w*(?:Hash|Digest)\w*\s*(?:=|:)\s*["'](?:placeholder|sentinel|[^"']*:recompute)["']/iu.test(source))
        {
            addViolation(violations, 'sentinel-hash', file, 'hash and digest declarations must not use placeholders or recompute sentinels');
        }
        if (containsArticleScaleContext(source) && /\b(?:Redis|Search|Aot|HotRead)\w*\b/iu.test(source))
        {
            addViolation(violations, 'manual-derived-state', file, 'scale plans must bind production edge obligations without manual derived-state declarations');
        }
    }

    return {
        schema: 'fsusblog.article-scale-plan-governance.v1',
        status: violations.length === 0 ? 'verified' : 'failed',
        canonicalPlan,
        scannedBackendFiles: sources.size,
        violations: violations.toSorted((left, right) =>
            `${left.ruleId}:${left.file}`.localeCompare(`${right.ruleId}:${right.file}`))
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const result = scanArticleScalePlanGovernance();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'verified')
    {
        process.exitCode = 1;
    }
}
