#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestCatalog } from '../contracts/behavior-contract-catalog.mjs'
import * as schedulerOwner from './scheduler-run-owner.mjs'
import * as schedulerAuthority from './scheduler.mjs'
import { assertPreRuntimeQualified } from './behavior-evidence-pre-runtime.mjs'
import { validateCurrentRunEvidenceContext } from '../test/evidence-location-contract.mjs'
import { validateJsonSchema } from './schema-validator/validate.mjs'
import {
    authorityDigest,
    canonicalRepositoryFile,
    validateAcceptedClaimsReceiptAgainstRegistry,
    validatePostRuntimeProducerRegistry,
    validateProducerReceiptAgainstRegistry
} from './post-runtime-producer-registry.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const postRuntimeReceiptSchema = 'fsusblog.behavior-evidence-post-runtime-receipt.v1'

export function verifyPostRuntimeSchedulerEvidence({
    admission, reference, verificationMode, schedulerVerificationContext,
    schedulerOutputRefs, repositoryRoot = root
})
{
    if (!['running', 'completed-tier', 'completed-run'].includes(verificationMode))
    {
        fail('explicit scheduler verification mode is required')
    }
    if (!schedulerVerificationContext) fail('independent scheduler verification context is required')
    if (typeof schedulerAuthority.assertSchedulerVerificationContext !== 'function')
    {
        fail('canonical scheduler verification context authority is required from #2205')
    }
    schedulerAuthority.assertSchedulerVerificationContext(schedulerVerificationContext)
    const expected = schedulerVerificationContext
    if (admission.runId !== expected.runId || admission.targetTierId !== expected.targetTierId
        || admission.currentTierId !== 'behavior-evidence-post-runtime'
        || authorityDigest(admission.sourceState) !== authorityDigest(expected.sourceState)
        || admission.schedulerCandidateIdentityDigest !== expected.expectedCandidateIdentityDigest)
    {
        fail('scheduler admission does not match independent caller context')
    }
    const runsRoot = path.join(repositoryRoot, '.tmp/test-runs')
    if (verificationMode === 'running')
    {
        const activity = schedulerOwner.schedulerTierAdmissionActivity({ runsRoot, admission, reference })
        if (activity.status !== 'active') fail(`scheduler admission is not authoritative: ${activity.status}:${activity.reason}`)
        return activity
    }
    return schedulerAuthority.verifyCompletedSchedulerTierEvidence({
        root: repositoryRoot, runsRoot, runId: expected.runId,
        tierId: 'behavior-evidence-post-runtime', admission, admissionReference: reference,
        expectedSourceState: expected.sourceState,
        expectedCandidateIdentityDigest: expected.expectedCandidateIdentityDigest,
        tiers: expected.tiers,
        expectedOutputRefs: schedulerOutputRefs ?? schedulerAuthority.collectSchedulerVerificationOutputRefs({
            context: expected, tierId: 'behavior-evidence-post-runtime', root: repositoryRoot
        }),
        mode: verificationMode
    })
}

const stable = (value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
        : value
const digestValue = (value) => `sha256:${createHash('sha256').update(JSON.stringify(stable(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'contentDigest'))))).digest('hex')}`
const loadJson = (input) => typeof input === 'string' ? JSON.parse(fs.readFileSync(input, 'utf8')) : structuredClone(input)
const normalizeDigest = (value) => String(value ?? '').replace(/^sha256:/u, '')
const sortedUnique = (values) => [...new Set(values)].sort()
const sameSet = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())

function fail(message)
{
    throw new Error(`[behavior-evidence-post-runtime] ${message}`)
}

