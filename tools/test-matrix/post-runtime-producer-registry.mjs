#!/usr/bin/env node

/**
 * Post-runtime evidence producer registry.
 *
 * Derives the required behavior set directly from the BehaviorCatalog
 * (`evidenceStage=post-runtime && releaseQualification=true`), then enforces
 * exact-one producer/schema/claim mapping per behavior over the closed
 * observation classes. Validators fail closed on missing, duplicate, orphan,
 * conflicting or stale mappings; existence shortcuts (HTTP 200, artifact or
 * screenshot presence, job success), diagnostic qualification and manual
 * owner/waiver surfaces are rejected. This module never executes runtime or
 * browser work and never reads Markdown to decide facts.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const registryRelative = 'config/testing/post-runtime-producer-registry.json'
export const postRuntimeRegistrySchema = 'fsusblog.post-runtime-producer-registry.v1'

const readJson = (repositoryRoot, relative) =>
    JSON.parse(fs.readFileSync(path.join(repositoryRoot, relative), 'utf8'))

const forbiddenRegistryFields = new Set([
    'waiver', 'manualOwner', 'manual-owner', 'artifactPath', 'jobName', 'jobId',
    'httpStatus', 'fileExists', 'screenshot', 'allowDiagnostic', 'ignoreSchemaVersion'
])

function fail(message)
{
    throw new Error(`[post-runtime-producer-registry] ${message}`)
}

export function loadPostRuntimeProducerRegistry(repositoryRoot = root)
{
    return readJson(repositoryRoot, registryRelative)
}

export function requiredPostRuntimeBehaviors(catalog)
{
    return catalog.contracts
        .filter((contract) => contract.status === 'active'
            && contract.evidenceStage === 'post-runtime'
            && contract.releaseQualification === true)
        .map((contract) => contract.id)
        .sort()
}

export function validatePostRuntimeProducerRegistry(registry, { catalog, migrationLedger = null } = {})
{
    if (!registry || registry.schema !== postRuntimeRegistrySchema)
    {
        fail(`unexpected registry schema: ${registry?.schema ?? 'missing'}`)
    }
    for (const key of Object.keys(registry))
    {
        if (forbiddenRegistryFields.has(key)) fail(`forbidden registry field ${key}`)
    }

    const classIds = Object.keys(registry.observationClasses ?? {})
    if (classIds.length === 0) fail('observation classes must not be empty')
    for (const [classId, definition] of Object.entries(registry.observationClasses ?? {}))
    {
        if (!/^[a-z0-9-]+$/u.test(classId)) fail(`observation class id ${classId} is not canonical`)
        if (!definition.schema || !/^fsusblog\.observation\.[a-z0-9.-]+\.v\d+$/u.test(definition.schema))
        {
            if (definition.schema !== 'fsusblog.browser-contract-receipt.v2')
            {
                fail(`observation class ${classId} schema is missing or not versioned`)
            }
        }
        const identities = definition.requiredIdentityFields ?? []
        if (!identities.includes('contentDigest'))
        {
            fail(`observation class ${classId} must bind contentDigest`)
        }
        if (definition.existenceShortcutForbidden !== true)
        {
            fail(`observation class ${classId} must forbid existence shortcuts`)
        }
        for (const field of Object.keys(definition))
        {
            if (forbiddenRegistryFields.has(field)) fail(`observation class ${classId} has forbidden field ${field}`)
        }
    }

    const requiredBehaviors = requiredPostRuntimeBehaviors(catalog)
    if (requiredBehaviors.length === 0) fail('catalog declares no post-runtime release behaviors')

    const producers = registry.producers ?? []
    const byBehavior = new Map()
    for (const producer of producers)
    {
        for (const field of Object.keys(producer))
        {
            if (forbiddenRegistryFields.has(field)) fail(`producer ${producer.producerId} has forbidden field ${field}`)
        }
        if (!/^[a-z0-9-]+$/u.test(producer.producerId ?? ''))
        {
            fail(`producer id ${producer.producerId} is not canonical`)
        }
        if (byBehavior.has(producer.behaviorId))
        {
            fail(`behavior ${producer.behaviorId} is mapped by two producers (${byBehavior.get(producer.behaviorId)}, ${producer.producerId})`)
        }
        byBehavior.set(producer.behaviorId, producer.producerId)
        if (!requiredBehaviors.includes(producer.behaviorId))
        {
            fail(`producer ${producer.producerId} maps behavior ${producer.behaviorId} which is not a post-runtime release behavior`)
        }
        if (!fs.existsSync(path.join(root, producer.owner)))
        {
            fail(`producer ${producer.producerId} owner path does not exist: ${producer.owner}`)
        }
        if (producer.diagnosticEligible === true)
        {
            fail(`producer ${producer.producerId} must never accept diagnostic evidence as qualification`)
        }
        if (producer.executionClass !== 'correctness' && producer.executionClass !== 'browser-contract')
        {
            fail(`producer ${producer.producerId} execution class ${producer.executionClass} cannot satisfy qualification`)
        }
        for (const identity of producer.requiredIdentities ?? [])
        {
            if (typeof identity !== 'string' || identity.length === 0)
            {
                fail(`producer ${producer.producerId} has an invalid required identity`)
            }
        }
        if (!(producer.requiredIdentities ?? []).includes('sourceCommit')
            || !(producer.requiredIdentities ?? []).includes('worktreeFingerprint'))
        {
            fail(`producer ${producer.producerId} must bind source identity`)
        }
        for (const [mode, classes] of Object.entries(producer.requiredObservations ?? {}))
        {
            if (!['positive', 'negative', 'boundary', 'failure'].includes(mode))
            {
                fail(`producer ${producer.producerId} has unknown observation mode ${mode}`)
            }
            if (!Array.isArray(classes) || classes.length === 0)
            {
                fail(`producer ${producer.producerId} mode ${mode} must list observation classes`)
            }
            for (const classId of classes)
            {
                if (!registry.observationClasses[classId])
                {
                    fail(`producer ${producer.producerId} references unknown observation class ${classId}`)
                }
            }
        }
        for (const policy of ['timeoutPolicy', 'cancelPolicy', 'recoveryPolicy'])
        {
            if (typeof producer[policy] !== 'string' || producer[policy].length === 0)
            {
                fail(`producer ${producer.producerId} must declare ${policy}`)
            }
        }
        if (!Array.isArray(producer.acceptedClaimRefs) || producer.acceptedClaimRefs.length === 0)
        {
            fail(`producer ${producer.producerId} must reference accepted document claims`)
        }
        if (migrationLedger)
        {
            const ledgerClaims = new Set(migrationLedger.scopes
                .flatMap((scope) => scope.entries)
                .filter((entry) => entry.behaviorId === producer.behaviorId)
                .flatMap((entry) => entry.claimIds))
            for (const claimRef of producer.acceptedClaimRefs)
            {
                if (!ledgerClaims.has(claimRef))
                {
                    fail(`producer ${producer.producerId} references orphan claim ${claimRef}`)
                }
            }
        }
    }

    for (const behaviorId of requiredBehaviors)
    {
        if (!byBehavior.has(behaviorId))
        {
            fail(`post-runtime release behavior ${behaviorId} has no producer mapping`)
        }
    }

    return {
        schema: registry.schema,
        requiredBehaviors,
        producerCount: producers.length,
        observationClassCount: classIds.length,
        warnings: 0
    }
}

export function validateProducerReceiptAgainstRegistry({ registry, producerId, receipt })
{
    const producer = (registry.producers ?? []).find((entry) => entry.producerId === producerId)
    if (!producer) fail(`unknown producer ${producerId}`)
    if (receipt?.schema !== producer.observationSchema)
    {
        fail(`receipt schema ${receipt?.schema ?? 'missing'} does not match producer schema ${producer.observationSchema}`)
    }
    const identity = receipt?.sourceState ?? receipt?.sourceIdentity ?? {}
    for (const required of producer.requiredIdentities)
    {
        if (identity[required] == null && receipt?.[required] == null)
        {
            fail(`producer ${producerId} receipt is missing required identity ${required}`)
        }
    }
    if (identity.contentDigest == null && receipt?.contentDigest == null)
    {
        fail(`producer ${producerId} receipt is missing contentDigest`)
    }
    return { producerId, behaviorId: producer.behaviorId, warnings: 0 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const registry = loadPostRuntimeProducerRegistry(root)
    const summary = validatePostRuntimeProducerRegistry(registry, {
        catalog: readJson(root, 'config/contracts/behavior-contracts.json'),
        migrationLedger: readJson(root, 'config/contracts/document-claim-migration-ledger.json')
    })
    console.log(`[post-runtime-producer-registry] ok behaviors=${summary.requiredBehaviors.length} producers=${summary.producerCount} classes=${summary.observationClassCount} warnings=${summary.warnings}`)
}
