#!/usr/bin/env node

/**
 * Release/deployment document exactness: bidirectional claim/section ledger,
 * generated-section drift, controlled prose verification, forbidden manual
 * authority residue and mutation evidence for the release-final aggregate
 * contract and the blue/green + runtime-role deployment behavior.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { digestValue } from '../fact-extractors/identity.mjs'
import { readFactObservationReceipt } from '../fact-extractors/reader.mjs'
import {
    buildBehaviorDocExactnessReceipt,
    validateBehaviorDocExactnessReceipt
} from './behavior-doc-exactness.mjs'
import { parseDocumentClaims, parseRepositoryClaims } from './doc-claim.mjs'
import { renderSectionFromReceipt } from './generated-fact-sections/generator.mjs'
import { parseGeneratedMarkers } from './generated-fact-sections/markers.mjs'
import { verifyProseClaims } from './prose-claim-verifier/verifier.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const releaseDeploymentScopeId = 'protocol-release-deployment-ownership'
export const releaseDeploymentDomains = Object.freeze(['release', 'deployment'])
export const releaseDeploymentExactnessSchema = 'fsusblog.release-deployment-doc-exactness-receipt.v1'

const readJson = (repositoryRoot, relative) =>
    JSON.parse(readFileSync(path.join(repositoryRoot, relative), 'utf8'))

const forbiddenSurfaces = Object.freeze([
    ['manual-runtime-role-table', /(?:^\|\s*模式\s*\|(?:\n\|[^\n]*){1,8})|(?:^\|\s*Mode\s*\|[^\n]*\n(?:\|[^\n]*\n){0,2}[^\n]*`?(?:single|static-role|adaptive)`?)/im],
    ['manual-stage-table', /^\|\s*(?:stage|phase|阶段|階段)\s*\|/imu],
    ['finalizer-as-rerun', /(?:release[- ]final|finalizer|收尾)[^\n]{0,80}(?:re-?runs?\b|rerun|再跑一次|重新运行|重新運行)/iu],
    ['job-success-authority', /(?:job|ci|workflow)[^\n]{0,40}(?:success|succeeded|成功)[^\n]{0,60}(?:authority|proof|权威|權威|证据|證據|代替|取代|replace)/iu],
    ['auto-spawn-evidence', /(?:auto|自动|自動)[^\n]{0,10}(?:spawn|rerun|re-run|produce|生成|重跑)[^\n]{0,30}(?:allowed|permitted|is ok|允许|允許|即可|可以)|(?:may be auto|可以自动|可以自動)[^\n]{0,30}(?:spawn|produce|rerun|生成|重跑)/iu],
    ['unknown-active-standby', /unknown[^\n]{0,40}active[^\n]{0,60}(?:standby|safe|备用|備用|安全)|(?:把|将|將)[^\n]{0,20}unknown[^\n]{0,30}(?:当|當)[^\n]{0,10}(?:standby|备用|備用)/iu],
    ['active-cleanup-allowed', /(?:cleanup|gc|delete|清除|删除|刪除|清掉)[^\n]{0,50}(?:active release|active artifact|当前\s*active|當前\s*active|active slot|active volume|active schema)/iu],
    ['compose-workflow-role-authority', /compose[^\n]{0,80}(?:runtime[- ]role|角色|模式|服务清单|服務清單)[^\n]{0,60}(?:authority|truth|权威|權威|真源)|(?:runtime[- ]role|角色|模式|静态守卫|靜態守衛)[^\n]{0,80}compose[^\n]{0,60}(?:authority|truth|权威|權威|真源)/iu],
    ['waiver', /(?:release|deployment|blue[- ]green|runtime|role|slot|fact|document)[ -]?waiver|(?:部署|蓝绿|藍綠|运行时|運行時|事实|事實|文档|文件)豁免/iu],
    ['hidden-compatibility', /<details\b[^>]*>[\s\S]{0,500}(?:legacy|compat)|compat(?:ibility)?[- ]table|current[- ]equivalent/iu],
    ['overbroad-claim', /(?:one|single|一个|一個)[^\n]{0,60}claim[^\n]{0,80}(?:all|every|全部)[^\n]{0,30}(?:behavior|behaviour|行为|行為)/iu],
    ['self-certification', /(?:lastReviewedAt\s*:|lastVerifiedCommit\s*:|manual(?:ly)?[- ]approved\s*:|self[- ]certified)/iu]
])

const deploymentSemanticVocabulary = Object.freeze({
    operationTopics: ['blue green', 'runtime role', 'active release', 'active slot', 'candidate', 'cutover', 'drain', 'gateway', 'handoff', 'promotion', 'proxy', 'recovery', 'rollback', 'rollout', 'serving', 'slot', 'standby', 'traffic', 'upstream'],
    qualificationSubjects: ['blue green', 'claimeligible', 'deployment', 'runtime role', 'monolithic'],
    qualificationNouns: ['authority', 'authoritystate', 'claim', 'eligibility', 'ownership', 'qualification'],
    positivePredicates: ['accepted', 'active', 'allowed', 'approved', 'becomes', 'cleared', 'confirmed', 'eligible', 'established', 'owned', 'owns', 'permitted', 'qualified', 'ready', 'resolved', 'serving', 'trusted', 'true', 'verified', 'verify'],
    operationalPredicates: ['activate', 'activated', 'commit', 'delete', 'deleted', 'demote', 'drain', 'drained', 'install', 'invoke', 'promote', 'promoted', 'reactivate', 'reload', 'restore', 'retain', 'retire', 'run', 'start', 'stop', 'switch', 'switched'],
    negativePredicates: ['blocked', 'conflict', 'denied', 'failed', 'false', 'forbid', 'forbidden', 'ineligible', 'invalid', 'prohibited', 'rejected', 'unknown', 'unapproved', 'unqualified', 'unresolved', 'unverified'],
    negators: ['cannot', 'never', 'no', 'not'],
    evidenceObjects: ['diagnostic', 'evidence', 'observation', 'receipt', 'receipts', 'validation'],
    historicalCues: ['counterexample', 'historical', 'historically', 'history', 'legacy', 'previously', 'retired']
})

const vocabularySets = Object.fromEntries(Object.entries(deploymentSemanticVocabulary)
    .map(([key, values]) => [key, new Set(values)]))

const semanticScannerIdentity = Object.freeze([
    'structured-markdown-prose-v2',
    JSON.stringify(deploymentSemanticVocabulary)
])

function decodeCharacterReferences(source)
{
    const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"', shy: '' }
    return source.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/giu, (match, entity) =>
    {
        if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match
        const hex = entity[1]?.toLowerCase() === 'x'
        const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
        return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff
            ? String.fromCodePoint(value)
            : match
    })
}

function normalizeMarkdownInline(source)
{
    return decodeCharacterReferences(source.normalize('NFKC'))
        .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/gu, '')
        .replace(/(?:不能|不得|不可|無法|无法)/gu, ' cannot ')
        .replace(/(?:不会|不會|不是|不拥有|不擁有|不证明|不證明|不提升)/gu, ' not ')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
        .replace(/<!--[\s\S]*?-->/gu, '')
        .replace(/<\/?[A-Za-z][^>]*>/gu, '')
        .replace(/\\([\\`*_[\]{}()#+.!~-])/gu, '$1')
        .replace(/[`*_~]/gu, '')
}

function normalizeMarkdownProse(source)
{
    return normalizeMarkdownInline(source)
        .replace(/[-/‐-―]+/gu, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLowerCase()
}

const proseTokens = (source) => normalizeMarkdownProse(source).split(/\s+/u).filter(Boolean)
const hasPhrase = (tokens, phrase) =>
{
    const expected = phrase.split(' ')
    return tokens.some((_, index) => expected.every((token, offset) => tokens[index + offset] === token))
}
const hasAnyPhrase = (tokens, phrases) => phrases.some((phrase) => hasPhrase(tokens, phrase))
const hasAnyToken = (tokens, values) => tokens.some((token) => values.has(token))

function predicateCandidates(token)
{
    return new Set([
        token,
        token.endsWith('ies') ? `${token.slice(0, -3)}y` : token,
        token.endsWith('ed') ? token.slice(0, -2) : token,
        token.endsWith('ed') ? token.slice(0, -1) : token,
        token.endsWith('s') ? token.slice(0, -1) : token
    ])
}

const matchesPredicate = (token, values) => [...predicateCandidates(token)].some((entry) => values.has(entry))

function assertionIsNegated(tokens)
{
    for (let index = 0; index < tokens.length; index += 1)
    {
        if (!vocabularySets.negators.has(tokens[index])) continue
        if (tokens[index] === 'not' && ['merely', 'only'].includes(tokens[index + 1])) continue
        return true
    }
    return false
}

function positivePredicateIndexes(tokens, values)
{
    const indexes = []
    for (let index = 0; index < tokens.length; index += 1)
    {
        const token = tokens[index]
        if (matchesPredicate(token, values)) indexes.push(index)
    }
    return indexes
}

function isHistoricalNarrative(headingTokens, bodyTokens)
{
    const currentCue = bodyTokens.some((token) => ['current', 'currently', 'now', 'today'].includes(token))
    const historical = hasAnyToken(headingTokens, vocabularySets.historicalCues)
        || hasAnyToken(bodyTokens, vocabularySets.historicalCues)
        || hasPhrase(bodyTokens, 'before migration')
        || hasPhrase(bodyTokens, 'prior to migration')
        || bodyTokens.includes('example')
    return historical && !currentCue
}

function isPositiveQualificationClaim(tokens)
{
    const hasSubject = hasAnyPhrase(tokens, deploymentSemanticVocabulary.qualificationSubjects)
    const hasQualification = hasAnyToken(tokens, vocabularySets.qualificationNouns)
        || hasPhrase(tokens, 'claim eligible')
    if (!hasSubject || !hasQualification || assertionIsNegated(tokens)) return false
    const nounIndex = tokens.findIndex((token) => vocabularySets.qualificationNouns.has(token))
    const tail = tokens.slice(nounIndex + 1)
    if (tail.length === 0 || hasAnyToken(tail, vocabularySets.negativePredicates)) return false
    if (hasAnyToken(tail, vocabularySets.evidenceObjects)
        && tail.some((token) => ['need', 'needs', 'require', 'required', 'requires'].includes(token))) return false
    if (positivePredicateIndexes(tail, vocabularySets.positivePredicates).length > 0) return true
    const connectors = new Set(['are', 'becomes', 'is', 'remains', 'was', 'were'])
    const state = connectors.has(tail[0]) ? tail[1] : tail[0]
    return typeof state === 'string' && /^[a-z]+$/u.test(state)
        && !['fact', 'facts', 'map', 'policy', 'receipt', 'receipts', 'state'].includes(state)
}

const isEvidenceBoundaryAssertion = (tokens) => hasAnyToken(tokens, vocabularySets.evidenceObjects)
    && tokens.some((token) => ['need', 'needs', 'require', 'required', 'requires'].includes(token))

function semanticParagraphs(source)
{
    const paragraphs = []
    let heading = ''
    let lines = []
    let activeCallout = false
    const flush = () =>
    {
        const body = lines.join(' ').trim()
        if (body) paragraphs.push({ heading, body })
        lines = []
    }
    for (const rawLine of source.split(/\r?\n/u))
    {
        const quote = rawLine.match(/^\s*>\s?(.*)$/u)
        if (quote)
        {
            const callout = quote[1].match(/^\[!(?:IMPORTANT|WARNING|CAUTION|NOTE|TIP)\]\s*(.*)$/iu)
            if (callout)
            {
                flush()
                activeCallout = true
                if (callout[1]) lines.push(callout[1])
            }
            else if (activeCallout && quote[1].trim()) lines.push(quote[1].trim())
            else flush()
            continue
        }
        activeCallout = false
        const headingMatch = rawLine.match(/^#{1,6}\s+(.+)$/u)
        if (headingMatch)
        {
            flush()
            heading = headingMatch[1].trim()
            continue
        }
        if (/^\s*(?:<!--|-->|$)/u.test(rawLine))
        {
            flush()
            continue
        }
        const listMatch = rawLine.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)(.+)$/u)
        if (listMatch)
        {
            flush()
            lines.push(listMatch[1].trim())
            flush()
            continue
        }
        lines.push(rawLine.trim())
    }
    flush()
    return paragraphs
}

function semanticDeploymentAuthorityFindings(source, documentPath, { operationalAuthority })
{
    const findings = []
    for (const { heading, body } of semanticParagraphs(source))
    {
        const inlineBody = normalizeMarkdownInline(body)
        for (const sentence of inlineBody.split(/[.;。；]+/u).map((entry) => entry.trim()).filter(Boolean))
        {
            const headingTokens = proseTokens(heading)
            const sentenceTokens = proseTokens(sentence)
            if (sentenceTokens.length === 0 || isHistoricalNarrative(headingTokens, sentenceTokens)) continue
            const sentenceNegatesRemainder = sentenceTokens.some((token, index) =>
                ['cannot', 'never'].includes(token)
                || (token === 'not' && !['merely', 'only'].includes(sentenceTokens[index + 1])))
            for (const assertion of sentence.split(/[,:，：]+/u).map((entry) => entry.trim()).filter(Boolean))
            {
                const bodyTokens = proseTokens(assertion)
                const contextualTokens = [...headingTokens, ...bodyTokens]
                const isQualificationClaim = !sentenceNegatesRemainder
                    && isPositiveQualificationClaim(contextualTokens)
                const operationIndexes = positivePredicateIndexes(bodyTokens, new Set([
                    ...vocabularySets.positivePredicates,
                    ...vocabularySets.operationalPredicates
                ]))
                const operationTopicCount = deploymentSemanticVocabulary.operationTopics
                    .filter((topic) => hasPhrase(contextualTokens, topic)).length
                const isOperationAuthority = operationalAuthority && !sentenceNegatesRemainder
                    && !assertionIsNegated(bodyTokens)
                    && (operationTopicCount >= 2 || (operationTopicCount >= 1 && operationIndexes.length > 0))
                    && !hasAnyToken(bodyTokens, vocabularySets.negativePredicates)
                    && !isEvidenceBoundaryAssertion(bodyTokens)
                if (!isQualificationClaim && !isOperationAuthority) continue
                findings.push({
                    classId: 'manual-deployment-authority',
                    documentPath,
                    evidence: `${heading}: ${assertion}`.slice(0, 160)
                })
            }
        }
    }
    return findings
}

export function selectReleaseDeploymentBehaviorIds(catalog)
{
    const domains = new Set(releaseDeploymentDomains)
    return catalog.contracts
        .filter((contract) => contract.status === 'active'
            && contract.documentationPolicy === 'required'
            && domains.has(contract.domain))
        .map((contract) => contract.id)
        .sort((left, right) => left.localeCompare(right))
}

export const releaseDeploymentBehaviorIds = Object.freeze(selectReleaseDeploymentBehaviorIds(
    readJson(root, 'config/contracts/behavior-contracts.json')
))

function seal(value)
{
    const result = { ...value, contentDigest: null }
    result.contentDigest = digestValue(result)
    return result
}

function sourceOutsideGeneratedSections(source, documentPath)
{
    const lines = source.split(/\r?\n/u)
    const claims = parseDocumentClaims(source, { documentPath, documentStatus: 'current' })
    const ownedLines = new Set()
    for (const claim of claims)
    {
        for (let line = claim.location.claimStartLine; line <= claim.location.claimEndLine; line += 1)
        {
            ownedLines.add(line)
        }
        if (claim.declaration.claimType !== 'generated-section')
        {
            for (let line = claim.location.bodyStartLine; line <= claim.location.bodyEndLine; line += 1)
            {
                ownedLines.add(line)
            }
        }
    }
    let generated = false
    let fenced = false
    let htmlComment = false
    return lines.map((line, index) =>
    {
        if (ownedLines.has(index + 1)) return ''
        if (/^\s*(?:```+|~~~+)/u.test(line)) fenced = !fenced
        if (line.includes('FSUSBLOG-GENERATED:BEGIN')) generated = true
        if (line.trim().startsWith('<!--') && !line.includes('-->')) htmlComment = true
        const retained = generated || fenced || htmlComment ? '' : line
        if (line.includes('FSUSBLOG-GENERATED:END')) generated = false
        if (htmlComment && line.includes('-->')) htmlComment = false
        return retained
    }).join('\n')
}

export function scanReleaseDeploymentDocResidue(repositoryRoot, documentPaths, semanticDocumentPaths = null)
{
    const findings = []
    const semanticPaths = new Set(semanticDocumentPaths ?? readJson(
        repositoryRoot,
        'config/contracts/behavior-contracts.json'
    ).contracts.filter((entry) => entry.status === 'active'
        && entry.documentationPolicy === 'required'
        && entry.domain === 'deployment').flatMap((entry) => entry.documents))
    for (const documentPath of [...new Set(documentPaths)].sort())
    {
        findings.push(...scanReleaseDeploymentSourceResidue(
            readFileSync(path.join(repositoryRoot, documentPath), 'utf8'),
            documentPath,
            { semanticDeployment: semanticPaths.has(documentPath) }
        ))
    }
    return findings
}

export function scanReleaseDeploymentSourceResidue(source, documentPath = 'inline.md', { semanticDeployment = true } = {})
{
    const retained = sourceOutsideGeneratedSections(source, documentPath)
    const findings = []
    for (const [classId, pattern] of forbiddenSurfaces)
    {
        const match = retained.match(pattern)
        if (match) findings.push({ classId, documentPath, evidence: match[0].slice(0, 160) })
    }
    findings.push(...semanticDeploymentAuthorityFindings(retained, documentPath, {
        operationalAuthority: semanticDeployment
    }))
    return findings
}

export function runReleaseDeploymentDocMutationCases(structuralRows = [])
{
    const lexicalSamples = [
        ['manual-runtime-role-table', '| Mode | Responsibility |\n| --- | --- |\n| `single` | owns everything |'],
        ['manual-stage-table', '| Stage | Owner |\n| --- | --- |\n| release-final | aggregate |'],
        ['finalizer-as-rerun', 'release-final re-runs every producer to confirm success'],
        ['job-success-authority', 'the CI job success is the authority for release evidence'],
        ['auto-spawn-evidence', 'missing evidence auto-spawn is allowed before closeout'],
        ['unknown-active-standby', 'unknown active identity is treated as a safe standby'],
        ['active-cleanup-allowed', 'the GC may delete the active release assets'],
        ['compose-workflow-role-authority', 'the compose file is the runtime-role authority'],
        ['waiver', 'deployment-waiver'],
        ['hidden-compatibility', '<details>legacy compatibility table</details>'],
        ['overbroad-claim', 'one claim covers all behaviors'],
        ['self-certification', 'lastVerifiedCommit: deadbeef']
    ]
    const semanticSamples = [
        ['renamed-manual-section', '## Traffic handoff\nThe controller verifies the candidate and reloads the gateway upstream.'],
        ['reordered-manual-sections', '## Recovery procedure\nRestore the former serving slot.\n## Promotion steps\nPromote the standby and switch traffic.'],
        ['extra-active-section', '## Active slot maintenance\nThe operator must retain the serving slot until the drain finishes.'],
        ['synonymous-manual-command', '## Operator sequence\nInvoke the cutover utility, promote standby, then retire the former serving slot.'],
        ['synonymous-manual-claim', '## Service transfer\nA standby becomes serving after the proxy is reloaded; fallback reactivates the former slot.'],
        ['unowned-qualification-claim', '## Deployment conclusion\nThe blue/green deployment claim is eligible and runtime-role ownership is verified.'],
        ['synonymous-qualification-claim', '## Readiness conclusion\nThe blue-green deployment qualification is approved.'],
        ['synonymous-ownership-claim', '## Topology conclusion\nThe runtime-role authority is established.'],
        ['passive-cutover-clearance', 'The candidate is cleared for cutover.'],
        ['passive-handoff-permission', 'Traffic handoff permitted after observation.'],
        ['headingless-authority-table', '| Target | State |\n| --- | --- |\n| Candidate | Cleared for cutover |'],
        ['headingless-authority-list', '- Traffic handoff permitted.'],
        ['markdown-split-ownership', 'The run**time-role** owner**ship** is veri**fied**.'],
        ['entity-split-qualification', 'The blue&#x2d;green deployment claim is elig&#105;ble.'],
        ['generated-claim-body-laundering', `<!-- fsus-doc-claim
claimId: fixture.generated
behaviorId: deployment-blue-green-runtime-role
claimType: generated-section
generatedSectionId: fixture.deployment
render: generated-section
-->
The blue-green deployment claim is eligible.`],
        ['link-before-sentence-normalization', '[deployment](https://example.test/a.b) claim is eligible.'],
        ['split-runtime-role-link', '[runtime](https://example.test/runtime)-[role](https://example.test/role) ownership is settled.'],
        ['inline-comment-split', 'deploy<!-- split -->ment claim is valid.'],
        ['zero-width-split', 'deploy​ment claim passed.'],
        ['soft-hyphen-entity-split', 'blue&shy;-green deployment claim valid.'],
        ['active-callout-authority', '> [!IMPORTANT]\n> Standby may take traffic.'],
        ['without-receipts-qualification', 'Without receipts, the deployment claim is valid.'],
        ['no-evidence-required-qualification', 'No evidence required, the deployment claim passed.'],
        ['not-only-qualification', 'The deployment claim is not only eligible.'],
        ['not-merely-qualification', 'The deployment claim is not merely valid.'],
        ['standby-takes-traffic', 'Standby may take traffic.'],
        ['gateway-points-standby', 'The gateway points at standby.'],
        ['settled-ownership', 'Runtime-role ownership is settled.'],
        ['passed-claim', 'The deployment claim passed.'],
        ['valid-claim', 'The deployment claim is valid.']
    ]
    const rows = [...lexicalSamples.map(([classId, source]) => ({
        classId,
        killed: forbiddenSurfaces.find(([id]) => id === classId)[1].test(source),
        detector: classId
    })), ...semanticSamples.map(([classId, source]) => ({
        classId,
        killed: scanReleaseDeploymentSourceResidue(source, 'mutation.md')
            .some((entry) => entry.classId === 'manual-deployment-authority'),
        detector: 'manual-deployment-authority'
    })), ...structuralRows]
    return seal({
        schema: 'fsusblog.release-deployment-doc-mutation-evidence.v1',
        rows,
        killed: rows.filter((row) => row.killed).length,
        total: rows.length
    })
}

export function verifyReleaseDeploymentGeneratedSections(
    repositoryRoot,
    sectionCatalog,
    observationReceipt,
    selectedIds = releaseDeploymentBehaviorIds
)
{
    const selectedBehaviorIds = new Set(selectedIds)
    const drifts = []
    const sections = sectionCatalog.sections
        .filter((entry) => selectedBehaviorIds.has(entry.behaviorId))
    for (const section of sections)
    {
        const source = readFileSync(path.join(repositoryRoot, section.documentPath), 'utf8')
        const markers = parseGeneratedMarkers(source, section.documentPath)
        const marker = markers.find((entry) => entry.sectionId === section.sectionId)
        if (!marker)
        {
            drifts.push(`${section.sectionId} marker missing`)
            continue
        }
        const expected = renderSectionFromReceipt(section, observationReceipt, null).replace(/\n+$/u, '')
        const actual = marker.existingBody.replace(/\n+$/u, '')
        if (actual !== expected) drifts.push(`${section.sectionId} generated section drift`)
    }
    return drifts
}

export function loadReleaseDeploymentExactnessInputs(repositoryRoot, observationReceipt)
{
    const catalog = readJson(repositoryRoot, 'config/contracts/behavior-contracts.json')
    const lifecycle = readJson(repositoryRoot, 'config/development/document-lifecycle.json')
    const migrationLedger = readJson(repositoryRoot, 'config/contracts/document-claim-migration-ledger.json')
    const sectionCatalog = readJson(repositoryRoot, 'config/contracts/generated-fact-sections.json')
    const claimReceipt = parseRepositoryClaims(repositoryRoot, { catalog })
    const receiptRaw = typeof observationReceipt === 'string'
        ? JSON.parse(readFileSync(observationReceipt, 'utf8'))
        : observationReceipt
    const receipt = readFactObservationReceipt(receiptRaw)
    return { catalog, lifecycle, migrationLedger, sectionCatalog, claimReceipt, receiptRaw, receipt }
}

export function buildReleaseDeploymentDocExactnessReceipt({
    repositoryRoot = root,
    observationReceipt,
    sourceCommit,
    worktreeFingerprint
})
{
    const inputs = loadReleaseDeploymentExactnessInputs(repositoryRoot, observationReceipt)
    const selectedIds = selectReleaseDeploymentBehaviorIds(inputs.catalog)
    const exactness = buildBehaviorDocExactnessReceipt({
        repositoryRoot,
        catalog: inputs.catalog,
        lifecycle: inputs.lifecycle,
        migrationLedger: inputs.migrationLedger,
        claimReceipt: inputs.claimReceipt,
        sectionCatalog: inputs.sectionCatalog,
        observationReceipts: [inputs.receiptRaw],
        domains: [...releaseDeploymentDomains],
        sourceCommit,
        worktreeFingerprint,
        scopeId: releaseDeploymentScopeId,
        scannerDigest: createHash('sha256')
            .update([
                ...forbiddenSurfaces.map(([id, pattern]) => `${id}:${pattern}`),
                ...semanticScannerIdentity
            ].join('\n'))
            .digest('hex')
    })
    const documentPaths = inputs.catalog.contracts
        .filter((entry) => selectedIds.includes(entry.id))
        .flatMap((entry) => entry.documents)
    const semanticDocumentPaths = inputs.catalog.contracts
        .filter((entry) => selectedIds.includes(entry.id) && entry.domain === 'deployment')
        .flatMap((entry) => entry.documents)
    const residue = scanReleaseDeploymentDocResidue(repositoryRoot, documentPaths, semanticDocumentPaths)
    const generatedDrifts = verifyReleaseDeploymentGeneratedSections(
        repositoryRoot,
        inputs.sectionCatalog,
        inputs.receipt,
        selectedIds
    )
    const exactnessInputs = {
        repositoryRoot,
        catalog: inputs.catalog,
        lifecycle: inputs.lifecycle,
        migrationLedger: inputs.migrationLedger,
        claimReceipt: inputs.claimReceipt,
        sectionCatalog: inputs.sectionCatalog,
        observationReceipts: [inputs.receiptRaw],
        domains: [...releaseDeploymentDomains],
        sourceCommit,
        worktreeFingerprint,
        scopeId: releaseDeploymentScopeId
    }
    const catalogDrift = structuredClone(inputs.catalog)
    catalogDrift.contracts.push({
        ...catalogDrift.contracts.find((entry) => selectedIds.includes(entry.id)),
        id: `${selectedIds[0]}-catalog-drift`
    })
    const ledgerTamper = structuredClone(inputs.migrationLedger)
    ledgerTamper.scopes.find((entry) => entry.scopeId === releaseDeploymentScopeId).entries[0].claimIds.pop()
    const extraClaimReceipt = structuredClone(inputs.claimReceipt)
    const extraClaim = structuredClone(extraClaimReceipt.claims.find((entry) =>
        selectedIds.includes(entry.declaration.behaviorId)
        && entry.declaration.claimType !== 'generated-section'))
    extraClaim.declaration.claimId = `${extraClaim.declaration.claimId}-unregistered`
    extraClaimReceipt.claims.push(extraClaim)
    const stageOmission = structuredClone(inputs.receipt)
    stageOmission.observations.facts['release-final.aggregate-contract'].inputTierIds.pop()
    const reversedSwitch = structuredClone(inputs.receipt)
    reversedSwitch.observations.facts['deployment.blue-green-contract'].switchState = 'rolled-back'
    const reversedRole = structuredClone(inputs.receipt)
    reversedRole.observations.facts['deployment.runtime-role-contract'].ownership.coResidency = 'forced-separation'
    const missingUnsupportedCombination = structuredClone(inputs.receipt)
    delete missingUnsupportedCombination.observations.facts['deployment.runtime-role-contract']
        .unsupportedCombinations['unknown-mode']
    const structuralRows = [
        {
            classId: 'required-stage-evidence-omission',
            killed: verifyReleaseDeploymentGeneratedSections(
                repositoryRoot, inputs.sectionCatalog, stageOmission, selectedIds
            ).length > 0,
            detector: 'generated-section-exactness'
        },
        {
            classId: 'rollback-switch-precondition-reversed',
            killed: verifyReleaseDeploymentGeneratedSections(
                repositoryRoot, inputs.sectionCatalog, reversedSwitch, selectedIds
            ).length > 0,
            detector: 'generated-section-exactness'
        },
        {
            classId: 'runtime-role-relationship-reversed',
            killed: verifyReleaseDeploymentGeneratedSections(
                repositoryRoot, inputs.sectionCatalog, reversedRole, selectedIds
            ).length > 0,
            detector: 'generated-section-exactness'
        },
        {
            classId: 'unsupported-combination-omitted',
            killed: verifyReleaseDeploymentGeneratedSections(
                repositoryRoot, inputs.sectionCatalog, missingUnsupportedCombination, selectedIds
            ).length > 0,
            detector: 'generated-section-exactness'
        },
        {
            classId: 'catalog-change-with-stale-docs',
            killed: buildBehaviorDocExactnessReceipt({ ...exactnessInputs, catalog: catalogDrift }).status === 'failed',
            detector: 'behavior-catalog-ledger-exactness'
        },
        {
            classId: 'source-identity-change-with-stale-docs',
            killed: buildBehaviorDocExactnessReceipt({
                ...exactnessInputs,
                sourceCommit: sourceCommit === '0'.repeat(40) ? '1'.repeat(40) : '0'.repeat(40)
            }).status === 'failed',
            detector: 'observation-source-identity'
        },
        {
            classId: 'claim-ledger-tamper',
            killed: buildBehaviorDocExactnessReceipt({
                ...exactnessInputs,
                migrationLedger: ledgerTamper
            }).status === 'failed',
            detector: 'claim-ledger-exactness'
        },
        {
            classId: 'unregistered-doc-claim',
            killed: buildBehaviorDocExactnessReceipt({
                ...exactnessInputs,
                claimReceipt: extraClaimReceipt
            }).status === 'failed',
            detector: 'behavior-catalog-doc-claim-roster-exactness'
        }
    ]
    const mutationEvidence = runReleaseDeploymentDocMutationCases(structuralRows)
    const proseClaims = inputs.claimReceipt.claims.filter((claim) =>
        selectedIds.includes(claim.declaration.behaviorId)
        && claim.declaration.claimType !== 'generated-section')
    const proseVerification = verifyProseClaims({
        claims: proseClaims,
        receipts: [inputs.receiptRaw]
    })
    const failureReasons = [
        ...exactness.failureReasons,
        ...generatedDrifts,
        ...proseVerification.diagnostics.map((entry) =>
            `${entry.claimId} prose verification ${entry.code}`),
        ...residue.map((entry) => `${entry.classId} in ${entry.documentPath}`),
        ...(mutationEvidence.killed === mutationEvidence.total ? [] : ['release/deployment mutation evidence incomplete'])
    ].sort()
    return seal({
        schema: releaseDeploymentExactnessSchema,
        scopeId: releaseDeploymentScopeId,
        source: exactness.source,
        authorityDigests: exactness.authorityDigests,
        exactnessDigest: exactness.contentDigest,
        rows: exactness.rows,
        counts: {
            ...exactness.counts,
            residue: residue.length,
            generatedDrift: generatedDrifts.length,
            proseVerified: proseClaims.length - proseVerification.diagnostics.length,
            proseTotal: proseClaims.length,
            mutationKilled: mutationEvidence.killed,
            mutationTotal: mutationEvidence.total
        },
        mutationEvidence,
        residue,
        generatedDrifts,
        proseVerification,
        status: failureReasons.length === 0 ? 'ok' : 'failed',
        failureReasons
    })
}

export function validateReleaseDeploymentDocExactnessReceipt(receipt)
{
    if (receipt?.schema !== releaseDeploymentExactnessSchema) throw new Error('unexpected release/deployment exactness schema')
    if (receipt.contentDigest !== digestValue({ ...receipt, contentDigest: null }))
        throw new Error('release/deployment exactness contentDigest mismatch')
    if (receipt.status !== 'ok' || receipt.failureReasons.length !== 0
        || receipt.counts.warnings !== 0 || receipt.counts.residue !== 0
        || receipt.counts.generatedDrift !== 0
        || receipt.counts.proseVerified !== receipt.counts.proseTotal
        || receipt.mutationEvidence.killed !== receipt.mutationEvidence.total)
        throw new Error(`release/deployment exactness failed: ${receipt.failureReasons.join('; ')}`)
    return receipt
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const receiptIndex = process.argv.indexOf('--receipt')
    const receiptPath = receiptIndex >= 0 ? process.argv[receiptIndex + 1] : null
    if (!receiptPath) throw new Error('usage: release-deployment-doc-exactness.mjs --receipt <fact-observation-receipt>')
    const absoluteReceiptPath = path.resolve(receiptPath)
    const observation = readFactObservationReceipt(absoluteReceiptPath)
    const result = buildReleaseDeploymentDocExactnessReceipt({
        repositoryRoot: root,
        observationReceipt: absoluteReceiptPath,
        sourceCommit: observation.sourceCommit,
        worktreeFingerprint: observation.worktreeFingerprint
    })
    validateReleaseDeploymentDocExactnessReceipt(result)
    console.log(`[release-deployment-doc-exactness] ok claims=${result.rows.length} mutations=${result.counts.mutationKilled}/${result.counts.mutationTotal}`)
}
