#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const options = {
    compose: path.join(root, 'ops/docker/docker-compose.production.yml'),
    example: path.join(root, '.env.production.example')
};

for (let index = 2; index < process.argv.length; index += 2)
{
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if (!value || !['--compose', '--example'].includes(flag))
    {
        throw new Error(`unknown or incomplete argument: ${flag}`);
    }
    options[flag.slice(2)] = path.resolve(value);
}

const compose = fs.readFileSync(options.compose, 'utf8');
const example = fs.readFileSync(options.example, 'utf8');
const references = [...compose.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}/gu)]
    .map((match) => ({
        name: match[1],
        expression: match[0],
        modifier: match[2]
    }));

if (references.length === 0)
{
    throw new Error('production Compose file does not contain environment references');
}

const invalidExpressions = references
    .filter(({ modifier }) =>
        !modifier.startsWith(':-') && !modifier.startsWith(':?')
        || modifier.startsWith(':?') && modifier.length <= 2)
    .map(({ expression }) => expression);
if (invalidExpressions.length > 0)
{
    throw new Error(
        `production Compose references require an explicit default or non-empty must-set diagnostic: ${
            [...new Set(invalidExpressions)].join(', ')
        }`
    );
}

const variableNames = [...new Set(references.map(({ name }) => name))].sort();
const undocumented = variableNames.filter((name) =>
    !new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}([^A-Za-z0-9_]|$)`, 'mu')
        .test(example));
if (undocumented.length > 0)
{
    throw new Error(
        `production Compose variables are missing from .env.production.example: ${undocumented.join(', ')}`
    );
}

const requiredApplicationBindings = new Map([
    ['Jwt__SecretKey', 'Jwt__SecretKey'],
    ['Jwt__KeyVersion', 'Jwt__KeyVersion'],
    ['Jwt__RotationWindowDays', 'Jwt__RotationWindowDays']
]);
const applicationBindings = new Map(
    [...compose.matchAll(/^\s*-\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gmu)]
        .map((match) => [match[1], match[2]])
);
for (const [binding, source] of requiredApplicationBindings)
{
    const value = applicationBindings.get(binding);
    if (typeof value !== 'string'
        || !value.includes(`\${${source}:`))
    {
        throw new Error(
            `production Compose must explicitly pass ${source} to application binding ${binding}`
        );
    }
}

process.stdout.write(
    `[production-compose-environment] verified ${variableNames.length} documented variables; `
    + 'every reference has a default or must-set diagnostic and JWT signing configuration is passed through\n'
);
