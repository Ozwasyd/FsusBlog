#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import {
    frontendRoutesPath,
    loadOpenApi,
    operationsFromOpenApi,
    root
} from './lib/openapi-contracts.mjs';

const operations = operationsFromOpenApi(loadOpenApi());
const routeConstants = fs.existsSync(frontendRoutesPath) ? fs.readFileSync(frontendRoutesPath, 'utf8') : '';
const errors = [];
const knownPaths = new Set(operations.map((op) => op.fullPath));

for (const op of operations)
{
    if (!routeConstants.includes(JSON.stringify(op.operationId)))
    {
        errors.push(`${op.key} missing generated route constant ${op.operationId}`);
    }
    if (!routeConstants.includes(JSON.stringify(op.fullPath)))
    {
        errors.push(`${op.key} missing generated path ${op.fullPath}`);
    }
    if (!op.frontendWrapper || !op.frontendAdapter)
    {
        continue;
    }
    for (const rel of [op.frontendWrapper, op.frontendAdapter])
    {
        if (!fs.existsSync(path.join(root, rel)))
        {
            errors.push(`${op.key} consumer path missing: ${rel}`);
        }
    }
}

const apiDir = path.join(root, 'src/frontend/src/api');
for (const file of walk(apiDir, (value) => /\.(ts|js)$/.test(value)))
{
    const source = fs.readFileSync(file, 'utf8');
    const matches = source.matchAll(/['"`](\/api\/binary\/[^'"`?${}]*)/g);
    for (const match of matches)
    {
        const value = match[1];
        if (!matchesKnownPath(value, knownPaths))
        {
            errors.push(`${path.relative(root, file)} contains stale manual binary path ${value}`);
        }
    }
}

if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[openapi-consumers] ${error}`);
    }
    process.exit(1);
}

console.log(`[openapi-consumers] ok operations=${operations.length}`);

function walk(dir, predicate, results = [])
{
    for (const entry of fs.readdirSync(dir))
    {
        const fullPath = path.join(dir, entry);
        const stats = fs.statSync(fullPath);
        if (stats.isDirectory())
        {
            walk(fullPath, predicate, results);
        }
        else if (predicate(fullPath))
        {
            results.push(fullPath);
        }
    }
    return results;
}

function matchesKnownPath(value, knownPaths)
{
    if (knownPaths.has(value))
    {
        return true;
    }
    for (const known of knownPaths)
    {
        const prefix = known.split('{')[0];
        if (prefix && (value === prefix.replace(/\/$/, '') || value.startsWith(prefix)))
        {
            return true;
        }
    }
    return false;
}
