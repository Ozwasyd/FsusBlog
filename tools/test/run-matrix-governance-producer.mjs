#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import { readCleanAttemptConsumerInventory } from '../release/browser-release-clean-attempt-consumers.mjs';
import { readSemanticOutcomeConsumerInventory } from '../release/semantic-outcome-clean-attempt-consumers.mjs';
import { validateRuntimeStateDomainCatalog } from '../test-matrix/runtime-state-domain-catalog.mjs';
import { readRetryPolicyRegistry } from './attempt-provenance.mjs';
import {
    buildCorrectnessAttemptProducerInventory,
    correctnessAttemptProducerFile
} from './correctness-attempt-producers.mjs';
import { validateCorrectnessAttemptMigration } from './correctness-attempt-migration.mjs';
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
    await import('../check-test-matrix.mjs');
}
