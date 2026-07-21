#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditBootstrapAndAuthoring } from './backend-physical-topology/audit-bootstrap-authoring.mjs';
import { auditCacheModules } from './backend-physical-topology/audit-cache-modules.mjs';
import { auditMessageCenterPartials } from './backend-physical-topology/audit-message-center-partials.mjs';
import { auditSchemaMigrationLayout } from './backend-physical-topology/audit-schema-migration-layout.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const policyRelativePath = 'tests/governance/backend-physical-topology.json';
const defaultPolicyPath = resolve(repositoryRoot, policyRelativePath);
const canonicalPolicySha256 = '6df4aee7469ab1148036053d77bf94c55683736519956cf3c03f12a6aef53e15';

function stableJson(value, location = '$')
{
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
    {
        return JSON.stringify(value);
    }
    if (typeof value === 'number')
    {
        if (!Number.isFinite(value))
        {
            throw new Error(`${location}: policy number must be finite`);
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
    {
        if (Object.getPrototypeOf(value) !== Array.prototype || typeof value.toJSON === 'function')
        {
            throw new Error(`${location}: policy arrays must use the ordinary JSON prototype without toJSON`);
        }
        if (Reflect.ownKeys(value).length !== value.length + 1)
        {
            throw new Error(`${location}: policy arrays must contain indexed JSON values only`);
        }
        for (let index = 0; index < value.length; index += 1)
        {
            if (!Object.hasOwn(value, index))
            {
                throw new Error(`${location}: sparse policy arrays are not allowed`);
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
            {
                throw new Error(`${location}[${index}]: policy array accessors are not allowed`);
            }
        }
        return `[${value.map((entry, index) => stableJson(entry, `${location}[${index}]`)).join(',')}]`;
    }
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
        || typeof value.toJSON === 'function')
    {
        throw new Error(`${location}: policy values must be plain JSON objects without toJSON`);
    }
    const keys = Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    if (Reflect.ownKeys(value).length !== keys.length)
    {
        throw new Error(`${location}: policy objects must contain enumerable string data properties only`);
    }
    for (const key of keys)
    {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value'))
        {
            throw new Error(`${location}.${key}: policy accessors are not allowed`);
        }
    }
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key], `${location}.${key}`)}`).join(',')}}`;
}

function readPolicy(root)
{
    return JSON.parse(readFileSync(resolve(root, policyRelativePath), 'utf8'));
}

function validatePolicy(policy)
{
    if (policy.schema !== 'fsusblog.backend-physical-topology.v1')
    {
        throw new Error(`unsupported backend physical topology schema: ${policy.schema ?? 'missing'}`);
    }
    const actualSha256 = createHash('sha256').update(stableJson(policy)).digest('hex');
    if (actualSha256 !== canonicalPolicySha256)
    {
        throw new Error(`backend physical topology policy fingerprint mismatch: expected ${canonicalPolicySha256}, got ${actualSha256}`);
    }
}

export function auditBackendPhysicalTopology({ root = repositoryRoot, policy } = {})
{
    const resolvedPolicy = policy ?? readPolicy(root);
    validatePolicy(resolvedPolicy);
    const errors = [];

    auditBootstrapAndAuthoring(root, resolvedPolicy, errors);
    auditCacheModules(root, resolvedPolicy.cacheModules, errors);
    auditMessageCenterPartials(root, resolvedPolicy.messageCenterPartials, errors);
    auditSchemaMigrationLayout(root, resolvedPolicy.schemaMigrationLayout, errors);

    return {
        schema: 'fsusblog.backend-physical-topology-report.v1',
        status: errors.length === 0 ? 'success' : 'failed',
        policy: relative(root, resolve(root, policyRelativePath)).replaceAll('\\', '/'),
        errors
    };
}

function printReport(report)
{
    if (process.argv.includes('--json'))
    {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    else if (report.errors.length === 0)
    {
        process.stdout.write('backend physical topology governance passed\n');
    }
    for (const error of report.errors)
    {
        process.stderr.write(`[backend-physical-topology] ${error}\n`);
    }
    if (report.errors.length > 0)
    {
        process.exitCode = 1;
    }
}

function writeReport(report)
{
    const index = process.argv.indexOf('--out');
    if (index < 0)
    {
        return;
    }
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--'))
    {
        throw new Error('--out requires a path');
    }
    const output = resolve(repositoryRoot, value);
    mkdirSync(resolve(output, '..'), { recursive: true });
    const temporary = `${output}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
    renameSync(temporary, output);
}

function runCli()
{
    const policy = JSON.parse(readFileSync(defaultPolicyPath, 'utf8'));
    const report = auditBackendPhysicalTopology({ root: repositoryRoot, policy });
    writeReport(report);
    printReport(report);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
{
    runCli();
}
