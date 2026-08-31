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

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    globalExactnessSchema,
    validateGlobalClaimExactnessReceipt
} from '../docs/global-claim-exactness-final.mjs'
import { digestValue, isPlainObject, stable } from '../fact-extractors/lib/canonicalize.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const registryRelative = 'config/testing/post-runtime-producer-registry.json'
export const postRuntimeRegistrySchema = 'fsusblog.post-runtime-producer-registry.v2'
export const observationEnvelopeSchema = 'fsusblog.post-runtime-observation-result-envelope.v1'
export const acceptedClaimsSchema = 'fsusblog.post-runtime-accepted-claims.v1'

const observationEnvelopeSchemaRelative = 'config/schemas/post-runtime-observation-result.schema.json'
const acceptedClaimsSchemaRelative = 'config/schemas/post-runtime-accepted-claims.schema.json'
const modes = Object.freeze(['positive', 'negative', 'boundary', 'failure'])
const digestPattern = /^sha256:[a-f0-9]{64}$/u
const toolVersionPattern = /^[a-z][a-z0-9-]*@[1-9][0-9]*$/u
const unsafeReceiptPath = /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)/iu

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

const prefixedDigest = (value) => `sha256:${String(value ?? '').replace(/^sha256:/u, '')}`

function receiptDigest(receipt)
{
    if (!isPlainObject(receipt)) fail('receipt must be a plain object')
    const content = Object.fromEntries(Object.entries(receipt)
        .filter(([key]) => key !== 'contentDigest'))
    return `sha256:${digestValue(content)}`
}

function assertExactSet(actual, expected, label)
{
    if (!Array.isArray(actual) || new Set(actual).size !== actual.length
        || JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort()))
    {
        fail(`${label} must exact-match ${[...expected].sort().join(', ')}`)
    }
}

