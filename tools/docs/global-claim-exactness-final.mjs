#!/usr/bin/env node

/**
 * Global document-claim exactness terminal gate.
 *
 * Consumes sealed FactObservationReceipts for every registry extractor and
 * validates, across all active required behaviors at once:
 * - the repository migration ledger exactly covers the BehaviorCatalog;
 * - every prose/generated claim and generated section is ledger-owned,
 *   resolves against its owner observation and verifies (no orphan, extra,
 *   conflict or stale entries);
 * - aggregated domain residue scanners report zero forbidden manual
 *   authority surfaces;
 * - aggregated domain mutation evidence is fully killed.
 *
 * Emits the sealed terminal acceptance receipt with exact counters and
 * warnings=0. The gate never greps business source, docs or workflows to
 * manufacture facts; it only consumes the sealed observations.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { digestCatalog, loadCatalog } from '../contracts/behavior-contract-catalog.mjs'
import { digestValue } from '../fact-extractors/identity.mjs'
import { readFactObservationReceipt } from '../fact-extractors/reader.mjs'
import { parseRepositoryClaims } from './doc-claim.mjs'
import { validateRepositoryMigrationLedger } from './check-document-claim-migration-ledger.mjs'
import { scanApiProtocolDocResidue, runApiProtocolDocMutationCases } from './api-protocol-doc-exactness.mjs'
import { scanContentResidues } from './content-doc-exactness.mjs'
import {
    releaseDeploymentBehaviorIds,
    runReleaseDeploymentDocMutationCases,
    scanReleaseDeploymentDocResidue
} from './release-deployment-doc-exactness.mjs'
import { resolveFactPath, verifyProseClaims } from './prose-claim-verifier/verifier.mjs'
import { renderSectionFromReceipt } from './generated-fact-sections/generator.mjs'
import { parseGeneratedMarkers } from './generated-fact-sections/markers.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const globalExactnessScopeId = 'global-document-claim-exactness'
export const globalExactnessSchema = 'fsusblog.global-claim-exactness-terminal-receipt.v1'

const readJson = (repositoryRoot, relative) =>
    JSON.parse(fs.readFileSync(path.join(repositoryRoot, relative), 'utf8'))

const globalForbiddenSurfaces = Object.freeze([
    ['global-self-certification', /(?:lastReviewedAt\s*:|lastVerifiedCommit\s*:|manual(?:ly)?[- ]approved\s*:|self[- ]certified)/iu],
    ['global-hidden-compatibility', /<details\b[^>]*>[\s\S]{0,500}(?:legacy|compat)|compat(?:ibility)?[- ]table|current[- ]equivalent/iu],
    ['global-waiver', /(?:fact|document|protocol|release|deployment|security|content)[ -]?waiver|(?:事实|事實|协议|協議|文档|文件)豁免/iu]
])

function seal(value)
{
    const result = { ...value, contentDigest: null }
    result.contentDigest = digestValue(result)
    return result
}

function sourceOutsideGeneratedSections(source)
{
    const lines = source.split(/\r?\n/u)
    let generated = false
    let fenced = false
    return lines.map((line) =>
    {
        if (/^\s*```/u.test(line)) fenced = !fenced
        if (line.includes('FSUSBLOG-GENERATED:BEGIN')) generated = true
        const retained = generated || fenced ? '' : line
        if (line.includes('FSUSBLOG-GENERATED:END')) generated = false
        return retained
    }).join('\n')
}

export function scanGlobalDocResidue(repositoryRoot, documentPaths)
{
    const findings = []
    for (const documentPath of [...new Set(documentPaths)].sort())
    {
        const absolute = path.join(repositoryRoot, documentPath)
        if (!fs.existsSync(absolute)) continue
        const source = sourceOutsideGeneratedSections(fs.readFileSync(absolute, 'utf8'))
        for (const [classId, pattern] of globalForbiddenSurfaces)
        {
            const match = source.match(pattern)
            if (match) findings.push({ classId, documentPath, evidence: match[0].slice(0, 160) })
        }
    }
    return findings
}

export function runGlobalMutationAggregate()
{
    const api = runApiProtocolDocMutationCases()
    const releaseDeployment = runReleaseDeploymentDocMutationCases()
    const rows = [
        ...api.rows.map((row) => ({ ...row, domain: 'api-protocol' })),
        ...releaseDeployment.rows.map((row) => ({ ...row, domain: 'release-deployment' }))
    ]
    return seal({
        schema: 'fsusblog.global-claim-mutation-aggregate.v1',
        rows,
        killed: rows.filter((row) => row.killed).length,
        total: rows.length
    })
}

export async function loadGlobalExactnessInputs(repositoryRoot, observationReceiptPaths)
{
    const catalog = loadCatalog(path.join(repositoryRoot, 'config/contracts/behavior-contracts.json'))
    const lifecycle = readJson(repositoryRoot, 'config/development/document-lifecycle.json')
    const migrationLedger = readJson(repositoryRoot, 'config/contracts/document-claim-migration-ledger.json')
    const sectionCatalog = readJson(repositoryRoot, 'config/contracts/generated-fact-sections.json')
    const claimReceipt = parseRepositoryClaims(repositoryRoot, { catalog })
    const receipts = observationReceiptPaths.map((entry) =>
    {
        const raw = typeof entry === 'string'
            ? JSON.parse(fs.readFileSync(path.isAbsolute(entry) ? entry : path.join(repositoryRoot, entry), 'utf8'))
            : structuredClone(entry)
        return { raw, view: readFactObservationReceipt(raw) }
    })
    return { catalog, lifecycle, migrationLedger, sectionCatalog, claimReceipt, receipts }
}

export async function buildGlobalClaimExactnessReceipt({
    repositoryRoot = root,
    observationReceiptPaths,
    sourceCommit,
    worktreeFingerprint,
    runId
})
{
    if (typeof runId !== 'string' || runId.length === 0)
    {
        throw new Error('global exactness runId is required')
    }
    const inputs = await loadGlobalExactnessInputs(repositoryRoot, observationReceiptPaths)
    const failureReasons = []
    const required = inputs.catalog.contracts.filter((contract) => contract.status === 'active'
        && contract.documentationPolicy === 'required')
    const requiredById = new Map(required.map((entry) => [entry.id, entry]))

    const ledgerSummary = validateRepositoryMigrationLedger(repositoryRoot)
    if (ledgerSummary.requiredBehaviorCount !== required.length)
    {
        failureReasons.push(`migration ledger covers ${ledgerSummary.requiredBehaviorCount} behaviors but catalog requires ${required.length}`)
    }

    const receiptByExtractor = new Map(inputs.receipts.map((entry) => [entry.view.extractorId, entry.view]))
    for (const contract of required)
    {
        const receipt = receiptByExtractor.get(contract.factExtractorId)
        if (!receipt || receipt.status !== 'ok' || !receipt.behaviorIds.includes(contract.id))
        {
            failureReasons.push(`missing successful observation for ${contract.id}`)
        }
        else if (receipt.sourceCommit !== sourceCommit || receipt.worktreeFingerprint !== worktreeFingerprint)
        {
            failureReasons.push(`stale observation source identity for ${contract.id}`)
        }
    }

    const sectionByBehavior = new Map()
    for (const section of inputs.sectionCatalog.sections)
    {
        if (!requiredById.has(section.behaviorId))
        {
            failureReasons.push(`orphan generated section ${section.sectionId} for behavior ${section.behaviorId}`)
            continue
        }
        const list = sectionByBehavior.get(section.behaviorId) ?? []
        list.push(section)
        sectionByBehavior.set(section.behaviorId, list)
    }

    const claimsByBehavior = new Map()
    for (const claim of inputs.claimReceipt.claims)
    {
        if (!requiredById.has(claim.declaration.behaviorId))
        {
            failureReasons.push(`orphan claim ${claim.declaration.claimId} for behavior ${claim.declaration.behaviorId}`)
            continue
        }
        const list = claimsByBehavior.get(claim.declaration.behaviorId) ?? []
        list.push(claim)
        claimsByBehavior.set(claim.declaration.behaviorId, list)
    }

    let proseTotal = 0
    const proseClaims = []
    let generatedSectionsVerified = 0
    let generatedSectionDrifts = 0
    for (const contract of required)
    {
        const behaviorClaims = claimsByBehavior.get(contract.id) ?? []
        if (behaviorClaims.length === 0) failureReasons.push(`missing claim/section for required behavior ${contract.id}`)
        for (const claim of behaviorClaims)
        {
            const declaration = claim.declaration
            if (declaration.claimType === 'generated-section')
            {
                const section = (sectionByBehavior.get(contract.id) ?? [])
                    .find((entry) => entry.sectionId === declaration.generatedSectionId)
                if (!section)
                {
                    failureReasons.push(`claim ${declaration.claimId} references missing generated section`)
                    continue
                }
                const receipt = receiptByExtractor.get(section.extractorId ?? contract.factExtractorId)
                const fact = receipt ? resolveFactPath(receipt.observations, section.factPath) : undefined
                if (fact === undefined)
                {
                    failureReasons.push(`claim ${declaration.claimId} references missing observation ${section.factPath}`)
                    continue
                }
                const source = fs.readFileSync(path.join(repositoryRoot, claim.location.documentPath), 'utf8')
                const markers = parseGeneratedMarkers(source, claim.location.documentPath)
                const marker = markers.find((entry) => entry.sectionId === section.sectionId)
                const expected = receipt
                    ? renderSectionFromReceipt(section, receipt, null).replace(/\n+$/u, '')
                    : null
                if (!marker)
                {
                    generatedSectionDrifts += 1
                    failureReasons.push(`${section.sectionId} marker missing in ${claim.location.documentPath}`)
                }
                else if (expected !== null && marker.existingBody.replace(/\n+$/u, '') !== expected)
                {
                    generatedSectionDrifts += 1
                    failureReasons.push(`${section.sectionId} generated section drift`)
                }
                else
                {
                    generatedSectionsVerified += 1
                }
            }
            else
            {
                proseTotal += 1
                proseClaims.push(claim)
            }
        }
    }

    const proseVerification = verifyProseClaims({
        claims: proseClaims,
        receipts: inputs.receipts.map((entry) => entry.raw)
    })
    for (const diagnostic of proseVerification.diagnostics)
    {
        failureReasons.push(`${diagnostic.claimId} prose verification ${diagnostic.code}`)
    }

    const documentPaths = required.flatMap((contract) => contract.documents)
    const documentsFor = (contractIds) => required
        .filter((contract) => contractIds.includes(contract.id))
        .flatMap((contract) => contract.documents)
    const residue = [
        ...scanGlobalDocResidue(repositoryRoot, documentPaths),
        ...scanApiProtocolDocResidue(repositoryRoot, documentsFor(['binary-api-aeds-contract'])),
        ...scanContentResidues(repositoryRoot),
        ...scanReleaseDeploymentDocResidue(repositoryRoot, documentsFor([...releaseDeploymentBehaviorIds]))
    ]
    for (const finding of residue)
    {
        failureReasons.push(`${finding.classId} in ${finding.documentPath}`)
    }

    const mutationAggregate = runGlobalMutationAggregate()
    if (mutationAggregate.killed !== mutationAggregate.total)
    {
        failureReasons.push('global mutation aggregate incomplete')
    }

    const uniqueReasons = [...new Set(failureReasons)].sort()
    return seal({
        schema: globalExactnessSchema,
        scopeId: globalExactnessScopeId,
        runId,
        source: {
            sourceCommit,
            worktreeFingerprint,
            catalogDigest: digestCatalog(inputs.catalog),
            migrationLedgerDigest: digestValue(inputs.migrationLedger),
            sectionCatalogDigest: digestValue(inputs.sectionCatalog),
            observationDigests: Object.fromEntries(inputs.receipts.map((entry) =>
                [entry.view.extractorId, digestValue(entry.raw)]))
        },
        authorityDigests: inputs.receipts.map((entry) => entry.view.extractorId),
        counts: {
            requiredBehaviors: required.length,
            scopes: ledgerSummary.scopeCount,
            ledgerEntries: ledgerSummary.entryCount,
            generatedClaimCount: ledgerSummary.generatedClaimCount,
            proseClaimCount: ledgerSummary.proseClaimCount,
            proseTotal,
            proseVerified: proseTotal - proseVerification.diagnostics.length,
            generatedSectionsVerified,
            generatedSectionDrifts,
            missing: required.filter((contract) => !(claimsByBehavior.get(contract.id) ?? []).length).length,
            extra: inputs.claimReceipt.claims.filter((claim) => !requiredById.has(claim.declaration.behaviorId)).length,
            residue: residue.length,
            mutationKilled: mutationAggregate.killed,
            mutationTotal: mutationAggregate.total,
            warnings: 0
        },
        mutationAggregate,
        residue,
        proseVerification,
        status: uniqueReasons.length === 0 ? 'ok' : 'failed',
        failureReasons: uniqueReasons
    })
}

export function validateGlobalClaimExactnessReceipt(receipt, { expectedRunId = null } = {})
{
    if (receipt?.schema !== globalExactnessSchema) throw new Error('unexpected global exactness schema')
    if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify([
        'schema',
        'scopeId',
        'runId',
        'source',
        'authorityDigests',
        'counts',
        'mutationAggregate',
        'residue',
        'proseVerification',
        'status',
        'failureReasons',
        'contentDigest'
    ].sort())) throw new Error('global exactness receipt fields are not sealed')
    if (typeof receipt.runId !== 'string' || receipt.runId.length === 0)
        throw new Error('global exactness runId is required')
    if (expectedRunId !== null && receipt.runId !== expectedRunId)
        throw new Error(`global exactness runId mismatch: expected ${expectedRunId}, got ${receipt.runId}`)
    if (receipt.contentDigest !== digestValue({ ...receipt, contentDigest: null }))
        throw new Error('global exactness contentDigest mismatch')
    if (receipt.status !== 'ok' || receipt.failureReasons.length !== 0
        || receipt.counts.warnings !== 0
        || receipt.counts.missing !== 0
        || receipt.counts.extra !== 0
        || receipt.counts.residue !== 0
        || receipt.counts.generatedSectionDrifts !== 0
        || receipt.counts.proseVerified !== receipt.counts.proseTotal
        || receipt.mutationAggregate.killed !== receipt.mutationAggregate.total)
        throw new Error(`global exactness failed: ${receipt.failureReasons.join('; ')}`)
    return receipt
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const receiptIndex = process.argv.indexOf('--receipts')
    if (receiptIndex < 0) throw new Error('usage: global-claim-exactness-final.mjs --receipts <dir-with-extractor-receipts>')
    const directory = path.resolve(process.argv[receiptIndex + 1])
    const receiptPaths = fs.readdirSync(directory)
        .filter((entry) => entry.endsWith('.json') && entry !== 'receipt-paths.txt')
        .map((entry) => path.join(directory, entry))
    const identity = readFactObservationReceipt(receiptPaths[0])
    const result = await buildGlobalClaimExactnessReceipt({
        repositoryRoot: root,
        observationReceiptPaths: receiptPaths,
        runId: String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim(),
        sourceCommit: identity.sourceCommit,
        worktreeFingerprint: identity.worktreeFingerprint
    })
    validateGlobalClaimExactnessReceipt(result)
    console.log(`[global-claim-exactness-final] ok behaviors=${result.counts.requiredBehaviors} claims=${result.counts.proseClaimCount + result.counts.generatedClaimCount} mutations=${result.counts.mutationKilled}/${result.counts.mutationTotal}`)
}
