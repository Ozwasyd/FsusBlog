import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
    loadPostRuntimeProducerRegistry,
    postRuntimeRegistrySchema,
    requiredPostRuntimeBehaviors,
    root,
    validatePostRuntimeProducerRegistry,
    validateProducerReceiptAgainstRegistry
} from '../../tools/test-matrix/post-runtime-producer-registry.mjs'

const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/contracts/behavior-contracts.json'), 'utf8'))
const migrationLedger = JSON.parse(fs.readFileSync(path.join(root, 'config/contracts/document-claim-migration-ledger.json'), 'utf8'))
const registry = loadPostRuntimeProducerRegistry(root)

function tampered(modifier)
{
    const clone = structuredClone(registry)
    modifier(clone)
    return clone
}

test('registry derives required behaviors from the BehaviorCatalog and validates exact-one', () =>
{
    const behaviors = requiredPostRuntimeBehaviors(catalog)
    assert.ok(behaviors.includes('browserless-production-correctness'))
    const summary = validatePostRuntimeProducerRegistry(registry, { catalog, migrationLedger })
    assert.equal(summary.schema, postRuntimeRegistrySchema)
    assert.equal(summary.producerCount, behaviors.length)
    assert.equal(summary.warnings, 0)
})

test('missing producer/schema for a post-runtime behavior fails closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => clone.producers.pop()), { catalog }),
        /has no producer mapping/u)
})

test('two producers for the same behavior fail closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => clone.producers.push(structuredClone(clone.producers[0]))), { catalog }),
        /mapped by two producers/u)
})

test('artifact path or job name based mapping fields fail closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => { clone.producers[0].artifactPath = '.tmp/receipt.json' }), { catalog }),
        /forbidden field artifactPath/u)
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => { clone.producers[0].jobName = 'ci-release-final' }), { catalog }),
        /forbidden field jobName/u)
})

test('existence shortcut observation classes fail closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.observationClasses['http-200-class'] = {
                schema: 'fsusblog.observation.http200.v1',
                requiredIdentityFields: ['contentDigest'],
                allowedModes: ['positive'],
                existenceShortcutForbidden: false
            }
        }), { catalog }),
        /must forbid existence shortcuts/u)
})

test('diagnostic qualification fails closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => { clone.producers[0].diagnosticEligible = true }), { catalog }),
        /never accept diagnostic evidence/u)
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => { clone.producers[0].executionClass = 'diagnostic' }), { catalog }),
        /cannot satisfy qualification/u)
})

test('missing required identity binding fails closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].requiredIdentities = ['schedulerRunId']
        }), { catalog }),
        /must bind source identity/u)
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            delete clone.observationClasses['route-response-error'].requiredIdentityFields
        }), { catalog }),
        /must bind contentDigest/u)
})

test('unknown observation type and orphan claim mapping fail closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].requiredObservations.positive.push('screenshot-present')
        }), { catalog }),
        /unknown observation class screenshot-present/u)
    assert.throws(
        () => validatePostRuntimeProducerRegistry(registry, { catalog, migrationLedger: tamperedLedger() }),
        /orphan claim/u)

    function tamperedLedger()
    {
        const clone = structuredClone(migrationLedger)
        for (const scope of clone.scopes)
        {
            for (const entry of scope.entries)
            {
                if (entry.behaviorId === 'browserless-production-correctness') entry.claimIds = ['browserless-production-correctness.tiers']
            }
        }
        return clone
    }
})

test('manual owner/waiver fields and stale schema fail closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => { clone.producers[0].waiver = true }), { catalog }),
        /forbidden field waiver/u)
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => { clone.schema = 'fsusblog.post-runtime-producer-registry.v0' }), { catalog }),
        /unexpected registry schema/u)
})

test('receipt binding validates schema and identities against the registry', () =>
{
    const producer = registry.producers[0]
    const receipt = {
        schema: producer.observationSchema,
        sourceState: {
            sourceCommit: 'a'.repeat(64),
            worktreeFingerprint: 'b'.repeat(64),
            buildIdentity: { artifactId: 'x', receiptDigest: `sha256:${'c'.repeat(64)}` },
            schedulerRunId: 'run-1',
            producerId: producer.producerId
        },
        contentDigest: `sha256:${'d'.repeat(64)}`
    }
    assert.deepEqual(
        validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, receipt }),
        { producerId: producer.producerId, behaviorId: producer.behaviorId, warnings: 0 })

    const wrongSchema = structuredClone(receipt)
    wrongSchema.schema = 'fsusblog.other-receipt.v1'
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, receipt: wrongSchema }),
        /does not match producer schema/u)

    const missingIdentity = structuredClone(receipt)
    delete missingIdentity.sourceState.worktreeFingerprint
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, receipt: missingIdentity }),
        /missing required identity worktreeFingerprint/u)

    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId: 'unknown-producer', receipt }),
        /unknown producer/u)
})
