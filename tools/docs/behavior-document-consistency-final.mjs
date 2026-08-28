#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { digestCatalog } from '../contracts/behavior-contract-catalog.mjs'
import { parseMatrix } from '../test-matrix/parse-matrix.mjs'
import { assertPreRuntimeQualified } from '../test-matrix/behavior-evidence-pre-runtime.mjs'
import { validatePostRuntimeReceipt } from '../test-matrix/behavior-evidence-post-runtime.mjs'

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
    const admission = validateSealed(loadJson(staticAdmissionReceipt), 'static admission')
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
            candidateBuildReceiptDigest: post.candidateIdentity?.buildReceiptDigest ?? null
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
            authorityDuplicates
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
        const report = buildFinalConsistencyReport({ ...options, factObservationReceipts: options.facts })
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
