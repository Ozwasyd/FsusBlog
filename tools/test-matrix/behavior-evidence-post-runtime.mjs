#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestCatalog } from '../contracts/behavior-contract-catalog.mjs'
import * as schedulerOwner from './scheduler-run-owner.mjs'
import { assertPreRuntimeQualified } from './behavior-evidence-pre-runtime.mjs'
import {
    validateAcceptedClaimsReceiptAgainstRegistry,
    validatePostRuntimeProducerRegistry,
    validateProducerReceiptAgainstRegistry
} from './post-runtime-producer-registry.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const postRuntimeReceiptSchema = 'fsusblog.behavior-evidence-post-runtime-receipt.v1'

const stable = (value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
        : value
const digestValue = (value) => `sha256:${createHash('sha256').update(JSON.stringify(stable(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'contentDigest'))))).digest('hex')}`
const loadJson = (input) => typeof input === 'string' ? JSON.parse(fs.readFileSync(input, 'utf8')) : structuredClone(input)
const normalizeDigest = (value) => String(value ?? '').replace(/^sha256:/u, '')

function fail(message)
{
    throw new Error(`[behavior-evidence-post-runtime] ${message}`)
}

// Admission only: registry-owned class receipts are validated without executing
// their replay commands. The sealed join additionally needs claims and scheduler
// admission; this result alone is never a qualified post-runtime receipt.
export function validatePostRuntimeObservationInputs({ registry, catalog, preRuntimeReceipt, observations })
{
    const pre = assertPreRuntimeQualified(loadJson(preRuntimeReceipt))
    validatePostRuntimeProducerRegistry(registry, { catalog })
    if (normalizeDigest(pre.catalogDigest) !== digestCatalog(catalog)) fail('pre-runtime catalog digest mismatch')
    const contracts = new Map(catalog.contracts.map((contract) => [contract.id, contract]))
    const required = new Map()
    for (const producer of registry.producers)
    {
        const extractorId = contracts.get(producer.behaviorId)?.factExtractorId
        const extractors = catalog.extractors.filter((extractor) => extractor.id === extractorId)
        if (extractors.length !== 1 || extractors[0].path !== producer.owner)
        {
            fail(`${producer.behaviorId} factExtractorId does not match registered producer`)
        }
        for (const classId of new Set(Object.values(producer.requiredObservations).flat()))
        {
            required.set(`${producer.producerId}:${classId}`, { producer, classId, extractorId })
        }
    }
    const seen = new Set()
    const candidateIdentities = new Map()
    let candidatePlan = null
    const results = []
    for (const receipt of observations)
    {
        const matches = [...required.entries()].filter(([, { producer, classId }]) =>
            producer.producerId === receipt.producerId
            && registry.observationClasses[classId].schema === receipt.schema)
        if (matches.length !== 1) fail('orphan or ambiguous observation producer/schema')
        const [key, { producer, classId, extractorId }] = matches[0]
        if (seen.has(key)) fail(`duplicate observation ${key}`)
        seen.add(key)
        validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, classId, receipt })
        const identity = receipt.sourceState
        if (identity.sourceCommit !== pre.sourceIdentity.commit
            || normalizeDigest(identity.worktreeFingerprint) !== normalizeDigest(pre.sourceIdentity.worktreeFingerprint)
            || identity.runId !== pre.runIdentity)
        {
            fail(`${key} source/worktree/run identity mismatch`)
        }
        for (const [name, value] of Object.entries(identity))
        {
            const encoded = JSON.stringify(stable(value))
            if (candidateIdentities.has(name) && candidateIdentities.get(name) !== encoded)
            {
                fail(`${key} cross-candidate identity ${name}`)
            }
            candidateIdentities.set(name, encoded)
        }
        const plan = JSON.stringify(stable(receipt.candidatePlanRef))
        if (candidatePlan !== null && candidatePlan !== plan) fail(`${key} candidate plan mismatch`)
        candidatePlan = plan
        results.push({ behaviorId: producer.behaviorId, extractorId, producerId: producer.producerId, classId, contentDigest: receipt.contentDigest })
    }
    const missing = [...required.keys()].filter((key) => !seen.has(key))
    if (missing.length > 0) fail(`missing observations: ${missing.join(', ')}`)
    if (results.length === 0) fail('post-runtime observation graph cannot be empty')
    return results.sort((left, right) => `${left.producerId}:${left.classId}`.localeCompare(`${right.producerId}:${right.classId}`))
}

