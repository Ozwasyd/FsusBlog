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
import { validateJsonSchema } from '../test-matrix/schema-validator/validate.mjs'
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

const proseClassificationSchema = 'fsusblog.release-deployment-prose-classifications.v1'
const proseClassificationPath = 'config/contracts/release-deployment-prose-classifications.json'
const markdownAstVersion = 'fsusblog.release-deployment-markdown-ast.v1'
const proseClassificationKinds = Object.freeze(['diagnostic', 'example', 'history', 'non-authority'])

const headingPattern = /^(#{1,6})\s+(.+?)\s*#*\s*$/u
const fencePattern = /^\s*(?:`{3,}|~{3,})/u
const listPattern = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/u
const tablePattern = /^\s*\|.*\|\s*$/u
const quotePattern = /^\s*>/u
const htmlCommentPattern = /^\s*<!--/u
const htmlPrePattern = /^\s*<pre(?:\s|>)/iu
const indentedCodePattern = /^(?: {4}|\t)\S/u

const lineBody = (lines) => lines.join('\n').trimEnd()
const nodeDigest = (node) => digestValue({
    astVersion: markdownAstVersion,
    nodeType: node.nodeType,
    headingPath: node.headingPath,
    body: node.body
})
const classificationKey = (entry) =>
    `${entry.documentPath}\0${entry.startLine}\0${entry.endLine}\0${entry.nodeType}`

function pushProseNode(nodes, documentPath, nodeType, startIndex, endIndex, body, headingPath)
{
    if (!body.trim()) return
    const node = {
        documentPath,
        nodeType,
        startLine: startIndex + 1,
        endLine: endIndex + 1,
        headingPath: [...headingPath],
        body
    }
    nodes.push({ ...node, contentDigest: nodeDigest(node) })
}

export function parseReleaseDeploymentMarkdownAst(source, documentPath = 'inline.md')
{
    const lines = String(source).split(/\r?\n/u)
    const nodes = []
    const headingStack = []
    let index = 0

    while (index < lines.length)
    {
        const line = lines[index]
        if (!line.trim())
        {
            index += 1
            continue
        }

        const heading = line.match(headingPattern)
        if (heading)
        {
            const level = heading[1].length
            const title = heading[2].trim()
            while (headingStack.length > 0 && headingStack.at(-1).level >= level) headingStack.pop()
            pushProseNode(nodes, documentPath, 'heading', index, index, title,
                headingStack.map((entry) => entry.title))
            headingStack.push({ level, title })
            index += 1
            continue
        }

        if (fencePattern.test(line))
        {
            const marker = line.trimStart()[0]
            index += 1
            while (index < lines.length && !lines[index].trimStart().startsWith(marker.repeat(3))) index += 1
            if (index < lines.length) index += 1
            continue
        }

        if (htmlCommentPattern.test(line))
        {
            while (index < lines.length && !lines[index].includes('-->')) index += 1
            if (index < lines.length) index += 1
            continue
        }

        if (htmlPrePattern.test(line))
        {
            while (index < lines.length && !/<\/pre>\s*$/iu.test(lines[index])) index += 1
            if (index < lines.length) index += 1
            continue
        }

        if (indentedCodePattern.test(line))
        {
            index += 1
            while (index < lines.length && (indentedCodePattern.test(lines[index]) || !lines[index].trim())) index += 1
            continue
        }

        if (quotePattern.test(line))
        {
            const start = index
            const quoteLines = []
            while (index < lines.length && quotePattern.test(lines[index]))
            {
                quoteLines.push(lines[index].replace(/^\s*(?:>\s*)+/u, ''))
                index += 1
            }
            const firstContent = quoteLines.findIndex((entry) => entry.trim())
            const callout = firstContent >= 0
                ? quoteLines[firstContent].match(/^\[!(?:IMPORTANT|WARNING|CAUTION|NOTE|TIP)\]\s*(.*)$/iu)
                : null
            if (callout)
            {
                quoteLines[firstContent] = callout[1]
                pushProseNode(nodes, documentPath, 'callout', start, index - 1,
                    lineBody(quoteLines), headingStack.map((entry) => entry.title))
            }
            continue
        }

        const start = index
        let nodeType = 'paragraph'
        if (listPattern.test(line)) nodeType = 'list'
        else if (tablePattern.test(line)) nodeType = 'table'
        const bodyLines = []
        while (index < lines.length)
        {
            const current = lines[index]
            if (!current.trim()) break
            if (index > start && (headingPattern.test(current) || fencePattern.test(current)
                || htmlCommentPattern.test(current) || htmlPrePattern.test(current)
                || quotePattern.test(current) || indentedCodePattern.test(current))) break
            if (nodeType === 'list' && index > start && !listPattern.test(current)
                && !/^\s{2,}\S/u.test(current)) break
            if (nodeType === 'table' && !tablePattern.test(current)) break
            if (nodeType === 'paragraph' && index > start
                && (listPattern.test(current) || tablePattern.test(current))) break
            bodyLines.push(current)
            index += 1
        }
        pushProseNode(nodes, documentPath, nodeType, start, index - 1,
            lineBody(bodyLines), headingStack.map((entry) => entry.title))
    }
    return nodes
}

export function extractReleaseDeploymentProseNodes(source, documentPath = 'inline.md')
{
    return parseReleaseDeploymentMarkdownAst(
        sourceOutsideGeneratedSections(source, documentPath),
        documentPath
    )
}

export function classifyReleaseDeploymentSource(
    source,
    documentPath = 'inline.md',
    classification = 'non-authority'
)
{
    if (!proseClassificationKinds.includes(classification))
        throw new Error(`invalid prose classification ${classification}`)
    return extractReleaseDeploymentProseNodes(source, documentPath).map((node) => ({
        documentPath: node.documentPath,
        startLine: node.startLine,
        endLine: node.endLine,
        nodeType: node.nodeType,
        classification,
        contentDigest: node.contentDigest
    }))
}

function validateProseClassificationRegistry(
    registry,
    schema = readJson(root, 'config/schemas/release-deployment-prose-classifications.schema.json')
)
{
    const schemaErrors = validateJsonSchema(registry, schema)
    if (schemaErrors.length > 0) throw new Error(`invalid prose classification schema: ${schemaErrors.join('; ')}`)
    if (registry?.schema !== proseClassificationSchema
        || registry.scopeId !== releaseDeploymentScopeId
        || !Array.isArray(registry.entries))
        throw new Error('invalid release/deployment prose classification registry')
    const keys = new Set()
    for (const entry of registry.entries)
    {
        if (typeof entry.documentPath !== 'string'
            || !Number.isSafeInteger(entry.startLine) || !Number.isSafeInteger(entry.endLine)
            || !['heading', 'paragraph', 'list', 'table', 'callout'].includes(entry.nodeType)
            || !proseClassificationKinds.includes(entry.classification)
            || !/^[0-9a-f]{64}$/u.test(entry.contentDigest))
            throw new Error('invalid release/deployment prose classification entry')
        const key = classificationKey(entry)
        if (keys.has(key)) throw new Error(`duplicate prose classification ${key}`)
        keys.add(key)
    }
    return registry
}

function scanClosedProseOwnership(source, documentPath, classifications)
{
    const nodes = extractReleaseDeploymentProseNodes(source, documentPath)
    const entries = classifications.filter((entry) => entry.documentPath === documentPath)
    const byKey = new Map(entries.map((entry) => [classificationKey(entry), entry]))
    const findings = []
    for (const node of nodes)
    {
        const entry = byKey.get(classificationKey(node))
        if (!entry || entry.contentDigest !== node.contentDigest)
        {
            findings.push({
                classId: 'manual-deployment-authority',
                documentPath,
                evidence: `${node.nodeType}:${node.startLine}-${node.endLine}`
            })
        }
    }
    const nodeKeys = new Set(nodes.map(classificationKey))
    for (const entry of entries)
    {
        if (!nodeKeys.has(classificationKey(entry)))
        {
            findings.push({
                classId: 'stale-prose-classification',
                documentPath,
                evidence: `${entry.nodeType}:${entry.startLine}-${entry.endLine}`
            })
        }
    }
    return findings
}

const semanticScannerIdentity = Object.freeze([
    markdownAstVersion,
    proseClassificationSchema,
    ...proseClassificationKinds
])
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

export function scanReleaseDeploymentDocResidue(repositoryRoot, documentPaths)
{
    const findings = []
    const registry = validateProseClassificationRegistry(readJson(repositoryRoot, proseClassificationPath))
    for (const documentPath of [...new Set(documentPaths)].sort())
    {
        findings.push(...scanReleaseDeploymentSourceResidue(
            readFileSync(path.join(repositoryRoot, documentPath), 'utf8'),
            documentPath,
            { proseClassifications: registry.entries }
        ))
    }
    return findings
}

export function scanReleaseDeploymentSourceResidue(
    source,
    documentPath = 'inline.md',
    { proseClassifications = [] } = {}
)
{
    const retained = sourceOutsideGeneratedSections(source, documentPath)
    const findings = []
    for (const [classId, pattern] of forbiddenSurfaces)
    {
        const match = retained.match(pattern)
        if (match) findings.push({ classId, documentPath, evidence: match[0].slice(0, 160) })
    }
    findings.push(...scanClosedProseOwnership(source, documentPath, proseClassifications))
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
        ['valid-claim', 'The deployment claim is valid.'],
        ['nested-active-callout', '> > [!IMPORTANT]\n> > The deployment claim is valid.'],
        ['multiline-dotted-link', '[deployment claim](https://example.test/a.b\n/c.d) is valid.'],
        ['bare-authority-url', 'https://example.test/deployment-claim-eligible'],
        ['except-after-claim', 'Except after drain, the deployment claim is valid.'],
        ['failed-to-deny-claim', 'The observer failed to deny that the deployment claim is valid.'],
        ['failed-to-remain-blocked', 'The deployment claim failed to remain blocked.'],
        ['mixed-old-current-claim', 'The old claim was invalid, but the current deployment claim is valid.']
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
    const proseClassifications = validateProseClassificationRegistry(
        readJson(repositoryRoot, proseClassificationPath)
    )
    const claimReceipt = parseRepositoryClaims(repositoryRoot, { catalog })
    const receiptRaw = typeof observationReceipt === 'string'
        ? JSON.parse(readFileSync(observationReceipt, 'utf8'))
        : observationReceipt
    const receipt = readFactObservationReceipt(receiptRaw)
    return {
        catalog,
        lifecycle,
        migrationLedger,
        sectionCatalog,
        proseClassifications,
        claimReceipt,
        receiptRaw,
        receipt
    }
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
                ...semanticScannerIdentity,
                digestValue(inputs.proseClassifications)
            ].join('\n'))
            .digest('hex')
    })
    const documentPaths = inputs.catalog.contracts
        .filter((entry) => selectedIds.includes(entry.id))
        .flatMap((entry) => entry.documents)
    const residue = scanReleaseDeploymentDocResidue(repositoryRoot, documentPaths)
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
