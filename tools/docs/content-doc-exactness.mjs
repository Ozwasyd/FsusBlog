#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestPath, sealSourceIdentity } from '../fact-extractors/identity.mjs'
import { readFactObservationReceipt } from '../fact-extractors/reader.mjs'
import { digestValue, parseRepositoryClaims } from './doc-claim.mjs'
import { verifyProseClaims } from './prose-claim-verifier/verifier.mjs'
import { resolveFactPath } from './generated-fact-sections/catalog.mjs'
import { renderSectionBody } from './generated-fact-sections/generator.mjs'
import { parseGeneratedMarkers } from './generated-fact-sections/markers.mjs'
import {
    validateMigrationLedgerData,
    validateRepositoryMigrationLedger
} from './check-document-claim-migration-ledger.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const contentBehaviorId = 'article-comment-lifecycle-outbox'
export const mutationSchema = 'fsusblog.content-doc-mutation-evidence.v1'
export const terminalSchema = 'fsusblog.content-doc-exactness-receipt.v1'
const BehaviorId = (value) => value

export const negativeClassIds = Object.freeze([
    'required-outbox-edge-drift',
    'article-transition-reversal',
    'scheduled-pre-due-reversal',
    'rollback-restore-delete-coordinate-omission',
    'deleted-root-descendant-reversal',
    'comment-public-admin-visibility-drift',
    'reply-notification-condition-drift',
    'privacy-forbidden-field-drift',
    'overbroad-prose-claim',
    'generated-as-prose',
    'missing-required-behavior',
    'wrong-generated-anchor',
    'compat-waiver-self-certification-residue'
])

const readJson = (repositoryRoot, relative) =>
    JSON.parse(readFileSync(path.join(repositoryRoot, relative), 'utf8'))

const stableSorted = (values) => [...values].sort((left, right) => left.localeCompare(right))

function seal(payload)
{
    const value = { ...payload, contentDigest: null }
    value.contentDigest = digestValue(value)
    return value
}

function assertTerminalSeal(receipt)
{
    const expected = digestValue({ ...receipt, contentDigest: null })
    if (receipt.contentDigest !== expected) throw new Error('content exactness receipt digest mismatch')
}

function assertComponentSeal(receipt, label)
{
    const payload = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest'))
    if (receipt.contentDigest !== digestValue(payload)) throw new Error(`${label} content digest mismatch`)
}

function contentContract(catalog)
{
    const contract = catalog.contracts.find((entry) => entry.id === contentBehaviorId)
    if (!contract || contract.status !== 'active' || contract.documentationPolicy !== 'required')
    {
        throw new Error('content behavior is not active+required')
    }
    return contract
}

export function scanContentResidues(repositoryRoot = root, { documents = null } = {})
{
    const catalog = readJson(repositoryRoot, 'config/contracts/behavior-contracts.json')
    const paths = contentContract(catalog).documents
    const findings = []
    const residuePattern = /(?:lastReviewedAt|lastVerifiedCommit|manual[- ]reviewed|人工审核可覆盖|可能过时|兼容副本|compat(?:ibility)?\s+(?:copy|table)|\bwaiver\b)/iu
    const statePattern = /\b(?:Draft|Scheduled|Published|Archived|Deleted|Pending|Approved|Rejected|Hidden)\b/gu
    for (const documentPath of paths)
    {
        const text = documents?.[documentPath] ?? readFileSync(path.join(repositoryRoot, documentPath), 'utf8')
        const lines = text.split(/\r?\n/u)
        let generated = false
        let tableStates = new Set()
        let tableStart = null
        const flushTable = () =>
        {
            if (tableStates.size >= 2)
            {
                findings.push({
                    code: 'CONTENT_MANUAL_EXACT_TABLE',
                    documentPath,
                    line: tableStart,
                    states: stableSorted(tableStates)
                })
            }
            tableStates = new Set()
            tableStart = null
        }
        for (let index = 0; index < lines.length; index += 1)
        {
            const line = lines[index]
            if (line.includes('FSUSBLOG-GENERATED:BEGIN'))
            {
                flushTable()
                generated = true
            }
            if (!generated && residuePattern.test(line))
            {
                findings.push({ code: 'CONTENT_FORBIDDEN_RESIDUE', documentPath, line: index + 1 })
            }
            if (!generated && /^\s*\|/u.test(line))
            {
                if (tableStart == null) tableStart = index + 1
                for (const match of line.matchAll(statePattern)) tableStates.add(match[0])
            }
            else
            {
                flushTable()
            }
            if (line.includes('FSUSBLOG-GENERATED:END')) generated = false
        }
        flushTable()
    }
    return findings
}