export function validatePostRuntimeClaimInputs({ registry, preRuntimeReceipt, acceptedClaims, repositoryRoot = root })
{
    const pre = assertPreRuntimeQualified(loadJson(preRuntimeReceipt))
    const required = new Map(registry.producers.map((producer) => [producer.producerId, producer]))
    const seen = new Set()
    const results = acceptedClaims.map((receipt) =>
    {
        const producer = required.get(receipt.producerId)
        if (!producer || seen.has(receipt.producerId)) fail('orphan or duplicate accepted-claims producer')
        seen.add(receipt.producerId)
        const result = validateAcceptedClaimsReceiptAgainstRegistry({
            registry, producerId: producer.producerId, receipt, repositoryRoot
        })
        if (receipt.sourceState.commit !== pre.sourceIdentity.commit
            || normalizeDigest(receipt.sourceState.worktreeFingerprint) !== normalizeDigest(pre.sourceIdentity.worktreeFingerprint))
        {
            fail(`${producer.behaviorId} accepted claims source/worktree mismatch`)
        }
        return { ...result, contentDigest: receipt.contentDigest }
    })
    const missing = [...required.keys()].filter((producerId) => !seen.has(producerId))
    if (missing.length > 0) fail(`missing accepted claims: ${missing.join(', ')}`)
    return results
}

export function validatePostRuntimeReceipt(receipt)
{
    if (receipt?.schema !== postRuntimeReceiptSchema || receipt?.scope !== 'post-runtime') fail('receipt schema/scope mismatch')
    if (receipt.contentDigest !== digestValue(receipt)) fail('contentDigest mismatch')
    if (receipt.releaseFinalSpawnCountBeforeReceipt !== 0) fail('releaseFinalSpawnCountBeforeReceipt must be 0')
    if (!['ok', 'failed'].includes(receipt.status)) fail('status must be ok or failed')
    if (receipt.status === 'ok' && receipt.failureReasons.length !== 0) fail('status=ok cannot include failures')
    if (receipt.status === 'failed' && receipt.failureReasons.length === 0) fail('status=failed requires failures')
    return receipt
}

function readCurrentJson(input, repositoryRoot)
{
    if (typeof input !== 'string' || !input.endsWith('.json')) fail('explicit current-run JSON receipt path is required')
    const repository = path.resolve(repositoryRoot)
    const absolute = path.resolve(repository, input)
    const relative = path.relative(repository, absolute)
    if (relative.startsWith('..') || path.isAbsolute(relative)
        || /(?:^|[/\\\\])[^/\\\\]*(?:latest|historical|history)[^/\\\\]*(?:[/\\\\]|$)/iu.test(relative))
    {
        fail('receipt must use an explicit current-run repository path')
    }
    const stat = fs.lstatSync(absolute)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || fs.realpathSync(absolute) !== absolute) fail('receipt path must be a canonical single-link file')
    const bytes = fs.readFileSync(absolute)
    return { value: JSON.parse(bytes), ref: relative.replaceAll(path.sep, '/'), fileDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
}

function verifyReferencedReceipt(reference, repositoryRoot)
{
    const loaded = readCurrentJson(reference.path, repositoryRoot)
    if (loaded.fileDigest !== reference.fileDigest
        || normalizeDigest(loaded.value.contentDigest) !== normalizeDigest(reference.contentDigest)
        || digestValue(loaded.value) !== `sha256:${normalizeDigest(reference.contentDigest)}`)
    {
        fail('referenced receipt bytes/content digest mismatch')
    }
    return loaded.value
}

