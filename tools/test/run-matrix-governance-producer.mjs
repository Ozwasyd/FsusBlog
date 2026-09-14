#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const { readCleanAttemptConsumerInventory } = await import(new URL('../release/browser-release-clean-attempt-consumers.mjs', import.meta.url));
const { readSemanticOutcomeConsumerInventory } = await import(new URL('../release/semantic-outcome-clean-attempt-consumers.mjs', import.meta.url));
const { validateRuntimeStateDomainCatalog } = await import(new URL('../test-matrix/runtime-state-domain-catalog.mjs', import.meta.url));
import { readRetryPolicyRegistry } from './attempt-provenance.mjs';
import { validateCorrectnessAttemptMigration } from './correctness-attempt-migration.mjs';
import {
    buildCorrectnessAttemptProducerInventory,
    correctnessAttemptProducerFile
} from './correctness-attempt-producers.mjs';
import { scanHiddenRetries, validateRetryDispositionRegistry } from './hidden-retry-scanner.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const retryScan = scanHiddenRetries(root);
validateRetryDispositionRegistry(
    root,
    JSON.parse(fs.readFileSync(path.join(root, 'config/testing/retry-disposition-registry.json'), 'utf8')),
    retryScan,
    readRetryPolicyRegistry()
);
readCleanAttemptConsumerInventory();
readSemanticOutcomeConsumerInventory();
validateCorrectnessAttemptMigration(root);
const expectedAttemptInventory = `${JSON.stringify(
    buildCorrectnessAttemptProducerInventory(root),
    null,
    4
)}\n`;
if (fs.readFileSync(path.join(root, correctnessAttemptProducerFile), 'utf8') !== expectedAttemptInventory)
{
    throw new Error(`${correctnessAttemptProducerFile} is stale`);
}

const errors = validateRuntimeStateDomainCatalog();
if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[runtime-state-domain] ${error}`);
    }
    process.exitCode = 1;
}
else
{
    console.log('[runtime-state-domain] ok');
    await import(new URL('../check-test-matrix.mjs', import.meta.url));
}
