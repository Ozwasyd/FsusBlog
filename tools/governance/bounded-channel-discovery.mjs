import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { maskCSharp } = await import(new URL('../architecture/backend-physical-topology/csharp-mask.mjs', import.meta.url));
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

function containingNamespace(masked, position)
{
    const namespaces = [];
    for (const match of masked.matchAll(/\bnamespace\s+(?<name>[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?<body>[;{])/gu))
    {
        const open = match.index + match[0].length - 1;
        if (open <= position && (match.groups.body === ';' || matchingBrace(masked, open) >= position))
        {
            namespaces.push(match.groups.name);
        }
    }
    return namespaces.join('.');
}

function channelFactories(document)
{
    const { masked } = document;
    const signature = /\b(?:public|private|internal|protected)\s+(?:static\s+)?Channel\s*<[^>{};]+>\s+(?<name>[A-Za-z_]\w*)\s*(?:<[^<>;{}()]+>)?\s*\([^)]*\)\s*(?<body>=>|\{)/gu;
    const factories = [];
    for (const match of masked.matchAll(signature))
    {
        const bodyStart = match.index + match[0].length;
        const end = match.groups.body === '=>'
            ? masked.indexOf(';', bodyStart)
            : matchingBrace(masked, bodyStart - 1);
        const ownerType = containingType(masked, match.index);
        if (!ownerType)
        {
            throw new Error(`${document.file}:${lineNumber(document.source, match.index)} channel factory has no containing type`);
        }
        factories.push({ document, ownerType, namespace: containingNamespace(masked, match.index), name: match.groups.name, start: match.index, bodyStart, end, body: masked.slice(bodyStart, end), proof: null });
    }
    return factories;
}

function factoryCalls(masked)
{
    return masked.matchAll(/\b(?<callee>[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*(?:<[^<>;{}()]+>)?\s*\(/gu);
}

function resolveFactoryCall(document, position, callee, factoriesByName)
{
    const parts = callee.replace(/\s/gu, '').split('.');
    const name = parts.pop();
    const qualifier = parts.join('.');
    let candidates = factoriesByName.get(name) ?? [];
    if (candidates.length === 0)
    {
        return null;
    }
    const namespace = containingNamespace(document.masked, position);
    const ownerType = containingType(document.masked, position);
    if (!qualifier || qualifier === 'this')
    {
        candidates = candidates.filter((factory) => factory.ownerType === ownerType && factory.namespace === namespace);
    }
    else
    {
        candidates = candidates.filter((factory) => qualifier === [factory.namespace, factory.ownerType].filter(Boolean).join('.') || qualifier === factory.ownerType);
        const local = candidates.filter((factory) => factory.namespace === namespace);
        if (local.length > 0 && !qualifier.includes('.'))
        {
            candidates = local;
        }
    }
    if (candidates.length > 1)
    {
        throw new Error(`${document.file}:${lineNumber(document.source, position)} channel factory call ${callee} is ambiguous`);
    }
    return candidates[0] ?? null;
}

function bindBoundedFactories(factories)
{
    const factoriesByName = new Map();
    for (const factory of factories)
    {
        const named = factoriesByName.get(factory.name) ?? [];
        named.push(factory);
        factoriesByName.set(factory.name, named);
        if (/\bChannel\s*\.\s*CreateBounded\s*</u.test(factory.body))
        {
            factory.proof = [factory];
        }
    }
    for (const factory of factories)
    {
        factory.dependencies = [...factoryCalls(factory.body)]
            .map((call) => resolveFactoryCall(factory.document, factory.bodyStart + call.index, call.groups.callee, factoriesByName))
            .filter(Boolean);
    }
    let changed = true;
    while (changed)
    {
        changed = false;
        for (const factory of factories)
        {
            if (factory.proof)
            {
                continue;
            }
            const bounded = factory.dependencies.find((dependency) => dependency.proof);
            if (bounded)
            {
                factory.proof = [factory, ...bounded.proof];
                changed = true;
            }
        }
    }
    return factoriesByName;
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

function buildDiscovery(document, masked, position, target, creationKind, factory, creationSource, factorySources = [])
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
        factorySources,
        fullMode: creationSource.match(/FullMode\s*=\s*BoundedChannelFullMode\.(?<mode>[A-Za-z]+)/u)?.groups.mode ?? null,
        line: lineNumber(document.source, position)
    };
}

export function discoverBoundedChannels({ sourceRoot = path.join(root, 'src'), sources = null } = {})
{
    const documents = sources instanceof Map
        ? [...sources.entries()].map(([file, source]) => ({ file, source }))
        : sourceFiles(sourceRoot).map((file) => ({ file: repositoryPath(file), source: fs.readFileSync(file, 'utf8') }));
    documents.sort((left, right) => left.file.localeCompare(right.file));
    for (const document of documents)
    {
        document.masked = maskCSharp(document.source);
        document.factories = channelFactories(document);
    }
    const factoriesByName = bindBoundedFactories(documents.flatMap((document) => document.factories));
    const discovered = [];
    for (const document of documents)
    {
        const { masked, factories } = document;
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
        for (const call of factoryCalls(masked))
        {
            if (inside(call.index, factories))
            {
                continue;
            }
            const factory = resolveFactoryCall(document, call.index, call.groups.callee, factoriesByName);
            if (!factory?.proof)
            {
                continue;
            }
            const target = assignmentTarget(masked, call.index);
            if (!target)
            {
                throw new Error(`${document.file}:${lineNumber(document.source, call.index)} bounded factory call has no stable assignment owner`);
            }
            const factorySources = factory.proof.map((item) => ({ file: item.document.file, ownerType: item.ownerType, factory: item.name, line: lineNumber(item.document.source, item.start) }));
            discovered.push(buildDiscovery(document, masked, call.index, target, factory.proof.length === 1 ? 'wrapped' : 'indirect', factory.name, factory.proof.at(-1).body, factorySources));
        }
    }
    return discovered.sort((left, right) => left.discoveryKey.localeCompare(right.discoveryKey));
}

export function discoverUnboundedChannels({ sourceRoot = path.join(root, 'src'), sources = null } = {})
{
    const documents = sources instanceof Map
        ? [...sources.entries()].map(([file, source]) => ({ file, source }))
        : sourceFiles(sourceRoot).map((file) => ({ file: repositoryPath(file), source: fs.readFileSync(file, 'utf8') }));
    const discovered = [];
    for (const document of documents.sort((left, right) => left.file.localeCompare(right.file)))
    {
        const masked = maskCSharp(document.source);
        for (const match of masked.matchAll(/\bChannel\s*\.\s*CreateUnbounded\s*</gu))
        {
            discovered.push({ file: document.file, line: lineNumber(document.source, match.index) });
        }
    }
    return discovered;
}
