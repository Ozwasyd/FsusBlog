#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const authorityFile = 'src/backend/Services/Authoring/AuthoringCanvasDocumentStore.cs';
const contractFile = 'src/shared/Contracts/AuthoringCanvas/AuthoringCanvasDocumentContracts.cs';
const migrationFile = 'src/migration/Definitions/AuthoringCanvasDocumentMigrationDefinitions.cs';

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

export function checkAuthoringCanvasAuthority(repositoryRoot = root)
{
    const violations = [];
    const required = [authorityFile, contractFile, migrationFile];
    for (const relative of required)
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

    const sourceFiles = walk(path.join(repositoryRoot, 'src'));
    const canvasFiles = sourceFiles.filter((absolute) =>
    {
        const source = readFileSync(absolute, 'utf8');
        return /authoring[-_ ]?canvas/iu.test(source) || /AuthoringCanvas/u.test(source);
    });
    const authorityClasses = canvasFiles.flatMap((absolute) =>
    {
        const source = readFileSync(absolute, 'utf8');
        return [...source.matchAll(/\b(?:sealed\s+)?class\s+([A-Za-z0-9_]*AuthoringCanvas[A-Za-z0-9_]*(?:Store|Repository))\b/gu)]
            .map((match) => `${path.relative(repositoryRoot, absolute)}:${match[1]}`);
    });
    if (authorityClasses.length !== 1
        || authorityClasses[0] !== `${authorityFile}:AuthoringCanvasDocumentStore`)
    {
        violations.push(`expected exact-one canvas store, found ${authorityClasses.join(', ') || '<none>'}`);
    }

    for (const absolute of canvasFiles)
    {
        const relative = path.relative(repositoryRoot, absolute);
        const source = readFileSync(absolute, 'utf8');
        if (/\b(?:localStorage|sessionStorage|indexedDB)\b/u.test(source))
        {
            violations.push(`${relative}: browser-local canvas authority is forbidden`);
        }
        if (/\b(?:RenderedHtml|RenderDom|PluginPayload|VueComponent|GlobalCss|ArbitraryStyles|UrlEmbed)\b/u.test(source))
        {
            violations.push(`${relative}: arbitrary executable or presentation payload field is forbidden`);
        }
        if (/\b(?:GraphPosition|TransientGraphPosition)\b/u.test(source))
        {
            violations.push(`${relative}: graph position reuse is forbidden`);
        }
    }

    const authoritySource = readFileSync(path.join(repositoryRoot, authorityFile), 'utf8');
    if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:article|relation|property|graph_)/iu.test(authoritySource))
    {
        violations.push(`${authorityFile}: article/relation/property/graph writes are forbidden`);
    }
    const canvasTables = [...authoritySource.matchAll(/\b(?:FROM|INTO|UPDATE|DELETE\s+FROM)\s+(authoring_canvas_[a-z_]+)/gu)]
        .map((match) => match[1]);
    if (canvasTables.length === 0)
    {
        violations.push(`${authorityFile}: server authority must persist normalized canvas tables`);
    }

    const registrationFile = path.join(
        repositoryRoot,
        'src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs');
    const registrationSource = readFileSync(registrationFile, 'utf8');
    const registrations = registrationSource.match(
        /AddScoped<IAuthoringCanvasDocumentStore,\s*AuthoringCanvasDocumentStore>/gu) ?? [];
    if (registrations.length !== 1)
    {
        violations.push('AuthoringCanvasDocumentStore must have exactly one runtime DI registration');
    }

    return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const violations = checkAuthoringCanvasAuthority();
    if (violations.length > 0)
    {
        console.error('[authoring-canvas-authority] failed');
        for (const violation of violations)
        {
            console.error(`- ${violation}`);
        }
        process.exitCode = 1;
    }
    else
    {
        console.log('[authoring-canvas-authority] passed: exact-one server store, closed payload boundary, no local/second/relation/graph authority');
    }
}
