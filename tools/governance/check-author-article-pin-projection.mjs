#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contractFile = 'src/backend/Services/Authoring/AuthorArticlePinProjectionContracts.cs';
const serviceFile = 'src/backend/Services/Authoring/AuthorArticlePinProjectionService.cs';
const verifierFile = 'src/backend/Services/Authoring/AuthorArticlePinProjectionVerifier.cs';
const sourceFile = 'src/backend/Services/Authoring/SqlAuthorArticlePinArticleProjectionSource.cs';

function walk(directory)
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
            else if (entry.isFile() && /\.(?:cs|ts|tsx|vue)$/u.test(entry.name))
            {
                files.push(absolute);
            }
        }
    }
    return files.sort();
}

export function checkAuthorArticlePinProjection(repositoryRoot = root)
{
    const violations = [];
    for (const relative of [contractFile, serviceFile, verifierFile, sourceFile])
    {
        if (!existsSync(path.join(repositoryRoot, relative)))
        {
            violations.push(`required projection file missing: ${relative}`);
        }
    }
    if (violations.length > 0)
    {
        return violations;
    }

    const sourceFiles = walk(path.join(repositoryRoot, 'src'));
    const projectionClasses = sourceFiles.flatMap((absolute) =>
    {
        const source = readFileSync(absolute, 'utf8');
        return [...source.matchAll(/\b(?:sealed\s+)?class\s+([A-Za-z0-9_]*AuthorArticlePinProjectionService)\b/gu)]
            .map((match) => `${path.relative(repositoryRoot, absolute)}:${match[1]}`);
    });
    if (projectionClasses.length !== 1
        || projectionClasses[0] !== `${serviceFile}:AuthorArticlePinProjectionService`)
    {
        violations.push(`expected exact-one article pin projection service, found ${projectionClasses.join(', ') || '<none>'}`);
    }
    const projectionRoutes = sourceFiles.flatMap((absolute) =>
    {
        const source = readFileSync(absolute, 'utf8');
        return [...source.matchAll(/\bMapGet\s*\(\s*"[^"]*article-pins[^"]*"/giu)]
            .map(() => path.relative(repositoryRoot, absolute));
    });
    if (projectionRoutes.length > 1)
    {
        violations.push(`article pin projection may expose at most one transport route, found ${projectionRoutes.length}`);
    }

    const contract = readFileSync(path.join(repositoryRoot, contractFile), 'utf8');
    const service = readFileSync(path.join(repositoryRoot, serviceFile), 'utf8');
    const verifier = readFileSync(path.join(repositoryRoot, verifierFile), 'utf8');
    const articleSource = readFileSync(path.join(repositoryRoot, sourceFile), 'utf8');
    const projectionSources = [contract, service, verifier, articleSource].join('\n');
    if (/\b(?:PublicRank|Hotness|LikeCount|ViewCount|Views|FavoriteStatus|PinnedBoost|RecommendationScore)\b/u.test(projectionSources))
    {
        violations.push(`${contractFile}: public ranking/hotness projection is forbidden`);
    }
    if (/record\s+AuthorArticlePinProjectionRequest\([^)]*\b(?:CanProject|CanOpen|IsAllowed|HasPermission)\b/su.test(contract))
    {
        violations.push(`${contractFile}: caller-provided permission decisions are forbidden`);
    }
    const permissionRead = service.indexOf('permissionProvider.ResolveAsync');
    const articleRead = service.indexOf('articleSource.ReadCurrentBatchAsync');
    if (permissionRead < 0 || articleRead < 0 || permissionRead > articleRead
        || !/Where\(static decision => decision\.CanProject\)[\s\S]*ReadCurrentBatchAsync\(visibleArticleIds/u.test(service))
    {
        violations.push(`${serviceFile}: permission filter must precede the single article batch read`);
    }
    if (!/OrderBy\(static pin => pin\.OrderKey\)[\s\S]*ThenBy\(static pin => pin\.PinId\)/u.test(service)
        || /OrderBy\(static pin => pin\.(?:ArticleId|Title|Status|PublicRank|Hotness)\)/u.test(service)
        || /OrderBy\(static (?:item|fact) => (?:item|fact)\.(?:Title|Status|PublicRank|Hotness)\)/u.test(service))
    {
        violations.push(`${serviceFile}: projection order must come only from server pin ordering`);
    }
    if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/iu.test(service))
    {
        violations.push(`${serviceFile}: projection must not implement pin or article writes`);
    }
    if (!/WHERE a\.id = ANY\(CAST\(@ArticleIds AS integer\[\]\)\)/u.test(articleSource)
        || !/new SugarParameter\("@ArticleIds", FormatIntegerArray\(articleIds\)\)/u.test(articleSource)
        || /WHERE a\.(?:title|slug)\s*=\s*ANY/iu.test(articleSource))
    {
        violations.push(`${sourceFile}: article resolution must be one stable-id batch query`);
    }

    for (const absolute of sourceFiles.filter((file) => /[/\\]src[/\\]frontend[/\\]/u.test(file)))
    {
        const source = readFileSync(absolute, 'utf8');
        if (!/article[-_ ]?pins?|AuthorArticlePin/iu.test(source))
        {
            continue;
        }
        const relative = path.relative(repositoryRoot, absolute);
        if (/\b(?:CanProject|CanOpen|HasPermission|permissionFilter)\b/u.test(source))
        {
            violations.push(`${relative}: client-side article pin permission filtering is forbidden`);
        }
        if (/\.(?:sort|toSorted)\s*\(/u.test(source))
        {
            violations.push(`${relative}: client-side article pin reorder is forbidden`);
        }
        if (/\b(?:PublicRank|Hotness|LikeCount|ViewCount|Views|FavoriteStatus|PinnedBoost|RecommendationScore)\b/u.test(source))
        {
            violations.push(`${relative}: public ranking/hotness pin signal is forbidden`);
        }
        if (/(?:find|filter)\s*\([^)]*\b(?:Title|Slug)\b|\b(?:Title|Slug)\b[\s\S]*(?:find|filter)\s*\(/u.test(source))
        {
            violations.push(`${relative}: title/slug article pin rebind is forbidden`);
        }
    }
    return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const violations = checkAuthorArticlePinProjection();
    if (violations.length > 0)
    {
        console.error('[author-article-pin-projection] failed');
        for (const violation of violations)
        {
            console.error(`- ${violation}`);
        }
        process.exitCode = 1;
    }
    else
    {
        console.log('[author-article-pin-projection] passed: exact-one server-filtered stable-id batch projection with server ordering');
    }
}
