#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
    createProductionBuildReceipt,
    materializeProductionBuildDomains
} from './production-build-artifacts.mjs';

function options(args)
{
    const value = {};
    for (let index = 0; index < args.length; index += 2)
    {
        if (!args[index]?.startsWith('--') || args[index + 1] === undefined)
        {
            throw new Error('benchmark arguments must use --name value');
        }
        value[args[index].slice(2).replaceAll('-', '_')] = args[index + 1];
    }
    return value;
}

function elapsedMs(started)
{
    return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function writeSized(file, bytes, fill)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes, fill));
}

function copyTree(source, destination)
{
    fs.cpSync(source, destination, { recursive: true, force: true, preserveTimestamps: true });
}

function digestTree(root)
{
    const digest = createHash('sha256');
    const visit = directory =>
    {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)))
        {
            const child = path.join(directory, entry.name);
            if (entry.isDirectory())
            {
                visit(child);
            }
            else
            {
                digest.update(fs.readFileSync(child));
            }
        }
    };
    visit(root);
    return digest.digest('hex');
}

function consumerResultDigest(root)
{
    const digest = createHash('sha256');
    for (const relative of [
        'spa/assets/app.bin',
        'test/FsusBlog.Server.Tests.bin',
        'wwwroot/assets/app.bin'
    ])
    {
        digest.update(relative);
        digest.update(fs.readFileSync(path.join(root, relative)));
    }
    return `sha256:${digest.digest('hex')}`;
}

function runRound(bytesPerDomain)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-seal-cow-bench-'));
    try
    {
        const buildRoot = path.join(root, 'build');
        const legacyPayload = path.join(root, 'legacy-payload');
        const legacyConsumer = path.join(root, 'legacy-consumer');
        writeSized(path.join(buildRoot, 'frontend/assets/app.bin'), bytesPerDomain, 0x41);
        writeSized(path.join(buildRoot, 'test/FsusBlog.Server.Tests.bin'), bytesPerDomain, 0x54);

        const beforeStarted = process.hrtime.bigint();
        copyTree(path.join(buildRoot, 'frontend'), path.join(legacyPayload, 'frontend'));
        copyTree(path.join(buildRoot, 'test'), path.join(legacyPayload, 'test'));
        copyTree(path.join(legacyPayload, 'frontend'), path.join(legacyConsumer, 'spa'));
        copyTree(path.join(legacyPayload, 'frontend'), path.join(legacyConsumer, 'wwwroot'));
        copyTree(path.join(legacyPayload, 'test'), path.join(legacyConsumer, 'test'));
        digestTree(path.join(legacyPayload, 'frontend'));
        digestTree(path.join(legacyPayload, 'frontend'));
        digestTree(path.join(legacyPayload, 'test'));
        const beforeMs = elapsedMs(beforeStarted);
        const beforeResultDigest = consumerResultDigest(legacyConsumer);

        const artifactRoot = path.join(root, 'sealed');
        fs.mkdirSync(path.join(artifactRoot, 'payload'), { recursive: true });
        fs.renameSync(path.join(buildRoot, 'frontend'), path.join(artifactRoot, 'payload/frontend'));
        fs.renameSync(path.join(buildRoot, 'test'), path.join(artifactRoot, 'payload/test'));
        fs.writeFileSync(path.join(root, 'input.json'), '{}');
        createProductionBuildReceipt({
            root,
            artifactRoot,
            sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
            producer: { workflow: 'local-benchmark', runId: '1386', runAttempt: 1, job: 'production-build-artifacts' },
            toolchain: { node: process.version, npm: 'fixture', dotnet: 'fixture', vite: 'fixture', vitest: 'fixture', playwright: 'fixture', emsdk: 'fixture' },
            inputPaths: ['input.json'],
            domains: [
                { name: 'frontend-dist', path: 'payload/frontend' },
                { name: 'test-runtime', path: 'payload/test', consumerMode: 'copy-before-write' }
            ]
        });
        const afterStarted = process.hrtime.bigint();
        const result = materializeProductionBuildDomains({
            artifactRoot,
            destinationRoot: path.join(root, 'sealed-consumer'),
            mappings: [
                { name: 'frontend-dist', destination: 'spa' },
                { name: 'frontend-dist', destination: 'wwwroot' },
                { name: 'test-runtime', destination: 'test' }
            ]
        });
        const afterMs = elapsedMs(afterStarted);
        const afterResultDigest = consumerResultDigest(path.join(root, 'sealed-consumer'));
        return {
            before: {
                copiedBytes: (3 * bytesPerDomain) + (2 * bytesPerDomain),
                digestTraversalCount: 3,
                materializationWallTimeMs: beforeMs,
                testResultDigest: beforeResultDigest
            },
            after: {
                copiedBytes: result.evidence.copiedBytes,
                reflinkedBytes: result.evidence.reflinkedBytes,
                referencedBytes: result.evidence.referencedBytes,
                digestTraversalCount: result.evidence.digestTraversalCount,
                materializationWallTimeMs: afterMs,
                testResultDigest: afterResultDigest,
                writableMethod: result.evidence.materialization.domains.find(item => item.name === 'test-runtime')?.method,
                fallbackReason: result.evidence.materialization.domains.find(item => item.name === 'test-runtime')?.fallbackReason
            }
        };
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

const parsed = options(process.argv.slice(2));
const rounds = Number(parsed.rounds ?? 3);
const bytesPerDomain = Number(parsed.bytes ?? 4 * 1024 * 1024);
if (!Number.isInteger(rounds) || rounds < 3)
{
    throw new Error('--rounds must be at least 3');
}
if (!Number.isInteger(bytesPerDomain) || bytesPerDomain < 1)
{
    throw new Error('--bytes must be a positive integer');
}
const samples = Array.from({ length: rounds }, () => runRound(bytesPerDomain));
const evidence = {
    schema: 'fsusblog.production-build-seal-cow-benchmark.v1',
    platform: { platform: process.platform, release: os.release(), node: process.version },
    rounds,
    bytesPerDomain,
    samples
};
const output = `${JSON.stringify(evidence, null, 2)}\n`;
if (parsed.out)
{
    fs.mkdirSync(path.dirname(path.resolve(parsed.out)), { recursive: true });
    fs.writeFileSync(path.resolve(parsed.out), output);
}
process.stdout.write(output);