// Admission only: registry-owned class receipts are validated without executing
// their replay commands. The sealed join additionally needs claims and scheduler
// admission; this result alone is never a qualified post-runtime receipt.
export function validatePostRuntimeObservationInputs({ registry, catalog, preRuntimeReceipt, observations, repositoryRoot = root })
{
    const pre = assertPreRuntimeQualified(loadJson(preRuntimeReceipt))
    validatePostRuntimeProducerRegistry(registry, { catalog, repositoryRoot })
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
        validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, classId, receipt, repositoryRoot })
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
        results.push({ behaviorId: producer.behaviorId, extractorId, producerId: producer.producerId, classId, status: 'ok', contentDigest: receipt.contentDigest })
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
            || normalizeDigest(receipt.sourceState.worktreeFingerprint) !== normalizeDigest(pre.sourceIdentity.worktreeFingerprint)
            || receipt.sourceState.schedulerRunId !== pre.runIdentity)
        {
            fail(`${producer.behaviorId} accepted claims source/worktree mismatch`)
        }
        return { ...result, contentDigest: receipt.contentDigest }
    })
    const missing = [...required.keys()].filter((producerId) => !seen.has(producerId))
    if (missing.length > 0) fail(`missing accepted claims: ${missing.join(', ')}`)
    return results
}

export function joinPostRuntimeIdentities({ preRuntimeReceipt, observations, acceptedClaims, executionContext })
{
    const pre = assertPreRuntimeQualified(preRuntimeReceipt)
    const context = validateCurrentRunEvidenceContext(executionContext)
    const expectedClaims = {
        commit: context.sourceCommit,
        worktreeFingerprint: context.worktreeFingerprint,
        schedulerRunId: context.schedulerRunId,
        attemptId: context.attemptId,
        candidateIdentityDigest: authorityDigest(context.candidateIdentity),
        buildIdentityDigest: authorityDigest(context.buildIdentity)
    }
    if (pre.sourceIdentity.commit !== context.sourceCommit
        || normalizeDigest(pre.sourceIdentity.worktreeFingerprint) !== normalizeDigest(context.worktreeFingerprint)
        || pre.runIdentity !== context.schedulerRunId)
    {
        fail('pre-runtime receipt does not match current-run execution context')
    }
    if (observations.length === 0 || acceptedClaims.length === 0) fail('identity join requires observations and accepted claims')
    for (const receipt of acceptedClaims)
    {
        for (const [field, expected] of Object.entries(expectedClaims))
        {
            if (receipt.sourceState[field] !== expected) fail(`accepted claims ${field} does not match execution context`)
        }
    }
    const observationIdentity = {
        sourceCommit: context.sourceCommit,
        worktreeFingerprint: context.worktreeFingerprint,
        runId: context.schedulerRunId,
        attemptId: context.attemptId,
        candidateId: context.candidateIdentity.id,
        buildIdentity: context.buildIdentity.digest
    }
    for (const receipt of observations)
    {
        for (const [field, expected] of Object.entries(observationIdentity))
        {
            if (receipt.sourceState[field] !== expected) fail(`observation ${field} does not match execution context`)
        }
    }
    return expectedClaims
}

