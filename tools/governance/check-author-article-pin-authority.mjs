#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const authorityFile = 'src/backend/Services/Authoring/AuthorArticlePinStore.cs';
const contractFile = 'src/backend/Services/Authoring/AuthorArticlePinContracts.cs';
const migrationFile = 'src/migration/Definitions/AuthorArticlePinMigrationDefinitions.cs';
const registrationFile = 'src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs';

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
            else if (entry.isFile() && /\.(?:cs|ts|vue)$/u.test(entry.name))
            {
                files.push(absolute);
            }
        }
    }
    return files.sort();
}

export function checkAuthorArticlePinAuthority(repositoryRoot = root)
{
    const violations = [];
    for (const relative of [authorityFile, contractFile, migrationFile, registrationFile])
    {
        if (!existsSync(path.join(repositoryRoot, relative)))
        {
            violations.push(`required authority file missing: ${relative}`);
        }
    }
    if (violations.length > 0)
    {
        return violations;
    }

    const pinFiles = walk(path.join(repositoryRoot, 'src')).filter((absolute) =>
        /AuthorArticlePin|author_article_pin|article[-_ ]?pins?/iu.test(readFileSync(absolute, 'utf8')));
    const storeClasses = pinFiles.flatMap((absolute) =>
    {
        const source = readFileSync(absolute, 'utf8');
        return [...source.matchAll(/\b(?:sealed\s+)?class\s+([A-Za-z0-9_]*AuthorArticlePin[A-Za-z0-9_]*Store)\b/gu)]
            .map((match) => `${path.relative(repositoryRoot, absolute)}:${match[1]}`);
    });
    if (storeClasses.length !== 1
        || storeClasses[0] !== `${authorityFile}:AuthorArticlePinStore`)
    {
        violations.push(`expected exact-one article pin store, found ${storeClasses.join(', ') || '<none>'}`);
    }

    for (const absolute of pinFiles)
    {
        const relative = path.relative(repositoryRoot, absolute);
        const source = readFileSync(absolute, 'utf8');
        if (/\b(?:localStorage|sessionStorage|indexedDB)\b/u.test(source))
        {
            violations.push(`${relative}: browser-local pin authority is forbidden`);
        }
        if (/\b(?:FavoriteTag|FavoriteStatus|Hotness|LikeCount|PublicRank)\b/u.test(source))
        {
            violations.push(`${relative}: favorite/public-ranking metadata authority is forbidden`);
        }
    }

    const contractSource = readFileSync(path.join(repositoryRoot, contractFile), 'utf8');
    if (/\b(?:Title|Slug|Url|SourceHash|ArrayIndex|DisplayLabel)\b/u.test(contractSource))
    {
        violations.push(`${contractFile}: title/slug/url/source/index/display identity is forbidden`);
    }
    const authoritySource = readFileSync(path.join(repositoryRoot, authorityFile), 'utf8');
    const writeTargets = [...authoritySource.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/giu)]
        .map((match) => match[1].toLowerCase());
    const foreignWrites = writeTargets.filter((table) => !table.startsWith('author_article_pin'));
    if (foreignWrites.length > 0)
    {
        violations.push(`${authorityFile}: non-pin writes are forbidden (${[...new Set(foreignWrites)].join(', ')})`);
    }
    if (!/SET\s+order_key\s*=\s*CASE\s+article_id[\s\S]*article_id\s+IN\s*\(/u.test(authoritySource))
    {
        violations.push(`${authorityFile}: reorder must remain one bounded set-based update`);
    }
    if (!/authenticated admin[\s\S]*configured site scope[\s\S]*may come from request payload/u.test(authoritySource))
    {
        violations.push(`${authorityFile}: trusted caller identity/site binding must remain explicit`);
    }

    const registrationSource = readFileSync(path.join(repositoryRoot, registrationFile), 'utf8');
    const registrations = registrationSource.match(
        /AddScoped<IAuthorArticlePinStore,\s*AuthorArticlePinStore>/gu) ?? [];
    if (registrations.length !== 1)
    {
        violations.push('AuthorArticlePinStore must have exactly one runtime DI registration');
    }
    return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const violations = checkAuthorArticlePinAuthority();
    if (violations.length > 0)
    {
        console.error('[author-article-pin-authority] failed');
        for (const violation of violations)
        {
            console.error(`- ${violation}`);
        }
        process.exitCode = 1;
    }
    else
    {
        console.log('[author-article-pin-authority] passed: exact-one server store, stable identity, bounded set ordering, no local/public/metadata authority');
    }
}
