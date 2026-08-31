import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { maskCSharp } from '../architecture/backend-physical-topology/csharp-mask.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function repositoryPath(file)
{
    return path.relative(root, file).split(path.sep).join('/');
}

function sourceFiles(directory)
{
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
    {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory() && !['bin', 'obj', 'node_modules'].includes(entry.name))
        {
            files.push(...sourceFiles(absolute));
        }
        else if (entry.isFile() && entry.name.endsWith('.cs'))
        {
            files.push(absolute);
        }
    }
    return files.sort();
}

function matchingBrace(source, open)
{
    let depth = 0;
    for (let index = open; index < source.length; index++)
    {
        if (source[index] === '{')
        {
            depth++;
        }
        if (source[index] === '}' && --depth === 0)
        {
            return index;
        }
    }
    return source.length - 1;
}

function channelFactories(masked)
{
    const signature = /\b(?:public|private|internal|protected)\s+(?:static\s+)?Channel\s*<[^>{};]+>\s+(?<name>[A-Za-z_]\w*)\s*\([^)]*\)\s*(?<body>=>|\{)/gu;
    const factories = [];
    for (const match of masked.matchAll(signature))
    {
        const bodyStart = match.index + match[0].length;
        const end = match.groups.body === '=>'
            ? masked.indexOf(';', bodyStart)
            : matchingBrace(masked, bodyStart - 1);
        factories.push({ name: match.groups.name, start: match.index, end, body: masked.slice(bodyStart, end) });
    }
    let changed = true;
    const bounded = new Set(factories.filter((factory) => factory.body.includes('Channel.CreateBounded')).map((factory) => factory.name));
    while (changed)
    {
        changed = false;
        for (const factory of factories)
        {
            if (bounded.has(factory.name))
            {
                continue;
            }
            if ([...bounded].some((name) => new RegExp(`\\b${name}\\s*\\(`, 'u').test(factory.body)))
            {
                bounded.add(factory.name);
                changed = true;
            }
        }
    }
    return factories.filter((factory) => bounded.has(factory.name));
}

function inside(position, ranges)
{
    return ranges.some((range) => position >= range.start && position <= range.end);
}

function assignmentTarget(masked, position)
{
    const prefix = masked.slice(Math.max(0, position - 240), position);
    return prefix.match(/(?<target>[A-Za-z_]\w*)\s*=\s*$/u)?.groups.target ?? null;
}

function containingType(masked, position)
{
    const declaration = /\b(?:class|record|struct)\s+(?<name>[A-Za-z_]\w*)[^;{]*\{/gu;
    let owner = null;
    for (const match of masked.matchAll(declaration))
    {
        const open = match.index + match[0].lastIndexOf('{');
        if (open > position)
        {
            break;
        }
        if (matchingBrace(masked, open) >= position)
        {
            owner = match.groups.name;
        }
    }
    return owner;
}

function lineNumber(source, position)
{
    return source.slice(0, position).split('\n').length;
}

function buildDiscovery(document, masked, position, target, creationKind, factory, creationSource)
{
    const ownerType = containingType(masked, position);
    if (!ownerType)
    {
        throw new Error(`${document.file}:${lineNumber(document.source, position)} bounded channel has no containing type`);
    }
    return {
        discoveryKey: `${document.file}#${ownerType}.${target}`,
        file: document.file,
        ownerType,
        target,
        creationKind,
        factory,
        fullMode: creationSource.match(/FullMode\s*=\s*BoundedChannelFullMode\.(?<mode>[A-Za-z]+)/u)?.groups.mode ?? null,
        line: lineNumber(document.source, position)
    };
}

export function discoverBoundedChannels({ sourceRoot = path.join(root, 'src'), sources = null } = {})
{
    const documents = sources instanceof Map
        ? [...sources.entries()].map(([file, source]) => ({ file, source }))
        : sourceFiles(sourceRoot).map((file) => ({ file: repositoryPath(file), source: fs.readFileSync(file, 'utf8') }));
    const discovered = [];
    for (const document of documents.sort((left, right) => left.file.localeCompare(right.file)))
    {
        const masked = maskCSharp(document.source);
        const factories = channelFactories(masked);
        for (const match of masked.matchAll(/\bChannel\s*\.\s*CreateBounded\s*</gu))
        {
            if (inside(match.index, factories))
            {
                continue;
            }
            const target = assignmentTarget(masked, match.index);
            if (!target)
            {
                throw new Error(`${document.file}:${lineNumber(document.source, match.index)} bounded channel has no stable assignment owner`);
            }
            discovered.push(buildDiscovery(document, masked, match.index, target, 'direct', null, masked.slice(match.index, match.index + 600)));
        }
        for (const factory of factories)
        {
            const callPattern = new RegExp(`\\b${factory.name}\\s*\\(`, 'gu');
            for (const match of masked.matchAll(callPattern))
            {
                if (inside(match.index, factories))
                {
                    continue;
                }
                const target = assignmentTarget(masked, match.index);
                if (!target)
                {
                    throw new Error(`${document.file}:${lineNumber(document.source, match.index)} bounded factory call has no stable assignment owner`);
                }
                discovered.push(buildDiscovery(document, masked, match.index, target, factory.body.includes('Channel.CreateBounded') ? 'wrapped' : 'indirect', factory.name, factory.body));
            }
        }
    }
    return discovered.sort((left, right) => left.discoveryKey.localeCompare(right.discoveryKey));
}