export function validatePostRuntimeReceipt(receipt, { repositoryRoot = root } = {})
{
    if (receipt?.schema !== postRuntimeReceiptSchema || receipt?.scope !== 'post-runtime') fail('receipt schema/scope mismatch')
    if (receipt.contentDigest !== digestValue(receipt)) fail('contentDigest mismatch')
    const schema = readCurrentJson('config/schemas/behavior-evidence-post-runtime-receipt.schema.json', repositoryRoot).value
    const errors = validateJsonSchema(receipt, schema)
    if (errors.length > 0) fail(`receipt schema validation failed: ${errors.join('; ')}`)
    const registry = readCurrentJson('config/testing/post-runtime-producer-registry.json', repositoryRoot).value
    const catalog = readCurrentJson('config/contracts/behavior-contracts.json', repositoryRoot).value
    if (receipt.registryDigest !== authorityDigest(registry)
        || receipt.catalogDigest !== `sha256:${digestCatalog(catalog)}`)
    {
        fail('receipt registry/catalog authority digest mismatch')
    }
    const expectedClasses = Object.fromEntries(registry.producers.map((producer) => [producer.producerId,
        sortedUnique(Object.values(producer.requiredObservations).flat())]))
    if (authorityDigest(receipt.requiredProducerClasses) !== authorityDigest(expectedClasses)
        || !sameSet(receipt.behaviorIds, registry.producers.map((producer) => producer.behaviorId)))
    {
        fail('receipt must include the complete current registry graph')
    }
    for (const result of receipt.observedBehaviorResults)
    {
        const producer = registry.producers.find((entry) => entry.producerId === result.producerId)
        const behavior = catalog.contracts.find((entry) => entry.id === result.behaviorId)
        if (producer?.behaviorId !== result.behaviorId || behavior?.factExtractorId !== result.extractorId)
        {
            fail('receipt behavior/extractor/producer ownership mismatch')
        }
    }
    if (receipt.releaseFinalSpawnCountBeforeReceipt !== 0) fail('releaseFinalSpawnCountBeforeReceipt must be 0')
    if (!['ok', 'failed'].includes(receipt.status)) fail('status must be ok or failed')
    if (receipt.status === 'ok' && receipt.failureReasons.length !== 0) fail('status=ok cannot include failures')
    if (receipt.status === 'failed' && receipt.failureReasons.length === 0) fail('status=failed requires failures')
    for (const category of ['missing', 'orphans', 'conflicts', 'stale', 'diagnostics'])
    {
        if (receipt.findingCounts[category] !== receipt[category].length) fail('finding counts do not match sealed findings')
        if (receipt.status === 'ok' && receipt[category].length !== 0) fail('status=ok cannot include findings')
    }
    if (receipt.executionIdentity.schedulerRunId !== receipt.runIdentity
        || receipt.executionIdentity.commit !== receipt.sourceIdentity.commit
        || receipt.executionIdentity.worktreeFingerprint !== receipt.sourceIdentity.worktreeFingerprint
        || receipt.candidateIdentity.runId !== receipt.runIdentity
        || receipt.candidateIdentity.attemptId !== receipt.executionIdentity.attemptId
        || receipt.candidateIdentity.sourceCommit !== receipt.sourceIdentity.commit
        || receipt.candidateIdentity.worktreeFingerprint !== receipt.sourceIdentity.worktreeFingerprint)
    {
        fail('receipt execution/source/candidate identities do not match')
    }
    const results = receipt.observedBehaviorResults
    if (!sameSet(receipt.behaviorIds, sortedUnique(results.map((result) => result.behaviorId)))
        || !sameSet(receipt.requiredRuntimeProducers, sortedUnique(results.map((result) => result.producerId)))
        || !sameSet(Object.keys(receipt.documentClaimTerminals), receipt.behaviorIds)
        || !sameSet(Object.keys(receipt.requiredProducerClasses), receipt.requiredRuntimeProducers)
        || !sameSet(Object.keys(receipt.observedProducerClasses), receipt.requiredRuntimeProducers))
    {
        fail('receipt behavior/producer maps do not exact-match joined results')
    }
    for (const producerId of receipt.requiredRuntimeProducers)
    {
        const classes = results.filter((result) => result.producerId === producerId).map((result) => result.classId)
        if (!sameSet(classes, receipt.requiredProducerClasses[producerId])
            || !sameSet(classes, receipt.observedProducerClasses[producerId]))
        {
            fail('required/observed producer classes do not exact-match joined results')
        }
    }
    if (receipt.observationRefs.length !== results.length
        || receipt.acceptedClaimRefs.length !== receipt.requiredRuntimeProducers.length
        || !sameSet(receipt.observationRefs.map((reference) => reference.contentDigest), results.map((result) => result.contentDigest)))
    {
        fail('receipt observation references do not exact-match joined results')
    }
    for (const references of [receipt.observationRefs, receipt.acceptedClaimRefs])
    {
        if (new Set(references.map((reference) => reference.ref)).size !== references.length) fail('receipt contains duplicate input references')
    }
    return receipt
}

