#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { publishCurrentRunEvidenceReference } from './current-run-evidence-publication.mjs';
import { validateEvidenceLocatorRegistry } from './evidence-location-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function option(name)
{
    const index = process.argv.indexOf(name);
    if (index < 0 || !process.argv[index + 1])
    {
        throw new Error(`${name} is required`);
    }
    return process.argv[index + 1];
}

const context = JSON.parse(fs.readFileSync(path.resolve(option('--context')), 'utf8'));
const registry = JSON.parse(fs.readFileSync(path.join(repositoryRoot,
    'config/testing/evidence-locator-registry.json'), 'utf8'));
validateEvidenceLocatorRegistry(registry);
const consumerId = option('--consumer');
const entry = registry.entries.find((candidate) => candidate.consumerId === consumerId);
if (!entry)
{
    throw new Error(`unknown evidence locator consumer: ${consumerId}`);
}
const receipt = publishCurrentRunEvidenceReference({
    authorityId: entry.authorityId,
    context,
    outputPath: option('--output'),
    payloadPath: option('--payload'),
    payloadSchema: option('--payload-schema'),
    producerId: entry.producerId,
    repositoryRoot,
    terminalStatus: option('--terminal-status')
});
process.stdout.write(`${JSON.stringify({ outputBindingKey: entry.outputBindingKey,
    producerReceiptDigest: receipt.producerReceiptDigest })}\n`);
