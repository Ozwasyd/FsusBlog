import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { digestCanonical } from './attempt-provenance.mjs';
import {
    correctnessAttemptProducerFile,
    correctnessAttemptProducerIds,
    validateCorrectnessAttemptProducerInventory
} from './correctness-attempt-producers.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const replayInventoryFile = 'config/testing/replay-qualification-producers.json';
const envelopeCatalogFile = 'config/testing/test-execution-envelope-applicability.json';

function readJson(root, relative)
{
    return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function validateReplayAuthority(document)
{
    const unsigned = { ...document, contentDigest: null };
    if (document?.schema !== 'fsusblog.replay-qualification-producers.v1'
        || document.contentDigest !== digestCanonical(unsigned))
    {
        throw new Error('replay qualification producer authority is missing or tampered');
    }
    return document;
}

export function validateCorrectnessAttemptMigration(root = defaultRoot)
{
    const inventory = validateCorrectnessAttemptProducerInventory(
        readJson(root, correctnessAttemptProducerFile),
        root
    );
    const replay = validateReplayAuthority(readJson(root, replayInventoryFile));
    const envelope = readJson(root, envelopeCatalogFile);
    const envelopeIds = new Set((envelope.producers ?? []).map((producer) => producer.producerId));
    const expectedProducerIds = correctnessAttemptProducerIds(root);
    if (inventory.entries.length !== expectedProducerIds.length
        || inventory.entries.some((entry, index) => entry.producerId !== expectedProducerIds[index]))
    {
        throw new Error('correctness attempt migration must cover the exact canonical producer roster');
    }
    for (const entry of inventory.entries)
    {
        if (!entry.producerId.startsWith('physical:'))
        {
            const producerId = entry.authorityBindings.executionEnvelope
                .split('#producer:').at(-1);
            if (!envelopeIds.has(producerId)
                || entry.authorityBindings.executionEnvelope
                    !== `${envelopeCatalogFile}#producer:${producerId}`)
            {
                throw new Error(`${entry.producerId} crosses its execution-envelope authority`);
            }
        }
        else if (entry.authorityBindings.executionEnvelope
            !== 'tools/test/physical-execution-process-tree.mjs#runPhysicalExecution')
        {
            throw new Error(`${entry.producerId} is missing physical execution authority`);
        }
    }
    return Object.freeze({
        schema: 'fsusblog.correctness-attempt-migration-verification.v1',
        status: 'verified',
        producerCount: inventory.entries.length,
        migratedCount: inventory.entries.filter((entry) => entry.migrationState === 'migrated').length,
        qualificationEligibleCount: inventory.entries.filter((entry) => entry.qualificationEligible === true).length,
        inventoryDigest: inventory.contentDigest,
        replayProducerInventoryDigest: replay.contentDigest,
        executionEnvelopeProducerCount: envelopeIds.size,
        authorityKinds: [...inventory.entries[0].externalAuthorityKinds],
        warnings: 0
    });
}

export function assertCorrectnessAttemptExecutionOwner(producerId, executionOwner, root = defaultRoot)
{
    const inventory = readJson(root, correctnessAttemptProducerFile);
    const entry = inventory.entries.find((candidate) => candidate.producerId === producerId);
    if (!entry || entry.executionOwner !== executionOwner
        || entry.attemptAdapter !== 'tools/test/attempt-runner.mjs#runProducerAttempts'
        || entry.migrationState !== 'migrated'
        || entry.qualificationEligible !== true)
    {
        throw new Error(`${producerId} is not admitted by the canonical attempt migration`);
    }
    return Object.freeze({
        producerId,
        executionOwner,
        policyId: entry.policyId,
        authorityBindings: Object.freeze({ ...entry.authorityBindings })
    });
}

export function correctnessAttemptMigrationDigest(root = defaultRoot)
{
    return digestCanonical(validateCorrectnessAttemptMigration(root));
}
