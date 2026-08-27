import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanFirstAttemptVerdict } from './clean-first-attempt-verifier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inventoryFile = path.join(root, 'config/testing/clean-attempt-consumers.json');
const reliabilityCatalogFile = path.join(
    root,
    'config/testing/release-reliability-scenario-catalog.json'
);
const consumerIds = Object.freeze([
    'browser-contract',
    'production-correctness',
    'release-reliability'
]);
const lifecyclePhases = Object.freeze([
    'measurement',
    'postcondition',
    'precondition',
    'reset'
]);

function sortedUnique(values, label)
{
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value))
    {
        throw new Error(`${label} must be a string array`);
    }
    const normalized = [...new Set(values)].sort();
    if (JSON.stringify(values) !== JSON.stringify(normalized))
    {
        throw new Error(`${label} must be sorted and unique`);
    }
    return normalized;
}

function canonicalMembership(value, fields, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error(`${label} membership is required`);
    }
    const keys = Object.keys(value).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...fields].sort()))
    {
        throw new Error(`${label} membership fields must exactly equal ${[...fields].sort().join(', ')}`);
    }
    return Object.fromEntries(keys.map((key) => [key, sortedUnique(value[key], `${label}.${key}`)]));
}

export function readCleanAttemptConsumerInventory(file = inventoryFile)
{
    return validateCleanAttemptConsumerInventory(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function validateCleanAttemptConsumerInventory(inventory)
{
    if (inventory?.schema !== 'fsusblog.clean-attempt-consumer-inventory.v1'
        || inventory.unifiedVerifier
            !== 'tools/release/clean-first-attempt-verifier.mjs#cleanFirstAttemptVerdict'
        || inventory.migrationState !== 'migrated'
        || inventory.qualificationEligible !== true
        || !Array.isArray(inventory.consumers))
    {
        throw new Error('clean attempt consumer inventory is not migrated to canonical authorities');
    }
    const ids = inventory.consumers.map((consumer) => consumer.id).sort();
    if (JSON.stringify(ids) !== JSON.stringify([...consumerIds].sort()))
    {
        throw new Error('clean attempt consumer inventory must cover the exact three consumers');
    }
    for (const consumer of inventory.consumers)
    {
        sortedUnique(consumer.entrypoints, `${consumer.id}.entrypoints`);
        sortedUnique(consumer.producerKinds, `${consumer.id}.producerKinds`);
        sortedUnique(consumer.outputSchemas, `${consumer.id}.outputSchemas`);
        sortedUnique(consumer.membershipFields, `${consumer.id}.membershipFields`);
        if (consumer.attemptSchema !== 'fsusblog.test-attempt-receipt.v1'
            || consumer.aggregateSchema !== 'fsusblog.test-attempt-aggregate-receipt.v1'
            || consumer.entrypoints.some((entrypoint) => !fs.existsSync(path.join(root, entrypoint))))
        {
            throw new Error(`${consumer.id} inventory schemas or entrypoints are invalid`);
        }
    }
    return inventory;
}

function expectedMembership(consumer, supplied)
{
    if (consumer.id !== 'release-reliability')
    {
        return canonicalMembership(supplied, consumer.membershipFields, `${consumer.id}.expected`);
    }
    const catalog = JSON.parse(fs.readFileSync(reliabilityCatalogFile, 'utf8'));
    return canonicalMembership({
        lifecyclePhases: [...lifecyclePhases],
        scenarioIds: [...catalog.canonicalScenarioIds].sort()
    }, consumer.membershipFields, `${consumer.id}.expected`);
}

function membershipReason(consumerId, expected, actual)
{
    return Object.freeze({
        code: `${consumerId}.membership-mismatch`,
        message: `${consumerId} membership does not exactly match its canonical members`,
        expected,
        actual
    });
}

export function admitBrowserReleaseCleanAttempt({
    consumerId,
    attemptEvidence,
    membership,
    expected: suppliedExpected,
    inventory = readCleanAttemptConsumerInventory()
})
{
    const consumer = inventory.consumers.find((entry) => entry.id === consumerId);
    if (!consumer)
    {
        throw new Error(`unknown clean attempt consumer: ${consumerId}`);
    }
    const attemptVerdict = cleanFirstAttemptVerdict(attemptEvidence);
    if (!attemptVerdict.eligible)
    {
        return Object.freeze({
            schema: 'fsusblog.browser-release-clean-attempt-admission.v1',
            consumerId,
            eligible: false,
            reasons: attemptVerdict.reasons,
            attemptVerdict
        });
    }
    let actual;
    let expected;
    try
    {
        actual = canonicalMembership(membership, consumer.membershipFields, consumerId);
        expected = expectedMembership(consumer, suppliedExpected);
    }
    catch (error)
    {
        return Object.freeze({
            schema: 'fsusblog.browser-release-clean-attempt-admission.v1',
            consumerId,
            eligible: false,
            reasons: Object.freeze([membershipReason(consumerId, null, error.message)]),
            attemptVerdict
        });
    }
    const exact = JSON.stringify(actual) === JSON.stringify(expected);
    return Object.freeze({
        schema: 'fsusblog.browser-release-clean-attempt-admission.v1',
        consumerId,
        eligible: exact,
        reasons: Object.freeze(exact ? [] : [membershipReason(consumerId, expected, actual)]),
        attemptVerdict,
        membership: actual
    });
}
