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
import { parseRepositoryClaims } from './doc-claim.mjs'
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

const deploymentOperationTopic = /\b(?:blue[ /-]?green|runtime[ -]?role|monolithic|slot|traffic|gateway|proxy|upstream|cutover|hand[ -]?off|rollout|rollback|fallback|recovery|drain|candidate|standby|serving|active release)\b|(?:蓝绿|藍綠|运行时角色|運行時角色|切流|回滚|回滾|候选槽|候選槽|活动版本|活動版本|排空)/iu
const deploymentHeadingTopic = /\b(?:blue[ /-]?green|runtime[ -]?role|traffic|hand[ -]?off|recovery|promotion|active slot|operator sequence|service transfer|cutover|rollback)\b|(?:蓝绿|藍綠|运行时角色|運行時角色|切流|回滚|回滾|候选槽|候選槽|流量交接|服务交接)/iu
const deploymentCommand = /\b(?:run|execute|invoke|call|use)\b[^\n]{0,80}\b(?:slot|traffic|gateway|proxy|cutover|handoff|rollout|rollback|fallback|recovery|drain)|\b(?:activate|promote|demote|cut over|reload|restore|reactivate|drain|stop|start|delete|retain|neutralize|install)\b[^\n]{0,60}\b(?:slot|traffic|gateway|proxy|upstream|candidate|standby|serving|active release)|\b(?:switch|commit)\b[^\n]{0,30}\b(?:traffic|gateway|proxy|upstream)|(?:运行|執行|调用|調用|使用)[^\n]{0,80}(?:切流|回滚|回滾|槽|gateway|rollout|rollback)|(?:激活|啟用|停用|切换|切換|排空|停止|启动|啟動|删除|刪除|恢复|恢復)[^\n]{0,60}(?:活动版本|活動版本|候选槽|候選槽|流量|slot)/iu
const deploymentClaim = /\b(?:must|shall|always|never|requires?|progresses?|transitions?|becomes?|verifies?|rejects?|preserves?|owns?)\b|(?:必须|必須|始终|始終|永远|永遠|需要|进入|進入|转换|轉換|成为|成為|验证|驗證|拒绝|拒絕|保留|拥有|擁有)/iu
const evidenceBoundary = /(?:\b(?:evidence|receipts?|observation|diagnostic|validation)\b[^\n]{0,80}\b(?:only|required|requires|bound|not (?:an? )?(?:authority|execution))\b)|(?:\b(?:requires?|is proven only by)\b[^\n]{0,80}\b(?:evidence|receipts?)\b)|(?:证据|證據|回执|回執|观察|觀察|诊断|診斷|验证|驗證)[^\n]{0,80}(?:仅|僅|需要|绑定|綁定|不是权威|不是權威)/iu
const deploymentQualificationClaim = /(?:\b(?:deployment|blue[ /-]?green)\b[^\n]{0,80}\b(?:claim|qualification|eligibility)\b[^\n]{0,40}\b(?:eligible|qualified|approved|accepted|ready)\b)|(?:\bclaimeligible\b[^\n]{0,20}\btrue\b)|(?:\b(?:runtime[ -]?role|monolithic|deployment)\b[^\n]{0,80}\b(?:ownership|authority)\b[^\n]{0,30}\b(?:verified|confirmed|established|resolved|trusted)\b)|(?:\bauthoritystate\b[^\n]{0,20}\b(?:verified|observed|resolved|confirmed|established)\b)|(?:(?:部署|蓝绿|藍綠)[^\n]{0,60}(?:声明|主张|主張|资格|資格)[^\n]{0,30}(?:可用|合格|通过|通過|已批准|已批准))|(?:(?:运行时角色|運行時角色|部署)[^\n]{0,60}(?:所有权|所有權|权威|權威)[^\n]{0,30}(?:已验证|已驗證|已确认|已確認|已建立|已解决|已解決))/iu

const semanticScannerIdentity = Object.freeze([
    'paragraph-context-v1',
    deploymentOperationTopic,
    deploymentHeadingTopic,
    deploymentCommand,
    deploymentClaim,
    evidenceBoundary,
    deploymentQualificationClaim
].map((entry) => String(entry)))