function assertExactKeys(value, expected, label)
{
    if (!isPlainObject(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
    {
        fail(`${label} has missing or unknown fields`)
    }
}

function currentReceiptFile(repositoryRoot, relative, label)
{
    if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)
        || relative.includes('\\') || unsafeReceiptPath.test(relative) || !relative.endsWith('.json'))
    {
        fail(`${label} must be an explicit current-run JSON path`)
    }
    const resolvedRoot = path.resolve(repositoryRoot)
    const absolute = path.resolve(resolvedRoot, relative)
    if (!absolute.startsWith(`${resolvedRoot}${path.sep}`))
    {
        fail(`${label} escapes the repository root`)
    }
    for (let cursor = absolute; cursor !== resolvedRoot; cursor = path.dirname(cursor))
    {
        const cursorStat = fs.lstatSync(cursor, { throwIfNoEntry: false })
        if (!cursorStat || cursorStat.isSymbolicLink())
        {
            fail(`${label} must not traverse a symlink or missing ancestor`)
        }
    }
    const stat = fs.lstatSync(absolute)
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`)
    return absolute
}

export const BehaviorId = (value) =>
{
    if (typeof value !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(value)) throw new Error(`invalid behavior ID ${value}`)
    return value
}

export function loadPostRuntimeProducerRegistry(repositoryRoot = root)
{
    return readJson(repositoryRoot, registryRelative)
}

export function validatePostRuntimeReceiptSchemas(registry, {
    observationSchema = readJson(root, observationEnvelopeSchemaRelative),
    claimsSchema = readJson(root, acceptedClaimsSchemaRelative)
} = {})
{
    if (observationSchema?.$id !== observationEnvelopeSchema
        || observationSchema.additionalProperties !== false)
    {
        fail('observation envelope schema identity or closed shape drifted')
    }
    if (claimsSchema?.$id !== acceptedClaimsSchema || claimsSchema.additionalProperties !== false)
    {
        fail('accepted-claims schema identity or closed shape drifted')
    }
    const observationSchemas = Object.values(registry.observationClasses ?? {})
        .map((definition) => definition.schema)
    assertExactSet(observationSchema.properties?.schema?.enum, observationSchemas,
        'observation envelope schema identities')
    assertExactSet(observationSchema.properties?.modes?.items?.enum, modes,
        'observation envelope modes')
    assertExactSet(observationSchema.properties?.outcome?.enum,
        Object.keys(registry.receiptSemantics?.terminalOutcomes ?? {}),
        'observation envelope terminal outcomes')
    assertExactSet(observationSchema.required, [
        'schema', 'producerId', 'toolVersion', 'sourceState', 'executionClass',
        'evidenceClass', 'qualificationEligible', 'planned', 'executed', 'outcome',
        'recovered', 'modes', 'terminal', 'semanticFacts', 'candidatePlanRef',
        'sourceReceiptRef', 'canonicalRerunCommand', 'independentVerifyCommand',
        'contentDigest'
    ], 'observation envelope required fields')
    assertExactSet(claimsSchema.required, [
        'schema', 'sourceState', 'producerId', 'toolVersion', 'terminalReceiptRef',
        'migrationLedgerDigest', 'claims', 'status', 'contentDigest'
    ], 'accepted-claims required fields')
    assertExactSet(claimsSchema.properties?.terminalReceiptRef?.required,
        ['path', 'fileDigest', 'contentDigest', 'schema'],
        'accepted terminal receipt reference fields')
    if (claimsSchema.properties?.terminalReceiptRef?.properties?.schema?.const !== globalExactnessSchema)
    {
        fail('accepted-claims terminal schema does not bind #2205 authority')
    }
    return true
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
    assertExactKeys(registry, [
        'schema', 'digestAlgorithm', 'canonicalSerialization', 'receiptSemantics',
        'observationClasses', 'producers'
    ], 'registry')
    if (registry.digestAlgorithm !== 'sha256' || registry.canonicalSerialization !== 'json-utf8-v1')
    {
        fail('registry digest algorithm or canonical serialization drifted')
    }
    const semantics = registry.receiptSemantics
    assertExactKeys(semantics, [
        'observationEnvelopeSchema', 'acceptedClaimsSchema', 'acceptedClaimsToolVersion',
        'acceptedTerminalSchema', 'requiredModes', 'qualifyingEnvelope', 'terminalOutcomes'
    ], 'receipt semantics')
    if (semantics.observationEnvelopeSchema !== observationEnvelopeSchema
        || semantics.acceptedClaimsSchema !== acceptedClaimsSchema
        || semantics.acceptedTerminalSchema !== globalExactnessSchema
        || !toolVersionPattern.test(semantics.acceptedClaimsToolVersion ?? ''))
    {
        fail('receipt semantics schema or accepted-claims tool identity drifted')
    }
    assertExactSet(semantics.requiredModes, modes, 'receipt semantics required modes')
    assertExactKeys(semantics.qualifyingEnvelope, [
        'executionClass', 'evidenceClass', 'qualificationEligible', 'planned',
        'executed', 'outcome', 'recovered'
    ], 'qualifying envelope')
    const qualifying = semantics.qualifyingEnvelope
    if (qualifying.executionClass !== 'correctness' || qualifying.evidenceClass !== 'correctness'
        || qualifying.qualificationEligible !== true || qualifying.planned !== true
        || qualifying.executed !== true || qualifying.outcome !== 'passed'
        || qualifying.recovered !== false)
    {
        fail('qualifying envelope must be clean correctness execution')
    }
    assertExactKeys(semantics.terminalOutcomes, ['passed', 'failed', 'timed-out', 'cancelled'],
        'terminal outcome registry')
    const expectedTerminal = {
        passed: [false, false, false],
        failed: [false, false, false],
        'timed-out': [true, false, true],
        cancelled: [false, true, true]
    }
    for (const [outcome, expected] of Object.entries(expectedTerminal))
    {
        const terminal = semantics.terminalOutcomes[outcome]
        assertExactKeys(terminal, ['timeout', 'cancelled', 'processTreeTerminated'],
            `terminal outcome ${outcome}`)
        if (JSON.stringify([terminal.timeout, terminal.cancelled, terminal.processTreeTerminated])
            !== JSON.stringify(expected))
        {
            fail(`terminal outcome ${outcome} has contradictory process semantics`)
        }
    }

    const classIds = Object.keys(registry.observationClasses ?? {})
    if (classIds.length === 0) fail('observation classes must not be empty')
    for (const [classId, definition] of Object.entries(registry.observationClasses ?? {}))
    {
        assertExactKeys(definition, [
            'schema', 'requiredIdentityFields', 'allowedModes', 'existenceShortcutForbidden'
        ], `observation class ${classId}`)
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
        assertExactSet(definition.allowedModes, modes, `observation class ${classId} allowed modes`)
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
        assertExactKeys(producer, [
            'producerId', 'toolVersion', 'owner', 'behaviorId', 'observationSchema',
            'executionClass', 'requiredIdentities', 'requiredObservations',
            'diagnosticEligible', 'timeoutPolicy', 'cancelPolicy', 'recoveryPolicy',
            'acceptedClaimRefs'
        ], `producer ${producer.producerId ?? 'missing'}`)
        if (!/^[a-z0-9-]+$/u.test(producer.producerId ?? ''))
        {
            fail(`producer id ${producer.producerId} is not canonical`)
        }
        if (!toolVersionPattern.test(producer.toolVersion ?? ''))
        {
            fail(`producer ${producer.producerId} toolVersion is missing or invalid`)
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
        assertExactKeys(producer.requiredObservations, modes,
            `producer ${producer.producerId} required observations`)
        const observedClasses = new Set()
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
            if (new Set(classes).size !== classes.length)
            {
                fail(`producer ${producer.producerId} mode ${mode} has duplicate observation classes`)
            }
            for (const classId of classes)
            {
                if (!registry.observationClasses[classId])
                {
                    fail(`producer ${producer.producerId} references unknown observation class ${classId}`)
                }
                observedClasses.add(classId)
            }
        }
        assertExactSet([...observedClasses], classIds,
            `producer ${producer.producerId} observation class closure`)
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
                .filter((entry) => entry['behaviorId'] === producer.behaviorId)
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

    validatePostRuntimeReceiptSchemas(registry)

    return {
        schema: registry.schema,
        requiredBehaviors,
        producerCount: producers.length,
        observationClassCount: classIds.length,
        warnings: 0
    }
}

function producerFor(registry, producerId)
{
    if (registry?.schema !== postRuntimeRegistrySchema)
    {
        fail(`unexpected registry schema: ${registry?.schema ?? 'missing'}`)
    }
    const producer = (registry.producers ?? []).find((entry) => entry.producerId === producerId)
    if (!producer) fail(`unknown producer ${producerId}`)
    return producer
}

function classForReceipt(registry, receipt, requestedClassId = null)
{
    const matches = Object.entries(registry.observationClasses ?? {})
        .filter(([classId, definition]) => definition.schema === receipt?.schema
            && (requestedClassId === null || classId === requestedClassId))
    if (matches.length !== 1)
    {
        fail(`receipt schema ${receipt?.schema ?? 'missing'} does not resolve exact-one observation class`)
    }
    return { classId: matches[0][0], definition: matches[0][1] }
}

function requiredModesFor(producer, classId)
{
    return Object.entries(producer.requiredObservations)
        .filter(([, classIds]) => classIds.includes(classId))
        .map(([mode]) => mode)
        .sort()
}

export function validateProducerReceiptAgainstRegistry({
    registry,
    producerId,
    receipt,
    classId: requestedClassId = null
})
{
    const producer = producerFor(registry, producerId)
    const { classId, definition } = classForReceipt(registry, receipt, requestedClassId)
    const schema = readJson(root, observationEnvelopeSchemaRelative)
    assertExactKeys(receipt, schema.required, `producer ${producerId} receipt`)
    if (receipt.producerId !== producerId || receipt.toolVersion !== producer.toolVersion)
    {
        fail(`producer ${producerId} receipt producer/tool version mismatch`)
    }
    if (!digestPattern.test(receipt.contentDigest ?? '') || receipt.contentDigest !== receiptDigest(receipt))
    {
        fail(`producer ${producerId} receipt contentDigest mismatch`)
    }
    const identity = receipt?.sourceState ?? receipt?.sourceIdentity ?? {}
    for (const required of definition.requiredIdentityFields)
    {
        if (required === 'contentDigest') continue
        if (identity[required] == null && receipt?.[required] == null)
        {
            fail(`producer ${producerId} receipt is missing ${classId} identity ${required}`)
        }
    }
    if (!/^[a-f0-9]{40}$/u.test(identity.sourceCommit ?? '')
        || !digestPattern.test(prefixedDigest(identity.worktreeFingerprint)))
    {
        fail(`producer ${producerId} receipt source identity is invalid`)
    }
    assertExactSet(receipt.modes, requiredModesFor(producer, classId),
        `producer ${producerId} ${classId} modes`)
    assertExactKeys(receipt.terminal,
        ['timeout', 'cancelled', 'processTreeTerminated', 'priorAttemptDigest'],
        `producer ${producerId} terminal`)
    const expectedTerminal = registry.receiptSemantics.terminalOutcomes[receipt.outcome]
    if (!expectedTerminal
        || receipt.terminal.timeout !== expectedTerminal.timeout
        || receipt.terminal.cancelled !== expectedTerminal.cancelled
        || receipt.terminal.processTreeTerminated !== expectedTerminal.processTreeTerminated)
    {
        fail(`producer ${producerId} receipt terminal outcome is contradictory`)
    }
    if (receipt.recovered === true)
    {
        if (!digestPattern.test(receipt.terminal.priorAttemptDigest ?? ''))
        {
            fail(`producer ${producerId} recovered receipt must bind a prior sealed attempt`)
        }
    }
    else if (receipt.terminal.priorAttemptDigest !== null)
    {
        fail(`producer ${producerId} non-recovered receipt cannot bind a recovery attempt`)
    }
    for (const field of ['candidatePlanRef', 'sourceReceiptRef'])
    {
        assertExactKeys(receipt[field], ['path', 'fileDigest', 'contentDigest'],
            `producer ${producerId} ${field}`)
        if (typeof receipt[field].path !== 'string' || receipt[field].path.length === 0
            || !digestPattern.test(receipt[field].fileDigest)
            || !digestPattern.test(receipt[field].contentDigest))
        {
            fail(`producer ${producerId} ${field} is invalid`)
        }
    }
    if (!isPlainObject(receipt.semanticFacts) || Object.keys(receipt.semanticFacts).length === 0
        || typeof receipt.canonicalRerunCommand !== 'string' || receipt.canonicalRerunCommand.length === 0
        || typeof receipt.independentVerifyCommand !== 'string'
        || receipt.independentVerifyCommand.length === 0)
    {
        fail(`producer ${producerId} receipt lacks semantic facts or replay commands`)
    }
    for (const [field, expected] of Object.entries(registry.receiptSemantics.qualifyingEnvelope))
    {
        if (receipt[field] !== expected)
        {
            fail(`producer ${producerId} receipt ${field} cannot satisfy qualification`)
        }
    }
    return {
        producerId,
        behaviorId: BehaviorId(producer.behaviorId),
        classId,
        qualificationEligible: true,
        warnings: 0
    }
}

export function validateAcceptedClaimsReceiptAgainstRegistry({
    registry,
    producerId,
    receipt,
    repositoryRoot = root,
    migrationLedger = readJson(repositoryRoot, 'config/contracts/document-claim-migration-ledger.json')
})
{
    const producer = producerFor(registry, producerId)
    const schema = readJson(repositoryRoot, acceptedClaimsSchemaRelative)
    assertExactKeys(receipt, schema.required, 'accepted-claims receipt')
    if (receipt.schema !== acceptedClaimsSchema || receipt.status !== 'accepted'
        || receipt.producerId !== producerId
        || receipt.toolVersion !== registry.receiptSemantics.acceptedClaimsToolVersion)
    {
        fail('accepted-claims receipt schema/status/producer/tool version mismatch')
    }
    if (!digestPattern.test(receipt.contentDigest ?? '') || receipt.contentDigest !== receiptDigest(receipt))
    {
        fail('accepted-claims receipt contentDigest mismatch')
    }
    assertExactKeys(receipt.sourceState, ['commit', 'worktreeFingerprint'],
        'accepted-claims source identity')
    if (!/^[a-f0-9]{40}$/u.test(receipt.sourceState.commit ?? '')
        || !digestPattern.test(receipt.sourceState.worktreeFingerprint ?? ''))
    {
        fail('accepted-claims source identity is invalid')
    }
    assertExactKeys(receipt.terminalReceiptRef, ['path', 'fileDigest', 'contentDigest', 'schema'],
        'accepted terminal receipt reference')
    const terminalPath = currentReceiptFile(repositoryRoot, receipt.terminalReceiptRef.path,
        'accepted terminal receipt')
    const terminalBytes = fs.readFileSync(terminalPath)
    const terminalFileDigest = `sha256:${createHash('sha256').update(terminalBytes).digest('hex')}`
    if (receipt.terminalReceiptRef.fileDigest !== terminalFileDigest)
    {
        fail('accepted terminal receipt file digest mismatch')
    }
    const terminal = JSON.parse(terminalBytes.toString('utf8'))
    if (receipt.terminalReceiptRef.schema !== globalExactnessSchema
        || terminal.schema !== globalExactnessSchema
        || receipt.terminalReceiptRef.contentDigest !== prefixedDigest(terminal.contentDigest))
    {
        fail('accepted terminal receipt schema/content digest mismatch')
    }
    validateGlobalClaimExactnessReceipt(terminal)
    if (receipt.sourceState.commit !== terminal.source?.sourceCommit
        || receipt.sourceState.worktreeFingerprint !== prefixedDigest(terminal.source?.worktreeFingerprint))
    {
        fail('accepted terminal receipt source identity mismatch')
    }
    const currentLedgerDigest = `sha256:${digestValue(migrationLedger)}`
    if (receipt.migrationLedgerDigest !== currentLedgerDigest
        || receipt.migrationLedgerDigest !== prefixedDigest(terminal.source?.migrationLedgerDigest))
    {
        fail('accepted terminal receipt migration ledger digest mismatch')
    }
    const owners = new Map()
    for (const scope of migrationLedger.scopes ?? [])
    {
        for (const entry of scope.entries ?? [])
        {
            for (const claimId of entry.claimIds ?? [])
            {
                if (owners.has(claimId)) fail(`claim ${claimId} has duplicate ledger owners`)
                owners.set(claimId, {
                    claimId,
                    behaviorId: BehaviorId(entry.behaviorId),
                    scopeId: scope.scopeId
                })
            }
        }
    }
    const expectedClaims = producer.acceptedClaimRefs.map((claimId) =>
    {
        const owner = owners.get(claimId)
        if (!owner || owner.behaviorId !== producer.behaviorId)
        {
            fail(`accepted claim ${claimId} is absent from the #2205 terminal authority`)
        }
        return owner
    }).sort((left, right) => left.claimId.localeCompare(right.claimId))
    const actualClaims = [...(receipt.claims ?? [])]
        .sort((left, right) => String(left?.claimId).localeCompare(String(right?.claimId)))
    if (new Set(actualClaims.map((entry) => entry?.claimId)).size !== actualClaims.length
        || JSON.stringify(stable(actualClaims)) !== JSON.stringify(stable(expectedClaims)))
    {
        fail('accepted claim set does not exact-match #2205 terminal authority and registry')
    }
    return {
        producerId,
        behaviorId: BehaviorId(producer.behaviorId),
        terminalReceiptDigest: receipt.terminalReceiptRef.contentDigest,
        acceptedClaims: actualClaims.length,
        warnings: 0
    }
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
