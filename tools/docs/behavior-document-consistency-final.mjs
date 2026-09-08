#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { digestCatalog } from '../contracts/behavior-contract-catalog.mjs'
import {
    semanticDigestFromReceipt,
    validateReceipt as validateFactObservationReceipt
} from '../fact-extractors/receipt.mjs'
import { parseMatrix } from '../test-matrix/parse-matrix.mjs'
import { assertPreRuntimeQualified } from '../test-matrix/behavior-evidence-pre-runtime.mjs'
import { validatePostRuntimeReceipt, verifyBehaviorEvidencePostRuntime } from '../test-matrix/behavior-evidence-post-runtime.mjs'
import { loadPostRuntimeProducerRegistry } from '../test-matrix/post-runtime-producer-registry.mjs'
import { validateBehaviorDocStaticAdmissionReceipt } from './behavior-doc-static-admission.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const finalReportSchema = 'fsusblog.behavior-document-consistency-final-report.v1'

const forbiddenMachineFields = new Set([
    ['last', 'Verified', 'Commit'].join(''),
    ['maximum', 'Verification', 'Distance'].join(''),
    ['last', 'Reviewed', 'Commit'].join(''),
    ['last', 'Reviewed', 'At'].join(''),
    ['content', 'Baseline', 'Sha'].join(''),
    ['approved', 'Content', 'Digest'].join(''),
    ['baseline', 'Value'].join(''),
    ['ignore', 'Difference'].join(''),
    ['allow', 'Stale', 'Until'].join('')
])
const stable = (value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
        : value
const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`
const withoutDigest = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'contentDigest'))
const normalizeDigest = (value) => String(value ?? '').replace(/^sha256:/u, '')
const loadJson = (value) => typeof value === 'string' ? JSON.parse(fs.readFileSync(value, 'utf8')) : structuredClone(value)

function fail(message)
{
    throw new Error(`[behavior-document-consistency-final] ${message}`)
}

function validateSealed(receipt, label, { requireOk = true } = {})
{
    if (!receipt || typeof receipt !== 'object') fail(`${label} is missing`)
    const actual = normalizeDigest(receipt.contentDigest)
    const candidates = [
        normalizeDigest(digest(withoutDigest(receipt))),
        normalizeDigest(digest({ ...receipt, contentDigest: null }))
    ]
    if (!candidates.includes(actual))
    {
        fail(`${label} contentDigest mismatch`)
    }
    if (requireOk && receipt.status !== 'ok') fail(`${label} status is not ok`)
    return receipt
}

function stronglyConnectedComponents(tiers)
{
    const graph = new Map(tiers.map((tier) => [tier.id, tier.executionDependsOn ?? []]))
    let nextIndex = 0
    const indices = new Map()
    const low = new Map()
    const stack = []
    const onStack = new Set()
    const components = []
    const visit = (id) => {
        indices.set(id, nextIndex)
        low.set(id, nextIndex)
        nextIndex += 1
        stack.push(id)
        onStack.add(id)
        for (const dependency of graph.get(id) ?? [])
        {
            if (!graph.has(dependency)) continue
            if (!indices.has(dependency))
            {
                visit(dependency)
                low.set(id, Math.min(low.get(id), low.get(dependency)))
            }
            else if (onStack.has(dependency))
            {
                low.set(id, Math.min(low.get(id), indices.get(dependency)))
            }
        }
        if (low.get(id) === indices.get(id))
        {
            const component = []
            let member
            do
            {
                member = stack.pop()
                onStack.delete(member)
                component.push(member)
            }
            while (member !== id)
            if (component.length > 1 || (graph.get(id) ?? []).includes(id)) components.push(component.sort())
        }
    }
    for (const id of graph.keys()) if (!indices.has(id)) visit(id)
    return components.sort((left, right) => left[0].localeCompare(right[0]))
}

function duplicateSummaryAuthorities(tiers)
{
    const owners = new Map()
    for (const tier of tiers)
    {
        if (!tier.summaryAuthority) continue
        const entries = owners.get(tier.summaryAuthority) ?? []
        entries.push(tier.id)
        owners.set(tier.summaryAuthority, entries)
    }
    return [...owners.entries()]
        .filter(([, tierIds]) => tierIds.length > 1)
        .map(([authority, tierIds]) => ({ authority, tierIds: tierIds.sort() }))
        .sort((left, right) => left.authority.localeCompare(right.authority))
}

function exactStringListErrors(label, actual, expected)
{
    if (!Array.isArray(actual)) return [`${label} is not an array`]
    const normalized = [...actual].sort()
    const duplicateCount = normalized.length - new Set(normalized).size
    const errors = []
    if (duplicateCount > 0) errors.push(`${label} contains duplicate entries`)
    if (JSON.stringify(normalized) !== JSON.stringify(expected))
    {
        errors.push(`${label} does not match the catalog-selected exact set`)
    }
    return errors
}

function auditStaticComponentBinding({
    admission,
    owner,
    facts,
    claims,
    claimVerification,
    generated,
    catalogDigest
})
{
    const errors = []
    const sourceCommit = admission.source.commit
    const worktreeFingerprint = normalizeDigest(admission.source.worktreeFingerprint)
    const expectedFactIds = Object.keys(admission.factObservations).sort()
    const actualFactIds = facts.map((receipt) => receipt.extractorId).sort()

    errors.push(...exactStringListErrors('static fact receipt extractor IDs', actualFactIds, expectedFactIds))
    if (normalizeDigest(owner.contentDigest) !== normalizeDigest(admission.implementationOwner.contentDigest))
    {
        errors.push('implementation owner receipt does not match static admission')
    }
    if (normalizeDigest(owner.catalogDigest) !== normalizeDigest(catalogDigest))
    {
        errors.push('implementation owner catalog digest mismatch')
    }
    if (owner.bindingCount !== admission.implementationOwner.bindingCount)
    {
        errors.push('implementation owner binding count mismatch')
    }

    const factDigests = []
    for (const receipt of facts)
    {
        try
        {
            validateFactObservationReceipt(receipt, {
                expectedSourceCommit: sourceCommit,
                expectedWorktreeFingerprint: worktreeFingerprint
            })
        }
        catch (error)
        {
            errors.push(`${receipt.extractorId ?? 'unknown fact receipt'}: ${error.message}`)
            continue
        }
        const admitted = admission.factObservations[receipt.extractorId]
        if (!admitted) continue
        if (normalizeDigest(receipt.contentDigest) !== normalizeDigest(admitted.contentDigest))
        {
            errors.push(`${receipt.extractorId} content digest does not match static admission`)
        }
        if (normalizeDigest(receipt.extractorDigest) !== normalizeDigest(admitted.extractorDigest))
        {
            errors.push(`${receipt.extractorId} extractor digest does not match static admission`)
        }
        if (normalizeDigest(semanticDigestFromReceipt(receipt)) !== normalizeDigest(admitted.semanticDigest))
        {
            errors.push(`${receipt.extractorId} semantic digest does not match static admission`)
        }
        factDigests.push({
            extractorId: receipt.extractorId,
            contentDigest: normalizeDigest(receipt.contentDigest)
        })
    }
    factDigests.sort((left, right) => left.extractorId.localeCompare(right.extractorId))

    if (normalizeDigest(claims.contentDigest) !== normalizeDigest(admission.authorityDigests.claim))
    {
        errors.push('DocClaim parse receipt does not match static admission')
    }
    if (normalizeDigest(claims.behaviorCatalogDigest) !== normalizeDigest(catalogDigest))
    {
        errors.push('DocClaim parse catalog digest mismatch')
    }
    if (normalizeDigest(claimVerification.contentDigest) !== normalizeDigest(admission.prose.contentDigest))
    {
        errors.push('DocClaim verification receipt does not match static admission')
    }
    if (claimVerification.sourceCommit !== sourceCommit
        || normalizeDigest(claimVerification.worktreeFingerprint) !== worktreeFingerprint)
    {
        errors.push('DocClaim verification source/worktree identity mismatch')
    }
    if (normalizeDigest(claimVerification.catalogDigest) !== normalizeDigest(catalogDigest)
        || normalizeDigest(claimVerification.parseReceiptDigest) !== normalizeDigest(claims.contentDigest))
    {
        errors.push('DocClaim verification catalog/parse receipt binding mismatch')
    }

    const verificationFactDigests = Array.isArray(claimVerification.factObservationDigests)
        ? claimVerification.factObservationDigests
            .map((entry) => ({
                extractorId: entry.extractorId,
                contentDigest: normalizeDigest(entry.contentDigest)
            }))
            .sort((left, right) => left.extractorId.localeCompare(right.extractorId))
        : []
    if (JSON.stringify(verificationFactDigests) !== JSON.stringify(factDigests))
    {
        errors.push('DocClaim verification fact receipt roster mismatch')
    }

    const expectedProseClaims = (claims.claims ?? [])
        .filter((claim) => claim.declaration?.claimType !== 'generated-section')
        .map((claim) => ({
            claimId: claim.declaration?.claimId,
            behaviorId: claim.declaration?.behaviorId,
            documentPath: claim.location?.documentPath
        }))
        .sort((left, right) => left.claimId.localeCompare(right.claimId))
    const verifiedProseClaims = Array.isArray(claimVerification.results)
        ? claimVerification.results
            .map((result) => ({
                claimId: result.claimId,
                behaviorId: result.behaviorId,
                documentPath: result.documentPath,
                status: result.status
            }))
            .sort((left, right) => left.claimId.localeCompare(right.claimId))
        : []
    if (verifiedProseClaims.length !== expectedProseClaims.length
        || verifiedProseClaims.some((result, index) => result.status !== 'verified'
            || result.claimId !== expectedProseClaims[index]?.claimId
            || result.behaviorId !== expectedProseClaims[index]?.behaviorId
            || result.documentPath !== expectedProseClaims[index]?.documentPath))
    {
        errors.push('DocClaim verification result roster does not exact-match parsed prose claims')
    }
    if (admission.prose.verifiedClaimCount !== verifiedProseClaims.length)
    {
        errors.push('DocClaim verified claim count does not match static admission')
    }

    if (normalizeDigest(generated.contentDigest) !== normalizeDigest(admission.generated.contentDigest))
    {
        errors.push('generated section receipt does not match static admission')
    }
    if (generated.sourceCommit !== sourceCommit
        || normalizeDigest(generated.worktreeFingerprint) !== worktreeFingerprint)
    {
        errors.push('generated section source/worktree identity mismatch')
    }
    if (normalizeDigest(generated.catalogDigest) !== normalizeDigest(catalogDigest)
        || normalizeDigest(generated.sectionCatalogDigest)
            !== normalizeDigest(admission.authorityDigests.generatedSectionCatalog))
    {
        errors.push('generated section catalog binding mismatch')
    }
    const generatedFactDigests = Array.isArray(generated.factObservationDigests)
        ? generated.factObservationDigests
            .map((entry) => ({
                extractorId: entry.extractorId,
                contentDigest: normalizeDigest(entry.contentDigest)
            }))
            .sort((left, right) => left.extractorId.localeCompare(right.extractorId))
        : []
    if (JSON.stringify(generatedFactDigests) !== JSON.stringify(factDigests))
    {
        errors.push('generated section fact receipt roster mismatch')
    }
    if (admission.generated.documentCount
        !== new Set((generated.sections ?? []).map((section) => section.documentPath)).size)
    {
        errors.push('generated document count does not match static admission')
    }

    return {
        ownerReceiptDigest: owner.contentDigest,
        factReceiptDigests: factDigests,
        docClaimParseReceiptDigest: claims.contentDigest,
        docClaimVerificationReceiptDigest: claimVerification.contentDigest,
        generatedSectionReceiptDigest: generated.contentDigest,
        errors: [...new Set(errors)].sort()
    }
}

function auditPostRuntimeBinding(post, pre, activeContracts)
{
    const contracts = activeContracts.filter((contract) => contract.evidenceStage === 'post-runtime')
    const expectedBehaviorIds = contracts.map((contract) => contract.id).sort()
    const registry = loadPostRuntimeProducerRegistry()
    const expectedProducerIds = registry.producers.map((producer) => producer.producerId).sort()
    const results = post.observedBehaviorResults
    const errors = []
    if (normalizeDigest(post.preRuntimeReceiptDigest) !== normalizeDigest(pre.contentDigest))
    {
        errors.push('pre-runtime receipt digest mismatch')
    }
    errors.push(...exactStringListErrors('declared post-runtime behavior IDs', post.behaviorIds, expectedBehaviorIds))
    errors.push(...exactStringListErrors('declared runtime producer IDs', post.requiredRuntimeProducers, expectedProducerIds))
    const expectedClaimIds = [...new Set(registry.producers.flatMap((producer) => producer.acceptedClaimRefs))].sort()
    errors.push(...exactStringListErrors('post-runtime document claim IDs', Object.keys(post.documentClaimDigests), expectedClaimIds))
    // The canonical post-runtime validator owns class cardinality, source identity,
    // and observation/claim terminal bindings. One behavior may have several classes.
    // Claim digests identify individual accepted claims, not the pre-runtime bundle.
    return {
        expectedPreRuntimeReceiptDigest: pre.contentDigest,
        observedPreRuntimeReceiptDigest: post.preRuntimeReceiptDigest,
        expectedBehaviorIds,
        declaredBehaviorIds: [...post.behaviorIds].sort(),
        observedBehaviorIds: [...new Set(results.map((result) => result.behaviorId))].sort(),
        expectedProducerIds,
        declaredProducerIds: [...post.requiredRuntimeProducers].sort(),
        observedProducerIds: [...new Set(results.map((result) => result.producerId))].sort(),
        expectedClaimIds,
        observedClaimIds: Object.keys(post.documentClaimDigests).sort(),
        errors: [...new Set(errors)].sort()
    }
}
function scanObjectKeys(value, file, findings, negated = false, location = '$')
{
    if (Array.isArray(value))
    {
        value.forEach((entry, index) => scanObjectKeys(entry, file, findings, negated, `${location}[${index}]`))
        return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, nested] of Object.entries(value))
    {
        if (!negated && forbiddenMachineFields.has(key))
        {
            findings.push({ file, rule: `forbidden-machine-field:${key}`, location: `${location}.${key}` })
        }
        scanObjectKeys(nested, file, findings, negated || key === 'not', `${location}.${key}`)
    }
}

function walkFiles(repositoryRoot, relative, output)
{
    const absolute = path.join(repositoryRoot, relative)
    if (!fs.existsSync(absolute)) return
    const stat = fs.statSync(absolute)
    if (stat.isFile())
    {
        output.push(relative.replaceAll(path.sep, '/'))
        return
    }
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }))
    {
        if (entry.name === 'node_modules' || entry.name === '.tmp' || entry.name === 'bin' || entry.name === 'obj') continue
        walkFiles(repositoryRoot, path.join(relative, entry.name), output)
    }
}

export function scanZeroLegacyGovernance(repositoryRoot = root)
{
    const files = []
    for (const directory of ['config', 'tools/docs', 'tools/fact-extractors', 'tools/contracts', 'tools/test-matrix', 'tools/release', 'tests'])
    {
        walkFiles(repositoryRoot, directory, files)
    }
    const findings = []
    for (const file of files.sort())
    {
        const absolute = path.join(repositoryRoot, file)
        if (file.endsWith('.json'))
        {
            try { scanObjectKeys(JSON.parse(fs.readFileSync(absolute, 'utf8')), file, findings) }
            catch { /* JSON parsing is owned by the corresponding schema gate. */ }
        }
        if (!file.startsWith('tests/')
            && /behavior|doc-claim|fact-extractor|generated-fact|release-final-domain-evidence/u.test(file)
            && /\.(?:mjs|js|ts|cs|sh|ya?ml)$/u.test(file))
        {
            const source = fs.readFileSync(absolute, 'utf8')
            for (const field of forbiddenMachineFields)
            {
                const expression = new RegExp(`\\b${field}\\b\\s*[:=]`, 'u')
                if (expression.test(source)) findings.push({ file, rule: `forbidden-machine-assignment:${field}`, location: 'source' })
            }
        }
    }
    return { scannedFileCount: files.length, findings: findings.sort((a, b) => `${a.file}\0${a.rule}`.localeCompare(`${b.file}\0${b.rule}`)) }
}

export function validateFinalReport(report)
{
    if (report?.schema !== finalReportSchema) fail('report schema mismatch')
    if (report.contentDigest !== digest(withoutDigest(report))) fail('report contentDigest mismatch')
    if (!['ok', 'failed'].includes(report.status)) fail('report status is invalid')
    if (report.status === 'ok' && report.failureReasons.length > 0) fail('ok report has failures')
    if (report.status === 'failed' && report.failureReasons.length === 0) fail('failed report lacks failures')
    return report
}

export function buildFinalConsistencyReport({
    staticAdmissionReceipt,
    preRuntimeReceipt,
    postRuntimeReceipt,
    ownerReceipt,
    factObservationReceipts = [],
    docClaimParseReceipt,
    docClaimVerificationReceipt,
    generatedSectionReceipt,
    catalog,
    migrationLedger,
    matrix,
    zeroLegacyScan = null
} = {})
{
    const admission = validateBehaviorDocStaticAdmissionReceipt(loadJson(staticAdmissionReceipt))
    const pre = assertPreRuntimeQualified(loadJson(preRuntimeReceipt))
    const post = validatePostRuntimeReceipt(loadJson(postRuntimeReceipt))
    if (post.status !== 'ok') fail('post-runtime receipt status is not ok')
    const owner = validateSealed(loadJson(ownerReceipt), 'owner receipt')
    const claims = validateSealed(loadJson(docClaimParseReceipt), 'DocClaim parse receipt', { requireOk: false })
    const claimVerification = validateSealed(loadJson(docClaimVerificationReceipt), 'DocClaim verification receipt')
    const generated = validateSealed(loadJson(generatedSectionReceipt), 'generated section receipt')
    const facts = factObservationReceipts.map((entry, index) => validateSealed(loadJson(entry), `fact receipt ${index}`))
    const behaviorCatalog = loadJson(catalog)
    const ledger = loadJson(migrationLedger)
    const parsedMatrix = typeof matrix === 'string' && matrix.endsWith('.yml')
        ? parseMatrix(fs.readFileSync(matrix, 'utf8'))
        : loadJson(matrix)
    const failures = []
    const sourceCommit = admission.source?.commit
    const sourceFingerprint = normalizeDigest(admission.source?.worktreeFingerprint)
    const identities = [
        ['pre-runtime', pre.sourceIdentity?.commit, pre.sourceIdentity?.worktreeFingerprint, pre.runIdentity],
        ['post-runtime', post.sourceIdentity?.commit, post.sourceIdentity?.worktreeFingerprint, post.runIdentity]
    ]
    for (const [label, commit, fingerprint, runIdentity] of identities)
    {
        if (commit !== sourceCommit || normalizeDigest(fingerprint) !== sourceFingerprint) failures.push(`${label} source/worktree identity mismatch`)
        if (runIdentity !== admission.run?.id) failures.push(`${label} run identity mismatch`)
    }
    const catalogDigest = digestCatalog(behaviorCatalog)
    if (normalizeDigest(admission.authorityDigests?.catalog) !== catalogDigest
        || normalizeDigest(pre.catalogDigest) !== catalogDigest
        || normalizeDigest(post.catalogDigest) !== catalogDigest)
    {
        failures.push('catalog digest mismatch across final inputs')
    }
    const factByBehavior = new Map()
    for (const receipt of facts)
    {
        if (receipt.sourceCommit !== sourceCommit || normalizeDigest(receipt.worktreeFingerprint) !== sourceFingerprint) failures.push(`${receipt.extractorId} source identity mismatch`)
        for (const behaviorId of receipt.behaviorIds ?? [])
        {
            const entries = factByBehavior.get(behaviorId) ?? []
            entries.push(receipt.extractorId)
            factByBehavior.set(behaviorId, entries)
        }
    }
    const ownerByBehavior = new Map((owner.bindings ?? []).map((binding) => [binding.behaviorId, binding]))
    const claimsByBehavior = new Map()
    for (const claim of claims.claims ?? [])
    {
        const behaviorId = claim.declaration?.behaviorId
        const entries = claimsByBehavior.get(behaviorId) ?? []
        entries.push(claim.declaration.claimId)
        claimsByBehavior.set(behaviorId, entries)
    }
    const ledgerEntries = (ledger.scopes ?? []).flatMap((scope) => scope.entries ?? [])
    const ledgerBehaviorIds = [...new Set(ledgerEntries.map((entry) => entry.behaviorId))].sort()
    const activeContracts = behaviorCatalog.contracts.filter((contract) => contract.status === 'active' && contract.releaseQualification === true)
    const staticComponentBinding = auditStaticComponentBinding({
        admission,
        owner,
        facts,
        claims,
        claimVerification,
        generated,
        catalogDigest
    })
    for (const error of staticComponentBinding.errors)
    {
        failures.push(`static component binding: ${error}`)
    }
    const postRuntimeBinding = auditPostRuntimeBinding(post, pre, activeContracts)
    for (const error of postRuntimeBinding.errors)
    {
        failures.push(`post-runtime dependency binding: ${error}`)
    }
    const behaviorNodes = activeContracts.map((contract) => {
        const required = pre.requiredTestKinds?.[contract.id] ?? contract.requiredTestKinds ?? []
        const observed = pre.observedTestKinds?.[contract.id] ?? []
        const runtime = post.observedBehaviorResults?.find((entry) => entry.behaviorId === contract.id)
        const mutation = pre.mutationStatus?.[contract.id] ?? null
        const nodeFailures = []
        if (!ownerByBehavior.has(contract.id)) nodeFailures.push('owner')
        if ((factByBehavior.get(contract.id) ?? []).length !== 1) nodeFailures.push('fact')
        if (contract.documentationPolicy === 'required' && (claimsByBehavior.get(contract.id) ?? []).length === 0) nodeFailures.push('docs')
        if (contract.evidenceStage === 'pre-runtime' && required.some((kind) => !observed.includes(kind))) nodeFailures.push('tests')
        if (contract.mutationPolicy?.mutationRequired === true && mutation?.qualified !== true) nodeFailures.push('mutation')
        if (contract.evidenceStage === 'post-runtime' && runtime?.status !== 'ok') nodeFailures.push('runtime')
        if (nodeFailures.length > 0) failures.push(`${contract.id} incomplete edges: ${nodeFailures.join(',')}`)
        return {
            behaviorId: contract.id,
            evidenceStage: contract.evidenceStage,
            owner: ownerByBehavior.get(contract.id)?.sourcePath ?? null,
            factExtractors: [...new Set(factByBehavior.get(contract.id) ?? [])].sort(),
            requiredTestKinds: [...required].sort(),
            observedTestKinds: [...observed].sort(),
            docClaimIds: [...new Set(claimsByBehavior.get(contract.id) ?? [])].sort(),
            mutationStatus: mutation?.mutationStatus ?? (contract.mutationPolicy?.mutationRequired === true ? 'missing' : 'not-required'),
            runtimeStatus: runtime?.status ?? (contract.evidenceStage === 'post-runtime' ? 'missing' : 'not-required'),
            status: nodeFailures.length === 0 ? 'ok' : 'failed'
        }
    }).sort((left, right) => left.behaviorId.localeCompare(right.behaviorId))
    const activeIds = behaviorNodes.map((node) => node.behaviorId)
    const missingLedgerBehaviorIds = activeIds.filter((id) => behaviorCatalog.contracts.find((contract) => contract.id === id)?.documentationPolicy === 'required' && !ledgerBehaviorIds.includes(id))
    const orphanLedgerBehaviorIds = ledgerBehaviorIds.filter((id) => !activeIds.includes(id))
    if (missingLedgerBehaviorIds.length > 0) failures.push(`migration ledger missing behaviors: ${missingLedgerBehaviorIds.join(',')}`)
    if (orphanLedgerBehaviorIds.length > 0) failures.push(`migration ledger orphan behaviors: ${orphanLedgerBehaviorIds.join(',')}`)
    const sccs = stronglyConnectedComponents(parsedMatrix.tiers)
    const authorityDuplicates = duplicateSummaryAuthorities(parsedMatrix.tiers)
    if (sccs.length > 0) failures.push(`matrix dependency SCCs: ${sccs.map((entry) => entry.join('+')).join(',')}`)
    if (authorityDuplicates.length > 0) failures.push(`duplicate summary authorities: ${authorityDuplicates.map((entry) => entry.authority).join(',')}`)
    const legacy = zeroLegacyScan ?? scanZeroLegacyGovernance(root)
    if (legacy.findings.length > 0) failures.push(`zero-legacy scan found ${legacy.findings.length} active residue(s)`)
    if (admission.candidateSpawnCountBeforeReceipt !== 0 || pre.runtimeCandidateSpawnCountBeforeReceipt !== 0 || post.releaseFinalSpawnCountBeforeReceipt !== 0)
    {
        failures.push('spawn-before-receipt counters must all be zero')
    }
    const uniqueFailures = [...new Set(failures)].sort()
    const report = {
        schema: finalReportSchema,
        sourceIdentity: { commit: sourceCommit, worktreeFingerprint: `sha256:${sourceFingerprint}` },
        worktreeIdentity: { root: admission.worktree?.root ?? null },
        buildIdentity: {
            minimalContractBuildDigest: admission.minimalContractBuild?.contentDigest ? `sha256:${normalizeDigest(admission.minimalContractBuild.contentDigest)}` : null,
            candidateBuildIdentityDigest: post.executionIdentity.buildIdentityDigest
        },
        toolchainIdentity: admission.toolchain,
        runtimeIdentity: { runId: admission.run?.id, candidate: post.candidateIdentity },
        authorityDigests: Object.fromEntries(Object.entries(admission.authorityDigests ?? {}).map(([key, value]) => [key, `sha256:${normalizeDigest(value)}`])),
        receiptDigests: {
            staticAdmission: `sha256:${normalizeDigest(admission.contentDigest)}`,
            preRuntime: pre.contentDigest.startsWith('sha256:') ? pre.contentDigest : `sha256:${pre.contentDigest}`,
            postRuntime: post.contentDigest,
            owner: `sha256:${normalizeDigest(owner.contentDigest)}`,
            docClaimParse: `sha256:${normalizeDigest(claims.contentDigest)}`,
            docClaimVerification: `sha256:${normalizeDigest(claimVerification.contentDigest)}`,
            generatedSection: `sha256:${normalizeDigest(generated.contentDigest)}`,
            facts: facts.map((receipt) => `sha256:${normalizeDigest(receipt.contentDigest)}`).sort()
        },
        behaviorNodes,
        edges: behaviorNodes.flatMap((node) => [
            { behaviorId: node.behaviorId, kind: 'owner', targets: node.owner ? [node.owner] : [] },
            { behaviorId: node.behaviorId, kind: 'fact', targets: node.factExtractors },
            { behaviorId: node.behaviorId, kind: 'test', targets: node.observedTestKinds },
            { behaviorId: node.behaviorId, kind: 'doc', targets: node.docClaimIds },
            { behaviorId: node.behaviorId, kind: 'mutation', targets: [node.mutationStatus] },
            { behaviorId: node.behaviorId, kind: 'runtime', targets: [node.runtimeStatus] }
        ]),
        migrationLedger: {
            contentDigest: digest(ledger),
            scopeCount: ledger.scopes?.length ?? 0,
            entryCount: ledgerEntries.length,
            behaviorIds: ledgerBehaviorIds,
            missingBehaviorIds: missingLedgerBehaviorIds,
            orphanBehaviorIds: orphanLedgerBehaviorIds
        },
        singleMutationCoverage: Object.fromEntries(behaviorNodes.map((node) => [node.behaviorId, node.mutationStatus])),
        zeroLegacyScan: legacy,
        dagAudit: {
            tierCount: parsedMatrix.tiers.length,
            edgeCount: parsedMatrix.tiers.reduce((count, tier) => count + (tier.executionDependsOn?.length ?? 0), 0),
            stronglyConnectedComponents: sccs,
            authorityDuplicates,
            staticComponentBinding,
            postRuntimeBinding
        },
        spawnBeforeReceipt: {
            staticCandidate: admission.candidateSpawnCountBeforeReceipt,
            runtimeCandidate: pre.runtimeCandidateSpawnCountBeforeReceipt,
            releaseFinal: post.releaseFinalSpawnCountBeforeReceipt
        },
        status: uniqueFailures.length === 0 ? 'ok' : 'failed',
        failureReasons: uniqueFailures,
        contentDigest: null
    }
    report.contentDigest = digest(withoutDigest(report))
    return report
}

export function buildVerifiedFinalConsistencyReport(options)
{
    if (typeof options.postRuntimeReceipt !== 'string' || typeof options.preRuntimeReceipt !== 'string')
    {
        fail('terminal qualification requires explicit post-runtime and pre-runtime receipt paths')
    }
    const post = validatePostRuntimeReceipt(loadJson(options.postRuntimeReceipt))
    const verified = verifyBehaviorEvidencePostRuntime({
        repositoryRoot: root,
        receipt: options.postRuntimeReceipt,
        preRuntimeReceipt: options.preRuntimeReceipt,
        catalog: path.join(root, 'config/contracts/behavior-contracts.json'),
        registry: path.join(root, 'config/testing/post-runtime-producer-registry.json'),
        observationReceipts: post.observationRefs.map((reference) => reference.ref),
        acceptedClaimsReceipts: post.acceptedClaimRefs.map((reference) => reference.ref),
        executionContext: post.executionContext.ref,
        schedulerEvidence: post.schedulerEvidence.ref
    })
    return buildFinalConsistencyReport({ ...options, postRuntimeReceipt: verified })
}

function parseArgs(argv)
{
    const options = { facts: [] }
    for (let index = 0; index < argv.length; index += 1)
    {
        const value = argv[index + 1]
        switch (argv[index])
        {
            case '--static-admission': options.staticAdmissionReceipt = value; break
            case '--pre-runtime': options.preRuntimeReceipt = value; break
            case '--post-runtime': options.postRuntimeReceipt = value; break
            case '--owner': options.ownerReceipt = value; break
            case '--fact': options.facts.push(value); break
            case '--doc-claim-parse': options.docClaimParseReceipt = value; break
            case '--doc-claim-verification': options.docClaimVerificationReceipt = value; break
            case '--generated-section': options.generatedSectionReceipt = value; break
            case '--catalog': options.catalog = value; break
            case '--migration-ledger': options.migrationLedger = value; break
            case '--matrix': options.matrix = value; break
            case '--out': options.out = value; break
            default: fail(`unknown argument ${argv[index]}`)
        }
        index += 1
    }
    return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const options = parseArgs(process.argv.slice(2))
        const report = buildVerifiedFinalConsistencyReport({ ...options, factObservationReceipts: options.facts })
        validateFinalReport(report)
        if (options.out)
        {
            fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true })
            fs.writeFileSync(path.resolve(options.out), `${JSON.stringify(report, null, 2)}\n`)
        }
        if (report.status !== 'ok') fail(report.failureReasons.join('; '))
        console.log(`[behavior-document-consistency-final] ok behaviors=${report.behaviorNodes.length}`)
    }
    catch (error)
    {
        console.error(error.message)
        process.exitCode = 1
    }
}