function removeNegatedOperationalClauses(source)
{
    return source
        .replace(/\b(?:does|do|must|can|is|are)\s+not\b[^.;。；]*/giu, '')
        .replace(/\bcannot\b[^.;。；]*/giu, '')
        .replace(/(?:不得|不能|不会|不會|不是|不作为|不作為|不拥有|不擁有|不维护|不維護|不定义|不定義|不证明|不證明|不提升)[^.;。；]*/gu, '')
}

function semanticParagraphs(source)
{
    const paragraphs = []
    let heading = ''
    let lines = []
    const flush = () =>
    {
        const body = lines.join(' ').trim()
        if (body) paragraphs.push({ heading, body })
        lines = []
    }
    for (const rawLine of source.split(/\r?\n/u))
    {
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

function semanticDeploymentAuthorityFindings(source, documentPath)
{
    const findings = []
    for (const { heading, body } of semanticParagraphs(source))
    {
        for (const sentence of body.split(/[.;。；]+/u).map((entry) => entry.trim()).filter(Boolean))
        {
            const actionable = removeNegatedOperationalClauses(sentence).trim()
            if (!actionable) continue
            const contextual = `${heading} ${actionable}`
            const isQualificationClaim = deploymentQualificationClaim.test(contextual)
            const hasOperationTopic = deploymentOperationTopic.test(actionable)
                || deploymentHeadingTopic.test(heading)
            if (!isQualificationClaim && !hasOperationTopic) continue
            const isCommand = deploymentCommand.test(actionable)
            const isClaim = deploymentClaim.test(actionable)
            if (!isQualificationClaim && !isCommand && (!isClaim || evidenceBoundary.test(actionable))) continue
            findings.push({
                classId: 'manual-deployment-authority',
                documentPath,
                evidence: `${heading}: ${sentence}`.slice(0, 160)
            })
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

function sourceOutsideGeneratedSections(source)
{
    const lines = source.split(/\r?\n/u)
    let generated = false
    let fenced = false
    let claimMarker = false
    let awaitingClaimBody = false
    let claimedBody = false
    return lines.map((line) =>
    {
        if (line.includes('<!-- fsus-doc-claim'))
        {
            claimMarker = true
            claimedBody = false
        }
        if (claimMarker)
        {
            if (line.includes('-->'))
            {
                claimMarker = false
                awaitingClaimBody = true
            }
            return ''
        }
        if (/^\s*```/u.test(line)) fenced = !fenced
        if (line.includes('FSUSBLOG-GENERATED:BEGIN'))
        {
            generated = true
            awaitingClaimBody = false
        }
        const retained = generated || fenced ? '' : line
        if (line.includes('FSUSBLOG-GENERATED:END')) generated = false
        if (generated || fenced) return retained
        if (awaitingClaimBody)
        {
            if (line.trim() === '') return ''
            if (/^#{1,6}\s+/u.test(line)) awaitingClaimBody = false
            else
            {
                awaitingClaimBody = false
                claimedBody = true
                return ''
            }
        }
        if (claimedBody)
        {
            if (line.trim() === '')
            {
                claimedBody = false
                return ''
            }
            if (/^#{1,6}\s+/u.test(line)) claimedBody = false
            else return ''
        }
        return retained
    }).join('\n')
}

export function scanReleaseDeploymentDocResidue(repositoryRoot, documentPaths, semanticDocumentPaths = documentPaths)
{
    const findings = []
    const semanticPaths = new Set(semanticDocumentPaths)
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
    const retained = sourceOutsideGeneratedSections(source)
    const findings = []
    for (const [classId, pattern] of forbiddenSurfaces)
    {
        const match = retained.match(pattern)
        if (match) findings.push({ classId, documentPath, evidence: match[0].slice(0, 160) })
    }
    if (semanticDeployment) findings.push(...semanticDeploymentAuthorityFindings(retained, documentPath))
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
        ['synonymous-ownership-claim', '## Topology conclusion\nThe runtime-role authority is established.']
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