function repositoryInputs(repositoryRoot)
{
    return {
        ledger: readJson(repositoryRoot, 'config/contracts/document-claim-migration-ledger.json'),
        catalog: readJson(repositoryRoot, 'config/contracts/behavior-contracts.json'),
        lifecycle: readJson(repositoryRoot, 'config/development/document-lifecycle.json'),
        claims: parseRepositoryClaims(repositoryRoot).claims,
        sectionCatalog: readJson(repositoryRoot, 'config/contracts/generated-fact-sections.json')
    }
}

function mustFail(id, action)
{
    try
    {
        action()
    }
    catch (error)
    {
        return { id, status: 'killed', reason: String(error.message ?? error) }
    }
    throw new Error(`negative class survived: ${id}`)
}

export function runContentNegativeClasses({ repositoryRoot = root, observationReceipt })
{
    const input = repositoryInputs(repositoryRoot)
    const contentClaims = input.claims.filter((claim) => claim.declaration.behaviorId === BehaviorId(contentBehaviorId))
    const executable = contentClaims.filter((claim) => claim.declaration.claimType !== 'generated-section')
    const cases = []

    const mutateLedger = (id, mutate) => cases.push(mustFail(id, () =>
    {
        const candidate = structuredClone(input)
        mutate(candidate)
        validateMigrationLedgerData(candidate)
    }))

    const mutateGeneratedFact = (id, sectionId, mutate) => cases.push(mustFail(id, () =>
    {
        const section = input.sectionCatalog.sections.find((entry) => entry.sectionId === sectionId)
        if (!section) throw new Error(`missing generated section ${sectionId}`)
        const value = structuredClone(resolveFactPath(observationReceipt.observations, section.factPath))
        mutate(value)
        const expected = renderSectionBody(section, value).replace(/\n+$/u, '')
        const source = readFileSync(path.join(repositoryRoot, section.documentPath), 'utf8')
        const marker = parseGeneratedMarkers(source, section.documentPath)
            .find((entry) => entry.sectionId === sectionId)
        if (!marker) throw new Error(`missing generated marker ${sectionId}`)
        const actual = marker.body.replace(/\n+$/u, '')
        if (actual !== expected) throw new Error(`generated section drift detected for ${sectionId}`)
    }))

    mutateGeneratedFact('required-outbox-edge-drift', 'content.article.required-outbox-edges', (value) =>
    {
        value.push('new-required-edge')
    })
    mutateGeneratedFact('article-transition-reversal', 'content.article.allowed-transitions', (value) =>
    {
        value.splice(value.indexOf('Update:Published->Archived'), 1)
    })
    cases.push(mustFail('rollback-restore-delete-coordinate-omission', () =>
    {
        const claims = structuredClone(contentClaims)
        claims.find((claim) => claim.declaration.claimId === 'article-comment-lifecycle-outbox.rollback-causal')
            .location.bodyText = 'rollback creates a new publication coordinate from a historical revision while preserving immutable history'
        const result = verifyProseClaims({ claims, receipts: [observationReceipt] })
        if (!result.ok) throw new Error(result.diagnostics[0].code)
    }))
    mutateLedger('overbroad-prose-claim', (candidate) =>
    {
        const keep = 'article-comment-lifecycle-outbox.scheduled-pre-due'
        candidate.claims = candidate.claims.filter((claim) => claim.declaration.claimType === 'generated-section'
            || claim.declaration.behaviorId !== contentBehaviorId || claim.declaration.claimId === keep)
    })
    mutateLedger('generated-as-prose', (candidate) =>
    {
        const claim = candidate.claims.find((entry) => entry.declaration.claimId === 'article-comment-lifecycle-outbox.article-states')
        claim.declaration.claimType = 'binary-relation'
        claim.declaration.factPath = 'facts.article.lifecycle.states'
    })
    mutateLedger('missing-required-behavior', (candidate) =>
    {
        candidate.catalog.contracts.push({
            ...structuredClone(contentContract(candidate.catalog)),
            id: 'new-required-content-behavior'
        })
    })
    mutateLedger('wrong-generated-anchor', (candidate) =>
    {
        candidate.claims.find((entry) => entry.declaration.claimId === 'article-comment-lifecycle-outbox.article-states')
            .declaration.generatedSectionId = 'content.article.wrong-anchor'
    })

    const reverseClaims = structuredClone(contentClaims)
    reverseClaims.find((claim) => claim.declaration.claimId === 'article-comment-lifecycle-outbox.scheduled-pre-due')
        .location.bodyText = 'old current publication coordinate preserves scheduled transition before due'
    cases.push(mustFail('scheduled-pre-due-reversal', () =>
    {
        const result = verifyProseClaims({ claims: reverseClaims, receipts: [observationReceipt] })
        if (!result.ok) throw new Error(result.diagnostics[0].code)
    }))

    const descendants = structuredClone(contentClaims)
    descendants.find((claim) => claim.declaration.claimId === 'article-comment-lifecycle-outbox.deleted-root-public')
        .location.bodyText = 'direct and recursive descendants hide deleted root'
    cases.push(mustFail('deleted-root-descendant-reversal', () =>
    {
        const result = verifyProseClaims({ claims: descendants, receipts: [observationReceipt] })
        if (!result.ok) throw new Error(result.diagnostics[0].code)
    }))

    mutateGeneratedFact('comment-public-admin-visibility-drift', 'content.comment.public-visibility', (value) =>
    {
        value.Pending = true
    })
    mutateGeneratedFact('reply-notification-condition-drift', 'content.comment.notification', (value) =>
    {
        value.publishAdded = 'any-comment-status'
    })
    mutateGeneratedFact('privacy-forbidden-field-drift', 'content.comment.persisted-fields', (value) =>
    {
        value.push('userId')
    })

    cases.push(mustFail('compat-waiver-self-certification-residue', () =>
    {
        const contract = contentContract(input.catalog)
        const documents = Object.fromEntries(contract.documents.map((documentPath) => [
            documentPath,
            readFileSync(path.join(repositoryRoot, documentPath), 'utf8')
        ]))
        documents[contract.documents[0]] += '\nwaiver: manual-reviewed lastVerifiedCommit\n'
        const findings = scanContentResidues(repositoryRoot, { documents })
        if (findings.length > 0) throw new Error(findings[0].code)
    }))

    if (stableSorted(cases.map((entry) => entry.id)).join('\0') !== stableSorted(negativeClassIds).join('\0'))
    {
        throw new Error('content negative class roster drifted')
    }
    return cases
}

