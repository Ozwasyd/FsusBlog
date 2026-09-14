import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfiguredCleanAttemptEvidence } from './clean-attempt-evidence-source.mjs';
import { resolveTransportedCleanAttemptEvidence } from './clean-attempt-evidence-transport.mjs';
import { cleanFirstAttemptVerdict, fileBackedCleanAttemptEvidence } from './clean-first-attempt-verifier.mjs';

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
    if (!attemptEvidence)
    {
        const reason = Object.freeze({
            code: 'attempt.provenance-missing',
            message: 'clean-attempt aggregate and attempt provenance are required',
            producerId: null,
            schedulerRunId: null
        });
        return Object.freeze({
            schema: 'fsusblog.browser-release-clean-attempt-admission.v1',
            consumerId,
            eligible: false,
            reasons: Object.freeze([reason]),
            attemptVerdict: Object.freeze({
                schema: 'fsusblog.clean-first-attempt-verdict.v1',
                eligible: false,
                reasons: Object.freeze([reason]),
                aggregate: null,
                attempt: null
            })
        });
    }
    const expectedIdentity = attemptEvidence?.expectedIdentity ?? {};
    let resolvedTransport = null;
    try
    {
        const transport = attemptEvidence?.transport ?? (
            attemptEvidence?.transportManifestPath
                ? {
                    repositoryRoot: attemptEvidence.repositoryRoot,
                    transportManifestPath: attemptEvidence.transportManifestPath,
                    authorityId: attemptEvidence.authorityId,
                    referencePath: attemptEvidence.referencePath
                }
                : null
        );
        if (transport)
        {
            resolvedTransport = resolveTransportedCleanAttemptEvidence({
                repositoryRoot: transport.repositoryRoot ?? attemptEvidence?.evidenceRoot,
                transportManifestPath: transport.transportManifestPath ?? transport.manifestPath,
                transportManifest: transport.manifest,
                authorityId: transport.authorityId,
                referencePath: transport.referencePath,
                expectedIdentity
            });
        }
    }
    catch (error)
    {
        return Object.freeze({
            schema: 'fsusblog.browser-release-clean-attempt-admission.v1',
            consumerId,
            eligible: false,
            reasons: Object.freeze([Object.freeze({
                code: error.reasonCode ?? 'attempt.transport-manifest-invalid',
                message: error.message,
                producerId: expectedIdentity.producerId ?? null,
                schedulerRunId: expectedIdentity.schedulerRunId ?? null
            })]),
            attemptVerdict: Object.freeze({
                schema: 'fsusblog.clean-first-attempt-verdict.v1',
                eligible: false,
                reasons: Object.freeze([]),
                aggregate: null,
                attempt: null
            })
        });
    }
    const files = fileBackedCleanAttemptEvidence({
        evidenceRoot: resolvedTransport?.evidenceRoot ?? attemptEvidence?.evidenceRoot,
        aggregateReference: resolvedTransport?.aggregateReference ?? attemptEvidence?.aggregateReference,
        transportEntries: resolvedTransport?.transportEntries ?? attemptEvidence?.transportEntries
    });
    const attemptVerdict = cleanFirstAttemptVerdict({
        loadAggregate: files.loadAggregate,
        loadAttempt: files.loadAttempt,
        verifyArtifact: files.verifyArtifact,
        verifyAuthority: attemptEvidence?.verifyAuthority,
        expectedIdentity
    });
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
    const missingIdentity = ['sourceCommit', 'worktreeFingerprint', 'schedulerRunId', 'producerId']
        .find((field) => typeof expectedIdentity[field] !== 'string'
            || !expectedIdentity[field].trim());
    if (missingIdentity)
    {
        return Object.freeze({
            schema: 'fsusblog.browser-release-clean-attempt-admission.v1',
            consumerId,
            eligible: false,
            reasons: Object.freeze([Object.freeze({
                code: 'attempt.consumer-identity-missing',
                message: `consumer must supply the expected ${missingIdentity}`,
                field: missingIdentity,
                producerId: attemptVerdict.attempt.producerId,
                schedulerRunId: attemptVerdict.attempt.schedulerRunId
            })]),
            attemptVerdict
        });
    }
    const domainReference = attemptEvidence?.domainReceiptReference;
    const attempt = attemptVerdict.attempt;
    if (typeof domainReference?.path !== 'string'
        || !attempt.artifactPaths.includes(domainReference.path)
        || !/^sha256:[0-9a-f]{64}$/u.test(String(domainReference?.digest ?? ''))
        || attempt.artifactDigests[domainReference.path] !== domainReference.digest)
    {
        return Object.freeze({
            schema: 'fsusblog.browser-release-clean-attempt-admission.v1',
            consumerId,
            eligible: false,
            reasons: Object.freeze([Object.freeze({
                code: 'attempt.consumer-artifact-mismatch',
                message: 'consumer receipt must be an exact artifact of the verified attempt',
                producerId: attempt.producerId,
                schedulerRunId: attempt.schedulerRunId,
                attemptNumber: attempt.attemptNumber,
                field: 'domainReceiptReference',
                ref: domainReference?.path ?? null,
                expected: attempt.artifactDigests[domainReference?.path] ?? null,
                actual: domainReference?.digest ?? null
            })]),
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

export function requireCleanAttemptConsumerAdmission({
    consumerId,
    attemptEvidence = null,
    repositoryRoot = root,
    environment = process.env
} = {})
{
    const evidence = attemptEvidence
        ?? loadConfiguredCleanAttemptEvidence({ repositoryRoot, environment });
    if (evidence?.consumerId !== undefined && evidence.consumerId !== consumerId)
    {
        throw new Error(`${consumerId} attempt evidence is bound to another consumer`);
    }
    const admission = admitBrowserReleaseCleanAttempt({
        consumerId,
        attemptEvidence: evidence,
        membership: evidence?.membership,
        expected: evidence?.expected
    });
    if (!admission.eligible)
    {
        throw new Error(
            `${consumerId} clean-attempt admission failed: ${admission.reasons
                .map((reason) => reason.code)
                .join(', ')}`
        );
    }
    return admission;
}
