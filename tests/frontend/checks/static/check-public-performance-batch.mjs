#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(process.cwd(), '../..');
const errors = [];

function read(relativePath)
{
    return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function assert(condition, message)
{
    if (!condition)
    {
        errors.push(message);
    }
}

const doc = read('docs/performance-public-batch.md');
const routePressure = read('tests/frontend/checks/perf/check-route-render-pressure.mjs');
const domBudget = read('tests/frontend/checks/perf/check-dom-budget.mjs');
const packageJson = read('src/frontend/package.json');

for (const token of [
    '#167',
    '#168',
    '#169',
    '#170',
    '#171',
    '#172',
    '#173',
    '#174',
    '#175',
    '#176',
    '.tmp/frontend/asset-size-budget.json',
    '.tmp/release-evidence/frontend-render-structure-summary.json',
    '/category/:id',
    '/tag/:id',
    'compression oracle',
    'identity encoding',
    'pre-materialized PublicAOT',
    '`backend-unit` xUnit result',
    'PublicAotHtmlFastPath_PreencodedVariantsHaveExpectedByteShape',
    '`Content-Encoding`',
    'ETag',
    '`Content-Length`',
    'BenchmarkDotNet'
])
{
    assert(doc.includes(token), `performance batch doc missing ${token}`);
}

for (const token of [
    'FSUSBLOG_ROUTE_PRESSURE_CATEGORY_ID',
    'FSUSBLOG_ROUTE_PRESSURE_TAG_ID',
    '`/category/${process.env.FSUSBLOG_ROUTE_PRESSURE_CATEGORY_ID',
    '`/tag/${process.env.FSUSBLOG_ROUTE_PRESSURE_TAG_ID'
])
{
    assert(routePressure.includes(token), `route render pressure missing ${token}`);
}

for (const token of [
    'public-category',
    'public-tag',
    'FSUSBLOG_DOM_BUDGET_CATEGORY_ID',
    'FSUSBLOG_DOM_BUDGET_TAG_ID'
])
{
    assert(domBudget.includes(token), `DOM budget missing ${token}`);
}

assert(packageJson.includes('check:public-performance-batch'), 'package scripts must expose public performance batch check');

if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[public-performance-batch] ${error}`);
    }
    process.exit(1);
}

console.log('[public-performance-batch] ok');