export function produceMutationEvidence({ repositoryRoot = root, observationFile })
{
    const source = sealSourceIdentity(repositoryRoot)
    const observation = readFactObservationReceipt(observationFile)
    if (observation.extractorId !== 'content-lifecycle-fact-extractor' || observation.status !== 'ok')
    {
        throw new Error('content mutation evidence requires successful content observation')
    }
    const cases = runContentNegativeClasses({ repositoryRoot, observationReceipt: observation })
    return seal({
        schema: mutationSchema,
        sourceCommit: source.sourceCommit,
        worktreeFingerprint: source.worktreeFingerprint,
        observationDigest: observation.contentDigest,
        cases,
        counts: { required: negativeClassIds.length, killed: cases.length, survived: 0 },
        status: 'ok',
        warnings: []
    })
}

export function produceTerminalReceipt({
    repositoryRoot = root,
    admissionFile,
    proseFile,
    generatedFile,
    observationFile,
    mutationFile
})
{
    const source = sealSourceIdentity(repositoryRoot)
    const admission = JSON.parse(readFileSync(admissionFile, 'utf8'))
    assertTerminalSeal(admission)
    if (admission.status !== 'ok'
        || admission.source?.commit !== source.sourceCommit
        || admission.source?.worktreeFingerprint !== source.worktreeFingerprint)
    {
        throw new Error('BehaviorDoc admission is not current-source successful')
    }
    const prose = JSON.parse(readFileSync(proseFile, 'utf8'))
    const generated = JSON.parse(readFileSync(generatedFile, 'utf8'))
    const observation = readFactObservationReceipt(observationFile)
    const mutation = JSON.parse(readFileSync(mutationFile, 'utf8'))
    assertComponentSeal(prose, 'prose receipt')
    assertComponentSeal(generated, 'generated receipt')
    assertTerminalSeal(mutation)
    if (mutation.schema !== mutationSchema || mutation.status !== 'ok'
        || mutation.counts?.killed !== negativeClassIds.length || mutation.counts?.survived !== 0)
    {
        throw new Error('content mutation receipt is incomplete')
    }
    if ([prose, generated, observation, mutation].some((receipt) =>
        receipt.sourceCommit !== source.sourceCommit
        || receipt.worktreeFingerprint !== source.worktreeFingerprint))
    {
        throw new Error('content exactness component source identity mismatch')
    }

    const ledgerResult = validateRepositoryMigrationLedger(repositoryRoot)
    const inputs = repositoryInputs(repositoryRoot)
    const contract = contentContract(inputs.catalog)
    const currentDocuments = new Set(inputs.lifecycle.documents
        .filter((entry) => entry.status === 'current').map((entry) => entry.path))
    const claims = inputs.claims.filter((claim) => claim.declaration.behaviorId === BehaviorId(contentBehaviorId))
    const generatedClaims = claims.filter((claim) => claim.declaration.claimType === 'generated-section')
    const proseClaims = claims.filter((claim) => claim.declaration.claimType !== 'generated-section')
    const verifiedResults = prose.results.filter((entry) => entry.behaviorId === BehaviorId(contentBehaviorId) && entry.status === 'verified')
    if (stableSorted(verifiedResults.map((entry) => entry.claimId)).join('\0')
        !== stableSorted(proseClaims.map((claim) => claim.declaration.claimId)).join('\0'))
    {
        throw new Error('content prose verification is not exact')
    }
    const checkedSections = generated.sections.filter((entry) => entry.behaviorId === BehaviorId(contentBehaviorId) && entry.status === 'ok')
    if (stableSorted(checkedSections.map((entry) => entry.sectionId)).join('\0')
        !== stableSorted(generatedClaims.map((claim) => claim.declaration.generatedSectionId)).join('\0'))
    {
        throw new Error('content generated section verification is not exact')
    }
    const residues = scanContentResidues(repositoryRoot)
    if (residues.length > 0) throw new Error(`content residue remains: ${JSON.stringify(residues[0])}`)

    const rows = claims.map((claim) => ({
        behaviorId: BehaviorId(contentBehaviorId),
        domain: 'content',
        currentAuthority: claim.location.documentPath,
        current: currentDocuments.has(claim.location.documentPath),
        claimId: claim.declaration.claimId,
        claimType: claim.declaration.claimType === 'generated-section' ? 'generated-section' : 'prose-claim',
        generatedSectionId: claim.declaration.generatedSectionId ?? null,
        factPath: claim.declaration.factPath ?? null,
        headingPath: claim.location.headingPath,
        sourceRange: [claim.location.claimStartLine, claim.location.bodyEndLine ?? claim.location.claimEndLine],
        documentDigest: digestPath(repositoryRoot, claim.location.documentPath),
        observationDigest: observation.contentDigest,
        verifierDigest: claim.declaration.claimType === 'generated-section' ? generated.contentDigest : prose.contentDigest,
        mutationEvidenceDigest: mutation.contentDigest
    })).sort((left, right) => left.claimId.localeCompare(right.claimId))

    return seal({
        schema: terminalSchema,
        sourceCommit: source.sourceCommit,
        worktreeFingerprint: source.worktreeFingerprint,
        authorityDigests: {
            behaviorCatalog: digestPath(repositoryRoot, 'config/contracts/behavior-contracts.json'),
            lifecycle: digestPath(repositoryRoot, 'config/development/document-lifecycle.json'),
            migrationLedger: digestPath(repositoryRoot, 'config/contracts/document-claim-migration-ledger.json'),
            sectionCatalog: digestPath(repositoryRoot, 'config/contracts/generated-fact-sections.json'),
            admission: admission.contentDigest,
            observation: observation.contentDigest,
            proseVerifier: prose.contentDigest,
            generatedVerifier: generated.contentDigest,
            mutation: mutation.contentDigest
        },
        scope: { behaviorIds: [BehaviorId(contentBehaviorId)], documents: [...contract.documents].sort() },
        rows,
        counts: {
            required: claims.length,
            generated: generatedClaims.length,
            prose: proseClaims.length,
            verified: verifiedResults.length,
            missing: 0,
            extra: 0,
            conflict: 0,
            stale: 0,
            residue: 0,
            mutationsKilled: mutation.counts.killed
        },
        ledgerCounts: ledgerResult,
        warnings: [],
        status: 'ok'
    })
}

