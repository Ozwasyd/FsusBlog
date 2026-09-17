#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { governanceContentDigest } from './evidence-location-contract.mjs';
import { generateEvidenceLocationGovernance } from './generate-evidence-location-governance.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputPath = path.join(repositoryRoot, 'config/testing/current-run-evidence-location-acceptance.json');

const sourceFiles = Object.freeze([
    'config/testing/evidence-locator-registry.json',
    'config/testing/evidence-location-migration-ledger.json',
    'tools/test/evidence-location-scanner.mjs',
    'tools/test/current-run-evidence-locator.mjs',
    'tools/test/current-run-evidence-transport.mjs',
    'tools/test/generate-evidence-location-governance.mjs'
]);

function digestFile(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

export function generateCurrentRunEvidenceLocationAcceptance({ root = repositoryRoot } = {})
{
    const generated = generateEvidenceLocationGovernance({ root });
    const sourceDigests = Object.fromEntries(sourceFiles.map((file) => [
        file,
        digestFile(path.join(root, file))
    ]));
    const consumerInventory = generated.registry.entries.map((entry) => ({
        consumerId: entry.consumerId,
        authorityId: entry.authorityId,
        producerId: entry.producerId,
        locatorMode: entry.locatorMode,
        publicationMode: entry.publicationMode
    }));
    const warnings = [];
    const payload = {
        schema: 'fsusblog.current-run-evidence-location-acceptance.v1',
        sourceDigests,
        registryDigest: generated.registry.contentDigest,
        ledgerDigest: generated.ledger.contentDigest,
        scannerDigest: generated.scan.contentDigest,
        locatorDigest: sourceDigests['tools/test/current-run-evidence-locator.mjs'],
        transportDigest: sourceDigests['tools/test/current-run-evidence-transport.mjs'],
        consumerInventory,
        consumerCount: consumerInventory.length,
        findingCount: generated.scan.findings.length,
        warnings
    };
    return { ...payload, contentDigest: governanceContentDigest(payload) };
}

function serialized(value)
{
    return `${JSON.stringify(value, null, 4)}\n`;
}

function main()
{
    const receipt = generateCurrentRunEvidenceLocationAcceptance();
    if (process.argv.includes('--check'))
    {
        const current = fs.readFileSync(outputPath, 'utf8');
        if (current !== serialized(receipt))
        {
            throw new Error('current-run evidence location acceptance receipt is stale');
        }
        if (receipt.warnings.length !== 0)
        {
            throw new Error('current-run evidence location acceptance receipt has warnings');
        }
    }
    else
    {
        fs.writeFileSync(outputPath, serialized(receipt));
    }
    process.stdout.write(`[evidence-location-acceptance] consumers=${receipt.consumerCount} findings=${receipt.findingCount} warnings=${receipt.warnings.length} digest=${receipt.contentDigest}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