function readCurrentJson(input, repositoryRoot)
{
    if (typeof input !== 'string' || !input.endsWith('.json')) fail('explicit current-run JSON receipt path is required')
    if (path.normalize(input) !== input || input.split(/[\\/]/u).includes('..')) fail('receipt path must be canonical')
    const repository = path.resolve(repositoryRoot)
    const relative = path.relative(repository, path.resolve(repository, input)).replaceAll(path.sep, '/')
    if (relative.startsWith('..') || path.isAbsolute(relative)
        || /(?:^|[/\\\\])[^/\\\\]*(?:latest|historical|history)[^/\\\\]*(?:[/\\\\]|$)/iu.test(relative))
    {
        fail('receipt must use an explicit current-run repository path')
    }
    const absolute = canonicalRepositoryFile(repository, relative, 'post-runtime input')
    const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try
    {
        const before = fs.fstatSync(descriptor, { bigint: true })
        if (!before.isFile() || before.nlink !== 1n) fail('receipt must remain a single-link regular file')
        const bytes = fs.readFileSync(descriptor)
        const after = fs.fstatSync(descriptor, { bigint: true })
        const current = fs.lstatSync(canonicalRepositoryFile(repository, relative, 'post-runtime input'), { bigint: true })
        for (const field of ['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs'])
        {
            if (before[field] !== after[field] || after[field] !== current[field]) fail('receipt changed while being read')
        }
        return { value: JSON.parse(bytes), ref: relative, fileDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
    }
    finally
    {
        fs.closeSync(descriptor)
    }
}

export function joinBehaviorEvidencePostRuntime({
    preRuntimeReceipt,
    catalog,
    registry,
    observationReceipts,
    acceptedClaimsReceipts,
    executionContext,
    schedulerEvidence,
    verificationMode,
    schedulerVerificationContext,
    schedulerOutputRefs,
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
    const context = readCurrentJson(executionContext, repositoryRoot)
    const executionIdentity = joinPostRuntimeIdentities({
        preRuntimeReceipt: pre, observations: observations.map((input) => input.value),
        acceptedClaims: claims.map((input) => input.value), executionContext: context.value
    })
    const results = validatePostRuntimeObservationInputs({
        registry: producerRegistry, catalog: behaviorCatalog, preRuntimeReceipt: pre,
        observations: observations.map((input) => input.value), repositoryRoot
    })
    const claimResults = validatePostRuntimeClaimInputs({
        registry: producerRegistry, preRuntimeReceipt: pre,
        acceptedClaims: claims.map((input) => input.value), repositoryRoot
    })
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
    verifyPostRuntimeSchedulerEvidence({
        repositoryRoot, admission, verificationMode, schedulerVerificationContext, schedulerOutputRefs,
        reference: {
            schema: admission.schema, ref: scheduler.ref, fileDigest: scheduler.fileDigest,
            contentDigest: admission.contentDigest, currentTierId: admission.currentTierId,
            admissionSequence: admission.admissionSequence
        }
    })
    const receipt = {
        schema: postRuntimeReceiptSchema, scope: 'post-runtime', runIdentity: pre.runIdentity,
        sourceIdentity: pre.sourceIdentity,
        candidateIdentity: Object.assign({}, ...observations.map((input) => input.value.sourceState)),
        executionIdentity,
        executionContext: { ref: context.ref, fileDigest: context.fileDigest, contentDigest: context.value.contentDigest },
        preRuntimeReceiptDigest: pre.contentDigest, catalogDigest: `sha256:${digestCatalog(behaviorCatalog)}`,
        registryDigest: digestValue(producerRegistry),
        behaviorIds: [...new Set(results.map((result) => result.behaviorId))].sort(),
        requiredRuntimeProducers: producerRegistry.producers.map((producer) => producer.producerId).sort(),
        requiredProducerClasses: Object.fromEntries(producerRegistry.producers.map((producer) => [producer.producerId,
            [...new Set(Object.values(producer.requiredObservations).flat())].sort()])),
        observedProducerClasses: Object.fromEntries(producerRegistry.producers.map((producer) => [producer.producerId,
            results.filter((result) => result.producerId === producer.producerId).map((result) => result.classId).sort()])),
        observedBehaviorResults: results,
        documentClaimDigests: Object.fromEntries(claims.flatMap(({ value }) => value.claims.map((claim) => [claim.claimId, claim.claimDigest]))),
        documentClaimTerminals: Object.fromEntries(claimResults.map((result) => [result.behaviorId, result.terminalReceiptDigest])),
        observationRefs: observations.map(({ ref, fileDigest, value }) => ({ ref, fileDigest, contentDigest: value.contentDigest })),
        acceptedClaimRefs: claims.map(({ ref, fileDigest, value }) => ({ ref, fileDigest, contentDigest: value.contentDigest })),
        schedulerEvidence: { ref: scheduler.ref, fileDigest: scheduler.fileDigest, contentDigest: admission.contentDigest },
        missing: [], orphans: [], conflicts: [], stale: [], diagnostics: [],
        findingCounts: { missing: 0, orphans: 0, conflicts: 0, stale: 0, diagnostics: 0 },
        releaseFinalSpawnCountBeforeReceipt: admission.releaseFinalSpawnCountBeforeAdmission,
        status: 'ok', failureReasons: [], contentDigest: null
    }
    receipt.contentDigest = digestValue(receipt)
    validatePostRuntimeReceipt(receipt, { repositoryRoot })
    return receipt
}

export function verifyBehaviorEvidencePostRuntime({ receipt, ...inputs })
{
    const sealed = readCurrentJson(receipt, inputs.repositoryRoot ?? root).value
    validatePostRuntimeReceipt(sealed, { repositoryRoot: inputs.repositoryRoot ?? root })
    const replay = joinBehaviorEvidencePostRuntime(inputs)
    if (sealed.contentDigest !== replay.contentDigest) fail('post-runtime receipt independent replay mismatch')
    return sealed
}

export function postRuntimeObservationPaths(registry, directory)
{
    if (typeof directory !== 'string' || directory.length === 0
        || path.normalize(directory) !== directory || directory.split(/[\\/]/u).includes('..'))
    {
        fail('observation directory must be explicit and canonical')
    }
    const classes = registry.producers.flatMap((producer) => sortedUnique(Object.values(producer.requiredObservations).flat()))
    if (classes.length === 0 || new Set(classes).size !== classes.length)
    {
        fail('class-directory transport requires one unambiguous registered owner per class')
    }
    return classes.sort().map((classId) => path.join(directory, 'classes', `${classId}.json`))
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
        else if (arg === '--observation-directory') options.observationDirectory = argv[++index]
        else if (arg === '--accepted-claims') options.acceptedClaimsReceipts.push(argv[++index])
        else if (arg === '--scheduler-evidence') options.schedulerEvidence = argv[++index]
        else if (arg === '--execution-context') options.executionContext = argv[++index]
        else if (arg === '--verification-mode') options.verificationMode = argv[++index]
        else if (arg === '--scheduler-context') options.schedulerContext = argv[++index]
        else if (arg === '--scheduler-context-digest') options.schedulerContextDigest = argv[++index]
        else if (arg === '--scheduler-run-id') options.schedulerRunId = argv[++index]
        else if (arg === '--scheduler-candidate-digest') options.schedulerCandidateDigest = argv[++index]
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
        if (!['running', 'completed-tier', 'completed-run'].includes(options.verificationMode))
        {
            fail('explicit scheduler verification mode is required')
        }
        if (!options.verifyReceipt && options.verificationMode !== 'running') fail('receipt production requires running verification')
        if (typeof schedulerAuthority.readSchedulerVerificationContext !== 'function')
        {
            fail('canonical scheduler verification context authority is required from #2205')
        }
        const schedulerVerificationContext = schedulerAuthority.readSchedulerVerificationContext({
            file: options.schedulerContext,
            expectedContentDigest: options.schedulerContextDigest,
            expectedRunId: options.schedulerRunId,
            expectedSourceState: await schedulerAuthority.snapshotSourceState(root),
            expectedCandidateIdentityDigest: options.schedulerCandidateDigest
        })
        if (options.observationDirectory)
        {
            if (options.observationReceipts.length > 0) fail('observation directory and explicit receipt list are mutually exclusive')
            options.observationReceipts = postRuntimeObservationPaths(readCurrentJson(options.registry, root).value, options.observationDirectory)
        }
        const inputs = {
            preRuntimeReceipt: options.preRuntimeReceipt,
            catalog: options.catalog,
            registry: options.registry,
            observationReceipts: options.observationReceipts,
            acceptedClaimsReceipts: options.acceptedClaimsReceipts,
            executionContext: options.executionContext,
            schedulerEvidence: options.schedulerEvidence,
            verificationMode: options.verificationMode,
            schedulerVerificationContext
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
