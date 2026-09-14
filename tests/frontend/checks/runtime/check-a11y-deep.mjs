#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const matrix = JSON.parse(readFileSync(resolve(root, 'tests/frontend/support/a11y-deep-matrix.json'), 'utf8'));
const smoke = readFileSync(resolve(root, 'tests/frontend/checks/runtime/check-a11y-smoke.mjs'), 'utf8');
const errors = [];

function fail(message)
{
    errors.push(message);
}

if (matrix.version !== 'fsusblog-a11y-deep-matrix-v1')
{
    fail('unexpected matrix version');
}

const scopes = new Set(matrix.pages.map((page) => page.scope));
for (const scope of ['public', 'auth', 'user', 'admin'])
{
    if (!scopes.has(scope))
    {
        fail(`missing scope ${scope}`);
    }
}

if (matrix.pages.length < 10)
{
    fail('deep matrix must cover at least 10 key pages');
}

if (matrix.dialogs.length < 6)
{
    fail('deep matrix must cover key dialogs');
}

const assertions = new Set([
    ...matrix.pages.flatMap((page) => page.assertions),
    ...matrix.dialogs.flatMap((dialog) => dialog.assertions)
]);
for (const assertion of matrix.requiredAssertions)
{
    if (![...assertions].some((value) => value.includes(assertion) || assertion.includes(value)))
    {
        fail(`required assertion missing: ${assertion}`);
    }
}

for (const token of ['assertPageA11y', 'silentButtons', 'missingFields', 'focusInsideDialog'])
{
    if (!smoke.includes(token))
    {
        fail(`a11y smoke no longer contains ${token}`);
    }
}

if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[a11y-deep] ${error}`);
    }
    process.exit(1);
}

console.log(`[a11y-deep] ok pages=${matrix.pages.length} dialogs=${matrix.dialogs.length} assertions=${assertions.size}`);