export function verifyTerminalReceipt(receipt, {
    repositoryRoot = root,
    admissionFile,
    proseFile,
    generatedFile,
    observationFile,
    mutationFile
} = {})
{
    assertTerminalSeal(receipt)
    const componentFiles = { admissionFile, proseFile, generatedFile, observationFile, mutationFile }
    const missing = Object.entries(componentFiles)
        .filter(([, value]) => typeof value !== 'string' || value.length === 0)
        .map(([key]) => key)
    if (missing.length > 0)
    {
        throw new Error(`content exactness independent verification requires ${missing.join(', ')}`)
    }
    const expected = produceTerminalReceipt({ repositoryRoot, ...componentFiles })
    if (JSON.stringify(receipt) !== JSON.stringify(expected))
    {
        throw new Error('content exactness terminal receipt does not match independently recomputed evidence')
    }
    return receipt
}

function parseArgs(argv)
{
    const [command, ...rest] = argv
    const options = { command }
    for (let index = 0; index < rest.length; index += 2)
    {
        const key = rest[index]
        const value = rest[index + 1]
        if (!key?.startsWith('--') || value == null) throw new Error(`invalid argument ${key ?? ''}`)
        options[key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = path.resolve(root, value)
    }
    return options
}

function writeJson(file, value)
{
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const options = parseArgs(process.argv.slice(2))
        if (options.command === 'mutate')
        {
            const receipt = produceMutationEvidence({ observationFile: options.observation })
            writeJson(options.out, receipt)
            console.log(`[content-doc-exactness] mutation ok killed=${receipt.counts.killed} receipt=${options.out}`)
        }
        else if (options.command === 'produce')
        {
            const receipt = produceTerminalReceipt({
                admissionFile: options.admission,
                proseFile: options.prose,
                generatedFile: options.generated,
                observationFile: options.observation,
                mutationFile: options.mutation
            })
            verifyTerminalReceipt(receipt, {
                admissionFile: options.admission,
                proseFile: options.prose,
                generatedFile: options.generated,
                observationFile: options.observation,
                mutationFile: options.mutation
            })
            writeJson(options.out, receipt)
            console.log(`[content-doc-exactness] terminal ok verified=${receipt.counts.verified} receipt=${options.out}`)
        }
        else if (options.command === 'verify')
        {
            const receipt = JSON.parse(readFileSync(options.receipt, 'utf8'))
            verifyTerminalReceipt(receipt, {
                admissionFile: options.admission,
                proseFile: options.prose,
                generatedFile: options.generated,
                observationFile: options.observation,
                mutationFile: options.mutation
            })
            console.log(`[content-doc-exactness] verified ${receipt.contentDigest}`)
        }
        else
        {
            throw new Error('usage: content-doc-exactness.mjs mutate|produce|verify [required paths]')
        }
    }
    catch (error)
    {
        console.error(`[content-doc-exactness] ${error.message}`)
        process.exitCode = 1
    }
}
