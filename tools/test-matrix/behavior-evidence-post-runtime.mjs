#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestCatalog } from '../contracts/behavior-contract-catalog.mjs'
import {
    validateBrowserContractReceipt,
    validateBrowserlessCorrectnessReceipt
} from '../release/test-evidence-receipts.mjs'
import { assertPreRuntimeQualified } from './behavior-evidence-pre-runtime.mjs'

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
const fingerprint = (value) => normalizeDigest(value)

function fail(message)
{
    throw new Error(`[behavior-evidence-post-runtime] ${message}`)
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

export function joinBehaviorEvidencePostRuntime({
    preRuntimeReceipt,
    catalog,
    browserContractReceipt,
    runtimeEvidenceReceipts = [],
    releaseFinalSpawnCountBeforeReceipt = 0
} = {})
{
    const pre = assertPreRuntimeQualified(loadJson(preRuntimeReceipt))
    const behaviorCatalog = loadJson(catalog)
    const failures = []
    const missing = []
    const orphans = []
    const conflicts = []
    const expectedCatalogDigest = digestCatalog(behaviorCatalog)
    if (normalizeDigest(pre.catalogDigest) !== expectedCatalogDigest) failures.push('pre-runtime catalog digest does not match current catalog')
    if (releaseFinalSpawnCountBeforeReceipt !== 0) failures.push('release-final was spawned before post-runtime receipt')

    const browserContract = browserContractReceipt ? loadJson(browserContractReceipt) : null
    if (!browserContract)
    {
        failures.push('required browser contract receipt is missing')
        missing.push({ kind: 'missing-browser-contract', behaviorId: null, anchor: 'browser-contract', reason: 'required browser contract receipt is missing' })
    }
    else
    {
        const browserErrors = validateBrowserContractReceipt(browserContract, {
            expectedCommit: pre.sourceIdentity.commit,
            expectedFingerprint: fingerprint(pre.sourceIdentity.worktreeFingerprint),
            requireSuccess: true
        })
        if (browserContract.runIdentity?.runId !== pre.runIdentity)
        {
            browserErrors.push('browser contract run identity does not match pre-runtime receipt')
        }
        if (browserErrors.length > 0)
        {
            failures.push(...browserErrors.map((reason) => `browser-contract: ${reason}`))
            conflicts.push(...browserErrors.map((reason) => ({ kind: 'browser-contract-conflict', behaviorId: null, anchor: 'browser-contract', reason })))
        }
    }

    const contracts = behaviorCatalog.contracts.filter((contract) =>
        contract.status === 'active' && contract.releaseQualification === true && contract.evidenceStage === 'post-runtime')
    const evidence = runtimeEvidenceReceipts.map(loadJson)
    const expectedSchemas = new Set(contracts.map((contract) => contract.runtimeEvidence?.observationSchema))
    for (const receipt of evidence)
    {
        if (!expectedSchemas.has(receipt.schema)) orphans.push({ kind: 'orphan-runtime-evidence', behaviorId: null, anchor: receipt.schema ?? 'missing-schema', reason: 'runtime receipt schema is not owned by a post-runtime behavior' })
    }

    const results = []
    const documentClaimDigests = {}
    for (const contract of contracts)
    {
        const authority = contract.runtimeEvidence
        const matches = evidence.filter((receipt) => receipt.schema === authority?.observationSchema)
        if (matches.length !== 1)
        {
            const reason = matches.length === 0 ? 'required runtime evidence is missing' : 'runtime evidence producer is ambiguous'
            missing.push({ kind: matches.length === 0 ? 'missing-runtime-evidence' : 'ambiguous-runtime-evidence', behaviorId: contract.id, anchor: authority?.producerTierId ?? 'missing-producer', reason })
            failures.push(`${contract.id}: ${reason}`)
            continue
        }
        const receipt = matches[0]
        const validationErrors = receipt.schema === 'fsusblog.browserless-correctness-receipt.v1'
            ? validateBrowserlessCorrectnessReceipt(receipt, {
                expectedCommit: pre.sourceIdentity.commit,
                expectedFingerprint: fingerprint(pre.sourceIdentity.worktreeFingerprint)
            })
            : [`unsupported runtime observation schema ${receipt.schema}`]
        if (receipt.authority?.runId !== pre.runIdentity)
        {
            validationErrors.push('runtime evidence run identity does not match pre-runtime receipt')
        }
        if (browserContract
            && receipt.build?.receiptContentDigest !== browserContract.buildBinding?.receiptContentDigest)
        {
            validationErrors.push('runtime evidence build identity does not match browser contract')
        }
        if (!receipt.aggregate?.executedTierIds?.includes(authority.producerTierId)
            || !receipt.aggregate?.testIds?.includes(`tier:${authority.producerTierId}`))
        {
            validationErrors.push('runtime evidence lacks the declared producer execution observation')
        }
        if (validationErrors.length > 0)
        {
            failures.push(...validationErrors.map((reason) => `${contract.id}: ${reason}`))
            conflicts.push(...validationErrors.map((reason) => ({ kind: 'runtime-evidence-conflict', behaviorId: contract.id, anchor: authority.producerTierId, reason })))
        }
        results.push({
            behaviorId: contract.id,
            producerTierId: authority.producerTierId,
            observationSchema: authority.observationSchema,
            status: validationErrors.length === 0 ? 'ok' : 'failed',
            evidenceDigest: receipt.contentDigest ?? null
        })
        documentClaimDigests[contract.id] = pre.staticClaimVerificationDigest
    }
    if (contracts.length === 0) failures.push('catalog has no post-runtime release behavior')

    const runtimeReceipt = evidence[0] ?? null
    const uniqueFailures = [...new Set(failures)].sort()
    const receipt = {
        schema: postRuntimeReceiptSchema,
        scope: 'post-runtime',
        runIdentity: pre.runIdentity,
        sourceIdentity: pre.sourceIdentity,
        candidateIdentity: {
            buildReceiptDigest: runtimeReceipt?.build?.receiptContentDigest ?? null,
            runtimeEvidenceDigest: runtimeReceipt?.contentDigest ?? null,
            browserContractDigest: browserContract?.contentDigest ?? null
        },
        preRuntimeReceiptDigest: pre.contentDigest,
        catalogDigest: `sha256:${expectedCatalogDigest}`,
        behaviorIds: contracts.map((contract) => contract.id).sort(),
        requiredRuntimeProducers: contracts.map((contract) => contract.runtimeEvidence.producerTierId).sort(),
        observedBehaviorResults: results.sort((left, right) => left.behaviorId.localeCompare(right.behaviorId)),
        documentClaimDigests,
        missing,
        orphans,
        conflicts,
        releaseFinalSpawnCountBeforeReceipt,
        status: uniqueFailures.length === 0 ? 'ok' : 'failed',
        failureReasons: uniqueFailures,
        contentDigest: null
    }
    receipt.contentDigest = digestValue(receipt)
    return receipt
}

function parseArgs(argv)
{
    const options = { runtime: [] }
    for (let index = 0; index < argv.length; index += 1)
    {
        const arg = argv[index]
        if (arg === '--pre-runtime') options.preRuntimeReceipt = argv[++index]
        else if (arg === '--catalog') options.catalog = argv[++index]
        else if (arg === '--browser-contract') options.browserContractReceipt = argv[++index]
        else if (arg === '--runtime') options.runtime.push(argv[++index])
        else if (arg === '--out') options.out = argv[++index]
        else if (arg === '--release-final-spawn-count') options.releaseFinalSpawnCountBeforeReceipt = Number(argv[++index])
        else fail(`unknown argument ${arg}`)
    }
    return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const options = parseArgs(process.argv.slice(2))
        const receipt = joinBehaviorEvidencePostRuntime({
            preRuntimeReceipt: options.preRuntimeReceipt,
            catalog: options.catalog,
            browserContractReceipt: options.browserContractReceipt,
            runtimeEvidenceReceipts: options.runtime,
            releaseFinalSpawnCountBeforeReceipt: options.releaseFinalSpawnCountBeforeReceipt ?? 0
        })
        validatePostRuntimeReceipt(receipt)
        if (options.out)
        {
            fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true })
            fs.writeFileSync(path.resolve(options.out), `${JSON.stringify(receipt, null, 2)}\n`)
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