export function joinBehaviorEvidencePostRuntime({
    preRuntimeReceipt,
    catalog,
    registry,
    observationReceipts,
    acceptedClaimsReceipts,
    schedulerEvidence,
    repositoryRoot = root,
    ...unsupported
} = {})
{
    if (Object.keys(unsupported).length > 0) fail('legacy or unknown post-runtime join inputs are forbidden')
    if (!Array.isArray(observationReceipts) || !Array.isArray(acceptedClaimsReceipts))
    {
        fail('explicit observation and accepted-claims receipt arrays are required')
    }
    const pre = assertPreRuntimeQualified(readCurrentJson(preRuntimeReceipt, repositoryRoot).value)
    const behaviorCatalog = readCurrentJson(catalog, repositoryRoot).value
    const producerRegistry = readCurrentJson(registry, repositoryRoot).value
    const observations = observationReceipts.map((input) => readCurrentJson(input, repositoryRoot))
    const claims = acceptedClaimsReceipts.map((input) => readCurrentJson(input, repositoryRoot))
    const results = validatePostRuntimeObservationInputs({
        registry: producerRegistry, catalog: behaviorCatalog, preRuntimeReceipt: pre,
        observations: observations.map((input) => input.value)
    })
    const claimResults = validatePostRuntimeClaimInputs({
        registry: producerRegistry, preRuntimeReceipt: pre,
        acceptedClaims: claims.map((input) => input.value), repositoryRoot
    })
    for (const input of observations)
    {
        verifyReferencedReceipt(input.value.candidatePlanRef, repositoryRoot)
        verifyReferencedReceipt(input.value.sourceReceiptRef, repositoryRoot)
    }
    const scheduler = readCurrentJson(schedulerEvidence, repositoryRoot)
    const admission = scheduler.value
    if (typeof schedulerOwner.schedulerTierAdmissionActivity !== 'function')
    {
        fail('canonical scheduler tier admission authority is required from #2205')
    }
    if (admission.currentTierId !== 'behavior-evidence-post-runtime'
        || admission.targetTierId !== 'release-final'
        || admission.runId !== pre.runIdentity || admission.mode !== 'fresh'
        || admission.sourceState?.commit !== pre.sourceIdentity.commit
        || normalizeDigest(admission.sourceState?.worktreeFingerprint) !== normalizeDigest(pre.sourceIdentity.worktreeFingerprint)
        || admission.releaseFinalSpawnCountBeforeAdmission !== 0)
    {
        fail('scheduler admission run/source/tier/zero-spawn identity mismatch')
    }
    const expectedRef = `.tmp/test-runs/${admission.runId}/scheduler-admissions/${admission.schedulerOwnerToken}-${admission.admissionSequence}-${admission.currentTierId}.json`
    if (scheduler.ref !== expectedRef) fail('scheduler admission path identity mismatch')
    const activity = schedulerOwner.schedulerTierAdmissionActivity({
        runsRoot: path.join(repositoryRoot, '.tmp/test-runs'), admission,
        reference: {
            schema: admission.schema, ref: scheduler.ref, fileDigest: scheduler.fileDigest,
            contentDigest: admission.contentDigest, currentTierId: admission.currentTierId,
            admissionSequence: admission.admissionSequence
        }
    })
    if (activity.status !== 'active') fail(`scheduler admission is not authoritative: ${activity.status}:${activity.reason}`)
    const receipt = {
        schema: postRuntimeReceiptSchema, scope: 'post-runtime', runIdentity: pre.runIdentity,
        sourceIdentity: pre.sourceIdentity,
        candidateIdentity: Object.assign({}, ...observations.map((input) => input.value.sourceState)),
        preRuntimeReceiptDigest: pre.contentDigest, catalogDigest: `sha256:${digestCatalog(behaviorCatalog)}`,
        registryDigest: digestValue(producerRegistry),
        behaviorIds: [...new Set(results.map((result) => result.behaviorId))].sort(),
        requiredRuntimeProducers: producerRegistry.producers.map((producer) => producer.producerId).sort(),
        observedBehaviorResults: results,
        documentClaimDigests: Object.fromEntries(claimResults.map((result) => [result.behaviorId, result.terminalReceiptDigest])),
        observationRefs: observations.map(({ ref, fileDigest, value }) => ({ ref, fileDigest, contentDigest: value.contentDigest })),
        acceptedClaimRefs: claims.map(({ ref, fileDigest, value }) => ({ ref, fileDigest, contentDigest: value.contentDigest })),
        schedulerEvidence: { ref: scheduler.ref, fileDigest: scheduler.fileDigest, contentDigest: admission.contentDigest },
        missing: [], orphans: [], conflicts: [],
        releaseFinalSpawnCountBeforeReceipt: admission.releaseFinalSpawnCountBeforeAdmission,
        status: 'ok', failureReasons: [], contentDigest: null
    }
    receipt.contentDigest = digestValue(receipt)
    return receipt
}

