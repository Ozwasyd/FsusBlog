#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const serviceRoot = 'src/backend/Services/Authoring';
const resolverFile = `${serviceRoot}/AuthoringCanvasReferenceResolver.cs`;
const factSourceFile = `${serviceRoot}/AuthoringCanvasReferenceFactSource.cs`;
const verifierFile = `${serviceRoot}/AuthoringCanvasReferenceVerifier.cs`;
const authorities = new Map([
    ['AuthoringCanvasReferenceResolver', resolverFile],
    ['AuthoringCanvasReferenceFactSource', factSourceFile],
    ['PostgresAuthoringCanvasArticleReferenceReader', factSourceFile],
    ['AuthoringCanvasReferenceProjectionCache', resolverFile],
    ['AuthoringCanvasReferenceVerifier', verifierFile]
]);

function walk(directory, extensions)
{
    if (!existsSync(directory))
    {
        return [];
    }
    const files = [];
    const pending = [directory];
    while (pending.length > 0)
    {
        const current = pending.pop();
        for (const entry of readdirSync(current, { withFileTypes: true }))
        {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory())
            {
                pending.push(absolute);
            }
            else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)))
            {
                files.push(absolute);
            }
        }
    }
    return files.sort();
}

function codeOnly(source)
{
    return source
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/\/\/.*$/gmu, '');
}

function count(source, pattern)
{
    return (source.match(pattern) ?? []).length;
}

export function checkAuthoringCanvasReferenceAuthority(repositoryRoot = root)
{
    const violations = [];
    const backendFiles = walk(path.join(repositoryRoot, serviceRoot), ['.cs']);
    const sources = new Map(backendFiles.map((absolute) => [
        path.relative(repositoryRoot, absolute),
        readFileSync(absolute, 'utf8')
    ]));

    for (const [className, expectedFile] of authorities)
    {
        const declaration = new RegExp(`\\bclass\\s+${className}\\b`, 'u');
        const owners = [...sources]
            .filter(([, source]) => declaration.test(codeOnly(source)))
            .map(([relative]) => relative);
        if (owners.length !== 1 || owners[0] !== expectedFile)
        {
            violations.push(
                `expected exact-one ${className} in ${expectedFile}, found ${owners.join(', ') || '<none>'}`);
        }
    }

    if (![resolverFile, factSourceFile, verifierFile].every((relative) => sources.has(relative)))
    {
        return violations;
    }
    const resolver = codeOnly(sources.get(resolverFile));
    const factSource = codeOnly(sources.get(factSourceFile));
    const verifier = codeOnly(sources.get(verifierFile));
    const referenceSources = [...sources]
        .filter(([relative, source]) => relative.includes('AuthoringCanvasReference')
            || /\bPinnedTargetRevision\b/u.test(source))
        .map(([, source]) => codeOnly(source))
        .join('\n');

    if (count(resolver, /factSource\.ReadBatchAsync\s*\(/gu) !== 1)
    {
        violations.push(`${resolverFile}: resolver must issue exact-one bounded fact-source batch read path`);
    }
    if (count(verifier, /factSource\.ReadBatchAsync\s*\(/gu) !== 1
        || count(verifier, /factSource\.ReadAuthorityCoordinateAsync\s*\(/gu) !== 1)
    {
        violations.push(`${verifierFile}: verifier must independently read exact-one authority and fact batch`);
    }
    if (/\b(?:ResolveCoreAsync|ResolveAsync)\s*\(/u.test(verifier)
        || /\b(?:cache|projectionCache)\s*\.(?:TryGet|Set)\s*\(/iu.test(verifier))
    {
        violations.push(`${verifierFile}: verifier must not call the resolver or projection cache`);
    }
    if (/\.Select\s*\([^)]*(?:async\s*)?[^)]*=>[\s\S]{0,500}?\bReadBatchAsync\s*\(/u
        .test(referenceSources))
    {
        violations.push('canvas reference authority must not issue N+1 batch reads');
    }
    if (/\b(?:string|byte\[\]|ReadOnlyMemory<byte>|JsonElement)\s+(?:Article)?(?:Body|Html|Dom|RenderedHtml)\b/u
        .test(referenceSources))
    {
        violations.push('canvas reference authority must not admit article body, HTML, or DOM payloads');
    }
    if (/(?:First|Single)(?:OrDefault)?\s*\([^)]*(?:Title|Hash)|(?:Title|Hash)\s*(?:==|!=)|(?:Title|Hash)\.Equals\s*\(/u
        .test(referenceSources))
    {
        violations.push('canvas reference identity must not fall back to title or hash matching');
    }
    if (/PinnedTargetRevision\s*=\s*(?:[A-Za-z0-9_]+\.)?CurrentRevision\b/u.test(referenceSources))
    {
        violations.push('pinned references must not be silently replaced with the latest revision');
    }

    const clientFiles = walk(path.join(repositoryRoot, 'src/frontend'), ['.ts', '.tsx', '.js', '.vue']);
    for (const absolute of clientFiles)
    {
        const relative = path.relative(repositoryRoot, absolute);
        const source = codeOnly(readFileSync(absolute, 'utf8'));
        if (/(?:AuthoringCanvasReference|canvasReference|canvas[-_ ]reference)/iu.test(source)
            && /(?:\.filter|\.find|\.some|\.every)\s*\([^)]*permission|permission[^\n]{0,120}(?:filter|allow|deny)/iu
                .test(source))
        {
            violations.push(`${relative}: client-side canvas reference permission filtering is forbidden`);
        }
    }

    return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const violations = checkAuthoringCanvasReferenceAuthority();
    if (violations.length > 0)
    {
        console.error('[authoring-canvas-reference-authority] failed');
        for (const violation of violations)
        {
            console.error(`- ${violation}`);
        }
        process.exitCode = 1;
    }
    else
    {
        console.log('[authoring-canvas-reference-authority] passed: exact-one resolver/source/reader/cache/verifier, independent bounded verification, stable identity and permission boundaries');
    }
}
