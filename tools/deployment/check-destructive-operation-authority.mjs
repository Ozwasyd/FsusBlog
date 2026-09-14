#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    assertUnsupportedOperation,
    readDestructiveOperationAuthority
} from './destructive-operation-authority.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const options = parseArgs(process.argv.slice(2));

try
{
    const authority = readDestructiveOperationAuthority();
    const expectedIds = [
        'production-schema-cleanup', 'production-volume-cleanup', 'release-artifact-gc',
        'runtime-candidate-cleanup', 'runtime-slot-stop'
    ];
    if (authority.operations.map(operation => operation.id).sort().join(',') !== expectedIds.join(','))
    {
        throw new Error('destructive operation authority operation set is not closed exact');
    }
    for (const operation of authority.operations)
    {
        if (operation.status === 'unsupported')
        {
            assertUnsupportedOperation(authority, operation.id);
            continue;
        }
        const consumer = path.resolve(root, operation.consumer);
        if (!fs.statSync(consumer, { throwIfNoEntry: false })?.isFile())
        {
            throw new Error(`${operation.id} consumer does not exist: ${operation.consumer}`);
        }
    }
    const slotStop = fs.readFileSync(path.join(root, 'tools/deployment/slot-stop.sh'), 'utf8');
    if (!slotStop.includes('verify-destructive-operation.mjs" runtime-slot-stop'))
    {
        throw new Error('runtime-slot-stop consumer is not bound to the authority verifier');
    }
    const slotStart = fs.readFileSync(path.join(root, 'tools/deployment/slot-start.sh'), 'utf8');
    if (!slotStart.includes('verify-destructive-operation.mjs" runtime-candidate-cleanup'))
    {
        throw new Error('runtime-candidate-cleanup consumer is not bound to the authority verifier');
    }
    const artifactGc = fs.readFileSync(path.join(root, 'tools/storage/gc-release-assets.mjs'), 'utf8');
    if (!artifactGc.includes('verifyArtifactGcActiveIdentity'))
    {
        throw new Error('release-artifact-gc consumer is not bound to the authority verifier');
    }
    const rehearsalOnlyDestructivePaths = new Set(['tools/deployment/zero-downtime-topology.sh']);
    const productionSources = walkProductionControlSources(root).map(relative => ({
        relative, file: path.join(root, relative)
    }));
    if (options['additional-source'])
    {
        productionSources.push({ relative: 'additional-production-source', file: path.resolve(options['additional-source']) });
    }
    for (const { relative, file } of productionSources)
    {
        const source = fs.readFileSync(file, 'utf8');
        const destructive = /docker\s+volume\s+(?:rm|prune)|DROP\s+(?:SCHEMA|DATABASE)|rm\s+-[A-Za-z]*r[A-Za-z]*f[^\n]*(?:data-protection|public-assets|postgres)/iu.test(source);
        if (destructive && !rehearsalOnlyDestructivePaths.has(relative))
        {
            throw new Error(`unbound production volume/schema destructive path: ${relative}`);
        }
    }
    const rehearsal = fs.readFileSync(path.join(root, 'tools/deployment/zero-downtime-rehearsal.sh'), 'utf8');
    if (authority.operations.some(operation => operation.consumer === 'tools/deployment/zero-downtime-rehearsal.sh'))
    {
        throw new Error('rehearsal teardown must not be registered as production authority');
    }
    process.stdout.write(`${JSON.stringify({
        schema: 'fsusblog.destructive-operation-authority-check.v1',
        status: 'pass',
        operationCount: authority.operations.length,
        rehearsalInspected: rehearsal.length > 0,
        errors: []
    })}\n`);
}
catch (error)
{
    process.stderr.write(`[destructive-operation-authority] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}

function walkProductionControlSources(repositoryRoot)
{
    const result = [];
    for (const relativeRoot of ['ops/docker', 'tools/deployment', 'tools/storage'])
    {
        walk(path.join(repositoryRoot, relativeRoot), relativeRoot);
    }
    return result.sort();

    function walk(directory, relativeDirectory)
    {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        {
            const relative = path.posix.join(relativeDirectory, entry.name);
            if (entry.isDirectory())
            {
                walk(path.join(directory, entry.name), relative);
            }
            else if (/\.(?:mjs|sh|ya?ml)$/u.test(entry.name))
            {
                result.push(relative);
            }
        }
    }
}

function parseArgs(argv)
{
    const parsed = {};
    while (argv.length > 0)
    {
        const name = argv.shift();
        const value = argv.shift();
        if (name !== '--additional-source' || !value)
        {
            throw new Error(`invalid argument near ${name ?? '<end>'}`);
        }
        parsed['additional-source'] = value;
    }
    return parsed;
}