export function verifyBehaviorEvidencePostRuntime({ receipt, ...inputs })
{
    const sealed = readCurrentJson(receipt, inputs.repositoryRoot ?? root).value
    validatePostRuntimeReceipt(sealed)
    const replay = joinBehaviorEvidencePostRuntime(inputs)
    if (sealed.contentDigest !== replay.contentDigest) fail('post-runtime receipt independent replay mismatch')
    return sealed
}
function parseArgs(argv)
{
    const options = { observationReceipts: [], acceptedClaimsReceipts: [] }
    const seen = new Set()
    for (let index = 0; index < argv.length; index += 1)
    {
        const arg = argv[index]
        if (argv[index + 1] == null || argv[index + 1].startsWith('--')) fail(`${arg} requires one value`)
        if (!['--observation', '--accepted-claims'].includes(arg) && seen.has(arg)) fail(`duplicate argument ${arg}`)
        seen.add(arg)
        if (arg === '--pre-runtime') options.preRuntimeReceipt = argv[++index]
        else if (arg === '--catalog') options.catalog = argv[++index]
        else if (arg === '--registry') options.registry = argv[++index]
        else if (arg === '--observation') options.observationReceipts.push(argv[++index])
        else if (arg === '--accepted-claims') options.acceptedClaimsReceipts.push(argv[++index])
        else if (arg === '--scheduler-evidence') options.schedulerEvidence = argv[++index]
        else if (arg === '--verify-receipt') options.verifyReceipt = argv[++index]
        else if (arg === '--out') options.out = argv[++index]
        else fail(`unknown argument ${arg}`)
    }
    return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const options = parseArgs(process.argv.slice(2))
        const inputs = {
            preRuntimeReceipt: options.preRuntimeReceipt,
            catalog: options.catalog,
            registry: options.registry,
            observationReceipts: options.observationReceipts,
            acceptedClaimsReceipts: options.acceptedClaimsReceipts,
            schedulerEvidence: options.schedulerEvidence
        }
        if (options.verifyReceipt && options.out) fail('--verify-receipt and --out are mutually exclusive')
        const receipt = options.verifyReceipt
            ? verifyBehaviorEvidencePostRuntime({ ...inputs, receipt: options.verifyReceipt })
            : joinBehaviorEvidencePostRuntime(inputs)
        validatePostRuntimeReceipt(receipt)
        if (options.out)
        {
            fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true })
            fs.writeFileSync(path.resolve(options.out), `${JSON.stringify(receipt, null, 4)}\n`, { flag: 'wx' })
        }
        if (receipt.status !== 'ok') fail(receipt.failureReasons.join('; '))
        console.log(`[behavior-evidence-post-runtime] ok behaviors=${receipt.behaviorIds.length}`)
    }
    catch (error)
    {
        console.error(error.message)
        process.exitCode = 1
    }
}
