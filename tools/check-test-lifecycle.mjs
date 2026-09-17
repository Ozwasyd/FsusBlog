#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    resolveRetentionAudit
} from './retention/audit-input.mjs';
import {
    buildLifecycleReport,
    reconcileLifecycleRegistry,
    renderLifecycleMatrix
} from './test-lifecycle/lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = path.join(root, 'tests/governance/test-lifecycle-registry.json');
const outputPath = path.join(root, '.tmp/release-evidence/test-lifecycle-report.json');
const matrixPath = path.join(root, '.tmp/release-evidence/test-lifecycle-candidate-matrix.md');
const retentionInputPath = path.join(root, '.tmp/release-evidence/test-lifecycle-retention-input.json');

function parseArgs(argv)
{
    const options = {
        writeRegistry: false,
        auditInput: null
    };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--write-registry')
        {
            options.writeRegistry = true;
        }
        else if (argument === '--audit-input')
        {
            const value = String(argv[index + 1] ?? '').trim();
            if (!value)
            {
                throw new Error('--audit-input requires a path');
            }
            options.auditInput = path.resolve(root, value);
            index += 1;
        }
        else if (argument === '--help' || argument === '-h')
        {
            console.log('Usage: node tools/check-test-lifecycle.mjs [--write-registry] [--audit-input .tmp/release-evidence/test-retention-audit.json]');
            process.exit(0);
        }
        else
        {
            throw new Error(`unknown argument: ${argument}`);
        }
    }
    return options;
}

function produceStandaloneAudit()
{
    const retention = spawnSync(process.execPath, [
        path.join(root, 'tools/check-test-retention.mjs'),
        '--out', retentionInputPath
    ], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
    if (retention.status !== 0)
    {
        throw new Error(String(retention.stderr || retention.stdout || `retention audit exited ${retention.status ?? 1}`).trim());
    }
    return retentionInputPath;
}

let options;
let audit;
try
{
    options = parseArgs(process.argv.slice(2));
    audit = await resolveRetentionAudit({
        root,
        auditInput: options.auditInput,
        produceStandaloneAudit
    });
}
catch (error)
{
    console.error(`[test-lifecycle] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
if (options.writeRegistry)
{
    const existingRegistry = fs.existsSync(registryPath)
        ? JSON.parse(fs.readFileSync(registryPath, 'utf8'))
        : {
            schema: 'fsusblog.test-lifecycle-registry.v1',
            policy: {
                newNodeTestsRequireExplicitOwner: true,
                timeOrAgeMayDecideLifecycle: false
            },
            nodeTests: []
        };
    const reconciliation = reconcileLifecycleRegistry({ root, audit, registry: existingRegistry });
    if (reconciliation.errors.length > 0)
    {
        for (const error of reconciliation.errors)
        {
            console.error(`[test-lifecycle] ${error}`);
        }
        process.exit(1);
    }
    if (reconciliation.additions.length === 0)
    {
        console.log(`[test-lifecycle] registry already current nodeTests=${existingRegistry.nodeTests.length}`);
        process.exit(0);
    }
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, `${JSON.stringify(reconciliation.registry, null, 4)}\n`);
    console.log(`[test-lifecycle] wrote registry nodeTests=${reconciliation.registry.nodeTests.length} added=${reconciliation.additions.length}`);
    process.exit(0);
}

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const { errors, report } = buildLifecycleReport({ audit, registry });
if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[test-lifecycle] ${error}`);
    }
    process.exit(1);
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(matrixPath, renderLifecycleMatrix(report));
console.log(`[test-lifecycle] ok files=${report.files.length} tests=${report.testRecords.length} node=${registry.nodeTests.length}`);
