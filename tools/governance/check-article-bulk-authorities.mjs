#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ignoredDirectories = new Set(['.git', 'bin', 'node_modules', 'obj']);
const inspectedRoots = ['config', 'docs', 'scripts', 'src', 'tests', 'tools'];
const registryRelativePath = 'src/backend/Services/Articles/Bulk/ArticleBulkOperationRegistry.cs';
const ownersRelativePath = 'src/backend/Services/Articles/Bulk/ArticleBulkCanonicalCommandOwners.cs';

function readText(root, relativePath)
{
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function parseOperations(source)
{
    const operations = [];
    const expression = /Operation\(\s*"([^"]+)"\s*,\s*ArticleBulkExecutionStrategy\.([A-Za-z]+)\s*,\s*"([^"]+)"/gs;
    for (const match of source.matchAll(expression))
    {
        operations.push({ id: match[1], strategy: match[2], owner: match[3] });
    }
    return operations;
}

function parseOwners(source)
{
    const owners = [];
    const expression = /Owner\(\s*"([^"]+)"\s*,\s*\[([^\]]+)\]\s*\)/gs;
    for (const match of source.matchAll(expression))
    {
        owners.push({
            id: match[1],
            operationIds: [...match[2].matchAll(/"([^"]+)"/g)].map((item) => item[1])
        });
    }
    return owners;
}

function walk(root, relativeDirectory = '')
{
    const directory = path.join(root, relativeDirectory);
    if (!fs.existsSync(directory))
    {
        return [];
    }
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
    {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name))
        {
            continue;
        }
        const relativePath = path.join(relativeDirectory, entry.name);
        if (entry.isDirectory())
        {
            files.push(...walk(root, relativePath));
        }
        else if (entry.isFile())
        {
            files.push(relativePath);
        }
    }
    return files;
}

export function validateArticleBulkAuthorities(root)
{
    const errors = [];
    const operations = parseOperations(readText(root, registryRelativePath));
    const owners = parseOwners(readText(root, ownersRelativePath));
    if (operations.length !== 14)
    {
        errors.push(`expected 14 operations, found ${operations.length}`);
    }

    const operationIds = operations.map((operation) => operation.id);
    const ownedOperationIds = owners.flatMap((owner) => owner.operationIds);
    for (const [label, values] of [
        ['operation', operationIds],
        ['owner', owners.map((owner) => owner.id)],
        ['owned operation', ownedOperationIds]
    ])
    {
        if (new Set(values).size !== values.length)
        {
            errors.push(`duplicate ${label} declaration`);
        }
    }

    const ownerByOperation = new Map();
    for (const owner of owners)
    {
        for (const operationId of owner.operationIds)
        {
            ownerByOperation.set(operationId, owner.id);
        }
    }
    for (const operation of operations)
    {
        if (ownerByOperation.get(operation.id) !== operation.owner)
        {
            errors.push(`owner mismatch for ${operation.id}`);
        }
        if (!['PerItemIsolated', 'AllOrNothing'].includes(operation.strategy))
        {
            errors.push(`strategy missing for ${operation.id}`);
        }
    }
    for (const operationId of ownedOperationIds)
    {
        if (!operationIds.includes(operationId))
        {
            errors.push(`unregistered operation owned by canonical command: ${operationId}`);
        }
    }

    const declarationToken = 'new ArticleBulkCanonicalCommandOwner(';
    const registrySchemaToken = 'fsusblog.article-bulk.operation-registry.';
    const sourceFiles = inspectedRoots.flatMap((directory) => walk(root, directory));
    for (const relativePath of sourceFiles)
    {
        const normalized = relativePath.split(path.sep).join('/');
        if (!/\.(?:cs|ts|tsx|js|mjs|vue|md|json|ya?ml|sh)$/.test(normalized))
        {
            continue;
        }
        const source = readText(root, relativePath);
        if (source.includes(declarationToken)
            && normalized !== ownersRelativePath
            && normalized !== 'tools/governance/check-article-bulk-authorities.mjs')
        {
            errors.push(`canonical owner declaration outside sole catalog: ${normalized}`);
        }
        if (source.includes(registrySchemaToken)
            && normalized !== registryRelativePath
            && !normalized.startsWith('tests/')
            && normalized !== 'tools/governance/check-article-bulk-authorities.mjs')
        {
            errors.push(`second operation registry schema declaration: ${normalized}`);
        }
    }

    return {
        schema: 'fsusblog.article-bulk.authority-scan.v1',
        operations: operations.length,
        owners: owners.length,
        inspectedFiles: sourceFiles.length,
        errors
    };
}

function main()
{
    const rootArgumentIndex = process.argv.indexOf('--root');
    const root = rootArgumentIndex >= 0
        ? path.resolve(process.argv[rootArgumentIndex + 1])
        : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const result = validateArticleBulkAuthorities(root);
    process.stdout.write(`${JSON.stringify(result, null, 4)}\n`);
    if (result.errors.length > 0)
    {
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
