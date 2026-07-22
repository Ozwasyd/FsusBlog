#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { projectPrivacyZkPrebuild } from './project-privacy-zk-prebuild.mjs';

function parse(argv)
{
    const values = new Map();
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value == null)
        {
            throw new Error(`invalid option: ${name ?? ''}`);
        }
        values.set(name.slice(2), value);
    }
    return values;
}

function readJson(file, label)
{
    if (!fs.existsSync(file))
    {
        throw new Error(`${label} is missing: ${file}`);
    }
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink())
    {
        throw new Error(`${label} must be a regular file`);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(argv)
{
    const options = parse(argv);
    const root = path.resolve(options.get('root') ?? '.');
    const registry = readJson(path.resolve(root, options.get('registry')), 'ownership registry');
    const receipts = new Map();
    const receiptPaths = new Map();
    for (const declaration of registry.sharedAssertions)
    {
        receiptPaths.set(declaration.owner, declaration.producerReceipt);
        receipts.set(declaration.owner, readJson(
            path.resolve(root, declaration.producerReceipt),
            `${declaration.owner} receipt`
        ));
    }
    const receipt = projectPrivacyZkPrebuild({
        registry,
        receipts,
        receiptPaths,
        sourceState: {
            commit: options.get('commit') ?? process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
            worktreeFingerprint: options.get('worktree-fingerprint') ?? process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
        },
        runId: options.get('run-id') ?? process.env.FSUSBLOG_TEST_RUN_ID,
        uniqueOutcomes: new Map(registry.uniqueAssertions.map(entry => [entry.id, 'Passed'])),
        repositoryRoot: root
    });
    const output = path.resolve(root, options.get('output'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(`${output}.pending-${process.pid}`, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.renameSync(`${output}.pending-${process.pid}`, output);
    console.log(`[privacy-zk-prebuild-projection] ok assertions=${receipt.assertionIds.length} producers=${receipt.producers.length}`);
}

try
{
    main(process.argv.slice(2));
}
catch (error)
{
    console.error(`[privacy-zk-prebuild-projection] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
