#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contractsFile = 'src/core/Services/Articles/RevisionCompareContracts.cs';
const plannerFile = 'src/core/Services/Articles/RevisionComparePlanner.cs';
const readerFile = 'src/backend/Services/Authoring/AuthoringRevisionComparePackageReader.cs';
const registrationFile = 'src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs';
const requiredFiles = [contractsFile, plannerFile, readerFile, registrationFile];

function toPosix(value)
{
    return value.replaceAll(path.sep, '/');
}

function walkSource(directory)
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
            else if (entry.isFile() && /\.(?:cs|js|jsx|ts|tsx|vue)$/u.test(entry.name))
            {
                files.push(absolute);
            }
        }
    }
    return files.sort();
}

export function readRevisionCompareSources(root = repositoryRoot)
{
    return new Map(walkSource(path.join(root, 'src')).map((absolute) => [
        toPosix(path.relative(root, absolute)),
        readFileSync(absolute, 'utf8')
    ]));
}

function countMatches(source, pattern)
{
    return [...source.matchAll(pattern)].length;
}

export function checkRevisionCompareAuthoritySources(sources)
{
    const violations = [];
    for (const relative of requiredFiles)
    {
        if (!sources.has(relative))
        {
            violations.push(`required authority file missing: ${relative}`);
        }
    }
    if (violations.length > 0)
    {
        return violations;
    }

    const relevant = [...sources.entries()].filter(([, source]) =>
        /\bRevisionCompare\b|RevisionCompare|revision(?:Compare|_compare|-compare)/u.test(source));
    const planners = [];
    const readers = [];
    const metadataAuthorities = [];
    for (const [relative, source] of relevant)
    {
        const authorityScoped = /revision(?:compare|[-_]compare)/iu.test(path.basename(relative))
            || /\b(?:class|record|interface)\s+[A-Za-z0-9_]*RevisionCompare[A-Za-z0-9_]*\b/u.test(source);
        for (const match of source.matchAll(
            /\bclass\s+([A-Za-z0-9_]*RevisionCompare[A-Za-z0-9_]*Planner[A-Za-z0-9_]*)\b/gu))
        {
            planners.push(`${relative}:${match[1]}`);
        }
        const readerCount = countMatches(source, /:\s*IRevisionComparePackageReader\b/gu);
        for (let index = 0; index < readerCount; index++)
        {
            readers.push(relative);
        }
        for (const match of source.matchAll(
            /\b(?:class|record|interface)\s+([A-Za-z0-9_]*RevisionCompareMetadata[A-Za-z0-9_]*(?:Registry|Map|Authority)[A-Za-z0-9_]*)\b/gu))
        {
            metadataAuthorities.push(`${relative}:${match[1]}`);
        }

        if (authorityScoped)
        {
            const forbidden = [
                ['rendered HTML or DOM authority', /\b(?:RenderedHtml|HtmlDocument|DocumentFragment|innerHTML|outerHTML|querySelector)\b/u],
                ['browser-local authority', /\b(?:localStorage|sessionStorage|indexedDB|IJSRuntime)\b/u],
                ['latest revision scan', /\b(?:GetLatestRevision|LatestRevision|latestRevision)\b|\bOrderByDescending\s*\([^)]*(?:RevisionId|RevisionNo)/u]
            ];
            for (const [label, pattern] of forbidden)
            {
                if (pattern.test(source))
                {
                    violations.push(`${relative}: ${label} is forbidden for revision compare authority`);
                }
            }
        }

        if (authorityScoped
            && relative.startsWith('src/frontend/')
            && /\b(?:const|let|var)\s+[A-Za-z0-9_]*metadata[A-Za-z0-9_]*\s*=\s*(?:new\s+Map\b|\{|\[)/iu.test(source))
        {
            violations.push(`${relative}: UI metadata map is forbidden for revision compare authority`);
        }
    }

    const expectedPlanner = `${plannerFile}:RevisionComparePlanner`;
    if (planners.length !== 1 || planners[0] !== expectedPlanner)
    {
        violations.push(`expected exact-one revision compare planner ${expectedPlanner}; found ${planners.join(', ') || '<none>'}`);
    }
    if (readers.length !== 1 || readers[0] !== readerFile)
    {
        violations.push(`expected exact-one revision compare package reader ${readerFile}; found ${readers.join(', ') || '<none>'}`);
    }
    const expectedMetadata = `${contractsFile}:RevisionCompareMetadataRegistry`;
    if (metadataAuthorities.length !== 1 || metadataAuthorities[0] !== expectedMetadata)
    {
        violations.push(`expected exact-one revision compare metadata authority ${expectedMetadata}; found ${metadataAuthorities.join(', ') || '<none>'}`);
    }

    const plannerSource = sources.get(plannerFile);
    if (!/basePackage\.ArticleId\s*!=\s*comparePackage\.ArticleId/u.test(plannerSource)
        || !/basePackage\.ArticleId\s*!=\s*request\.ArticleId/u.test(plannerSource))
    {
        violations.push(`${plannerFile}: exact cross-article admission guard is required`);
    }

    const readerSource = sources.get(readerFile);
    if (!/draft\.ArticleId\s*!=\s*articleId/u.test(readerSource)
        || !/revision\.ArticleId\s*!=\s*articleId/u.test(readerSource))
    {
        violations.push(`${readerFile}: draft and revision article-coordinate guards are required`);
    }

    const registrationSource = sources.get(registrationFile);
    const registrations = [
        'AddScoped<IAuthoringRevisionCompareAuthority, AuthoringRevisionCompareAuthority>',
        'AddScoped<IAuthoringRevisionCompareDraftContextAuthority, AuthoringRevisionCompareDraftContextAuthority>',
        'AddScoped<IRevisionComparePackageReader, AuthoringRevisionComparePackageReader>',
        'AddScoped<RevisionComparePlanner>',
        'AddScoped<RevisionComparePlanVerifier>'
    ];
    for (const registration of registrations)
    {
        const count = registrationSource.split(registration).length - 1;
        if (count !== 1)
        {
            violations.push(`${registrationFile}: expected exact-one ${registration}; found ${count}`);
        }
    }

    return violations;
}

export function checkRevisionCompareAuthority(root = repositoryRoot)
{
    return checkRevisionCompareAuthoritySources(readRevisionCompareSources(root));
}

function main()
{
    const violations = checkRevisionCompareAuthority();
    if (violations.length > 0)
    {
        process.stderr.write(`[revision-compare-authority] failed\n${violations.map((item) => `- ${item}`).join('\n')}\n`);
        process.exitCode = 1;
        return;
    }
    process.stdout.write('[revision-compare-authority] ok\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
