#!/usr/bin/env node

/**
 * Release/deployment document exactness: bidirectional claim/section ledger,
 * generated-section drift, controlled prose verification, forbidden manual
 * authority residue and mutation evidence for the release-final aggregate
 * contract and the blue/green + runtime-role deployment behavior.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
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

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
const decodeStrictUtf8 = (bytes, label) =>
{
    if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
        throw new Error(`${label} must not contain a UTF-8 BOM`)
    let source
    try
    {
        source = strictUtf8Decoder.decode(bytes)
    }
    catch
    {
        throw new Error(`${label} is not strict UTF-8`)
    }
    if (source.includes('\r')) throw new Error(`${label} must use canonical LF line endings`)
    if (/[\t ]+$/mu.test(source)) throw new Error(`${label} must not contain trailing horizontal whitespace`)
    return source
}
const readStrictUtf8 = (file, label = file) => decodeStrictUtf8(readFileSync(file), label)
const readJson = (repositoryRoot, relative) =>
    JSON.parse(readStrictUtf8(path.join(repositoryRoot, relative), relative))

const markdownAstVersion = 'fsusblog.release-deployment-markdown-ast.v1'
const protectedProseOwnershipVersion = 'fsusblog.release-deployment-protected-prose-ownership.v1'

const headingPattern = /^(#{1,6})\s+(.+?)\s*#*\s*$/u
const fencePattern = /^\s*(`{3,}|~{3,})/u
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
const protectedNodeKey = (entry) => `${entry.nodeType}\0${entry.contentDigest}`

function assertCanonicalRepositoryPath(relativePath, { docsOnly = false } = {})
{
    if (typeof relativePath !== 'string' || relativePath.length === 0
        || relativePath !== relativePath.normalize('NFC')
        || relativePath.includes('\\') || relativePath.includes('\0')
        || path.posix.isAbsolute(relativePath) || path.posix.normalize(relativePath) !== relativePath
        || relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
        || (docsOnly && (!relativePath.startsWith('docs/') || !relativePath.endsWith('.md'))))
        throw new Error(`non-canonical repository path ${String(relativePath)}`)
    return relativePath
}

function git(repositoryRoot, args)
{
    return execFileSync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
}

export function resolveReleaseDeploymentProtectedBase(
    repositoryRoot,
    approvedBaseRef = process.env.FSUSBLOG_PR_BASE_REF || 'origin/master'
)
{
    if (typeof approvedBaseRef !== 'string' || approvedBaseRef.length === 0
        || approvedBaseRef.includes('\0') || approvedBaseRef.includes('\n'))
        throw new Error('release/deployment protected base ref is invalid')
    const commit = git(repositoryRoot, ['rev-parse', '--verify', `${approvedBaseRef}^{commit}`])
    if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('release/deployment protected base is not a commit')
    try
    {
        git(repositoryRoot, ['merge-base', '--is-ancestor', commit, 'HEAD'])
    }
    catch
    {
        throw new Error('release/deployment protected base is not an ancestor of HEAD')
    }
    return commit
}

function readProtectedGitFile(repositoryRoot, commit, relativePath, { docsOnly = false } = {})
{
    assertCanonicalRepositoryPath(relativePath, { docsOnly })
    if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('invalid protected base commit')
    const treeEntry = git(repositoryRoot, ['ls-tree', commit, '--', relativePath])
        .match(/^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/u)
    if (!treeEntry || treeEntry[3] !== relativePath)
        throw new Error(`${relativePath} has no regular blob at protected base ${commit}`)
    const bytes = execFileSync('git', ['show', `${commit}:${relativePath}`], {
        cwd: repositoryRoot,
        stdio: ['ignore', 'pipe', 'pipe']
    })
    return {
        blob: treeEntry[2],
        source: decodeStrictUtf8(bytes, `${commit}:${relativePath}`)
    }
}

function readCanonicalTrackedFile(repositoryRoot, relativePath, { docsOnly = false } = {})
{
    assertCanonicalRepositoryPath(relativePath, { docsOnly })
    const canonicalRoot = realpathSync(repositoryRoot)
    let current = canonicalRoot
    const segments = relativePath.split('/')
    for (const [index, segment] of segments.entries())
    {
        current = path.join(current, segment)
        const stat = lstatSync(current)
        if (stat.isSymbolicLink()) throw new Error(`${relativePath} traverses a symbolic link`)
        if (index < segments.length - 1 && !stat.isDirectory())
            throw new Error(`${relativePath} traverses a non-directory`)
        if (index === segments.length - 1 && (!stat.isFile() || stat.nlink !== 1))
            throw new Error(`${relativePath} must be a singly-linked regular file`)
    }
    const resolved = realpathSync(current)
    if (resolved !== path.join(canonicalRoot, ...segments)
        || !resolved.startsWith(`${canonicalRoot}${path.sep}`))
        throw new Error(`${relativePath} resolves outside the repository`)
    const source = readStrictUtf8(resolved, relativePath)
    const tracked = git(canonicalRoot, ['ls-files', '--', relativePath]).split('\n').filter(Boolean)
    if (tracked.length !== 1 || tracked[0] !== relativePath)
        throw new Error(`${relativePath} is not one exact canonical Git path`)
    const stage = git(canonicalRoot, ['ls-files', '--stage', '--', relativePath])
        .match(/^(100644|100755) ([0-9a-f]{40,64}) 0\t(.+)$/u)
    if (!stage || stage[3] !== relativePath) throw new Error(`${relativePath} has no canonical stage-0 Git blob`)
    const headBlob = git(canonicalRoot, ['rev-parse', `HEAD:${relativePath}`])
    const worktreeBlob = git(canonicalRoot, ['hash-object', '--no-filters', relativePath])
    if (stage[2] !== headBlob || worktreeBlob !== headBlob)
        throw new Error(`${relativePath} HEAD/index/worktree blobs differ`)
    return source
}

export function readCanonicalReleaseDeploymentDocument(repositoryRoot, documentPath)
{
    return readCanonicalTrackedFile(repositoryRoot, documentPath, { docsOnly: true })
}

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

export function parseReleaseDeploymentMarkdownAst(
    source,
    documentPath = 'inline.md',
    { ownedSpans = [] } = {}
)
{
    const lines = String(source).split(/\r?\n/u)
    const nodes = []
    const headingStack = []
    let index = 0

    while (index < lines.length)
    {
        const line = lines[index]
        const ownedSpan = ownedSpans.find((entry) =>
            index + 1 >= entry.startLine && index + 1 <= entry.endLine)
        if (ownedSpan)
        {
            index = ownedSpan.endLine
            continue
        }
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

        const fence = line.match(fencePattern)
        if (fence)
        {
            const marker = fence[1][0]
            const minimumLength = fence[1].length
            const closingFence = new RegExp(`^\\s*${marker === '`' ? '`' : '~'}{${minimumLength},}\\s*$`, 'u')
            index += 1
            while (index < lines.length && !closingFence.test(lines[index])) index += 1
            if (index < lines.length) index += 1
            continue
        }

        const generatedBegin = line.match(/^\s*<!--\s*FSUSBLOG-GENERATED:BEGIN\s+([a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)\s*-->\s*$/u)
        if (generatedBegin)
        {
            const sectionId = generatedBegin[1]
            index += 1
            while (index < lines.length)
            {
                const generatedEnd = lines[index]
                    .match(/^\s*<!--\s*FSUSBLOG-GENERATED:END\s+([a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)\s*-->\s*$/u)
                if (generatedEnd)
                {
                    if (generatedEnd[1] !== sectionId)
                        throw new Error(`generated section ${sectionId} ended by ${generatedEnd[1]} in ${documentPath}:${index + 1}`)
                    break
                }
                index += 1
            }
            if (index >= lines.length) throw new Error(`generated section ${sectionId} is unclosed in ${documentPath}`)
            index += 1
            continue
        }
        if (/^\s*<!--\s*FSUSBLOG-GENERATED:END\b/u.test(line))
            throw new Error(`orphan generated section end in ${documentPath}:${index + 1}`)

        if (htmlCommentPattern.test(line))
        {
            while (index < lines.length)
            {
                const terminator = lines[index].indexOf('-->')
                if (terminator < 0)
                {
                    index += 1
                    continue
                }
                const tail = lines[index].slice(terminator + 3)
                if (tail.trim()) lines[index] = tail
                else index += 1
                break
            }
            continue
        }

        if (htmlPrePattern.test(line))
        {
            while (index < lines.length)
            {
                const terminator = lines[index].search(/<\/pre>/iu)
                if (terminator < 0)
                {
                    index += 1
                    continue
                }
                const tail = lines[index].slice(terminator).replace(/^<\/pre>/iu, '')
                if (tail.trim()) lines[index] = tail
                else index += 1
                break
            }
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
            else
            {
                pushProseNode(nodes, documentPath, 'quote', start, index - 1,
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
    const claims = parseDocumentClaims(source, { documentPath, documentStatus: 'current' })
    const ownedSpans = claims.flatMap((claim) => [
        {
            startLine: claim.location.claimStartLine,
            endLine: claim.location.claimEndLine
        },
        ...(claim.declaration.claimType === 'generated-section' ? [] : [{
            startLine: claim.location.bodyStartLine,
            endLine: claim.location.bodyEndLine
        }])
    ]).sort((left, right) => left.startLine - right.startLine)
    return parseReleaseDeploymentMarkdownAst(source, documentPath, { ownedSpans })
}

function scanClosedProseOwnership(source, documentPath, protectedHeadingNodes = [])
{
    const nodes = extractReleaseDeploymentProseNodes(source, documentPath)
    const headingCounts = new Map()
    for (const node of protectedHeadingNodes.filter((entry) => entry.nodeType === 'heading'))
    {
        const key = protectedNodeKey(node)
        headingCounts.set(key, (headingCounts.get(key) ?? 0) + 1)
    }
    const findings = []
    for (const node of nodes)
    {
        if (node.nodeType === 'heading')
        {
            const key = protectedNodeKey(node)
            const remaining = headingCounts.get(key) ?? 0
            if (remaining > 0)
            {
                headingCounts.set(key, remaining - 1)
                continue
            }
        }
        findings.push({
            classId: 'manual-deployment-authority',
            documentPath,
            evidence: `${node.nodeType}:${node.startLine}-${node.endLine}`
        })
    }
    return findings
}

const semanticScannerIdentity = Object.freeze([
    markdownAstVersion,
    protectedProseOwnershipVersion
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

export function scanReleaseDeploymentDocResidue(
    repositoryRoot,
    documentPaths,
    { approvedBaseRef } = {}
)
{
    const findings = []
    const protectedBase = resolveReleaseDeploymentProtectedBase(repositoryRoot, approvedBaseRef)
    const protectedCatalog = JSON.parse(readProtectedGitFile(
        repositoryRoot,
        protectedBase,
        'config/contracts/behavior-contracts.json'
    ).source)
    const selected = protectedCatalog.contracts.filter((entry) => entry.status === 'active'
        && entry.documentationPolicy === 'required'
        && releaseDeploymentDomains.includes(entry.domain))
    const expectedDocuments = [...new Set(selected.flatMap((entry) => entry.documents))].sort()
    const actualDocuments = [...new Set(documentPaths)].sort()
    if (JSON.stringify(actualDocuments) !== JSON.stringify(expectedDocuments))
        throw new Error('release/deployment document roster differs from the protected BehaviorCatalog')
    for (const documentPath of actualDocuments)
    {
        assertCanonicalRepositoryPath(documentPath, { docsOnly: true })
        const owners = selected.filter((entry) => entry.documents.includes(documentPath))
        if (owners.length === 0) throw new Error(`${documentPath} is outside the release/deployment BehaviorCatalog roster`)
        const currentSource = readCanonicalTrackedFile(repositoryRoot, documentPath, { docsOnly: true })
        const protectedDocument = readProtectedGitFile(repositoryRoot, protectedBase, documentPath, {
            docsOnly: true
        })
        const currentBlob = git(repositoryRoot, ['rev-parse', `HEAD:${documentPath}`])
        if (currentBlob === protectedDocument.blob && owners.every((entry) => entry.domain !== 'deployment'))
            continue
        findings.push(...scanReleaseDeploymentSourceResidue(
            currentSource,
            documentPath,
            {
                protectedHeadingNodes: extractReleaseDeploymentProseNodes(
                    protectedDocument.source,
                    documentPath
                )
            }
        ))
    }
    return findings
}

export function scanReleaseDeploymentSourceResidue(
    source,
    documentPath = 'inline.md',
    { protectedHeadingNodes = [] } = {}
)
{
    return scanClosedProseOwnership(source, documentPath, protectedHeadingNodes)
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
        ['mixed-old-current-claim', 'The old claim was invalid, but the current deployment claim is valid.'],
        ['post-backtick-fence-prose', '```text\nignored\n```\nThe deployment claim is valid.'],
        ['post-tilde-fence-prose', '~~~text\nignored\n~~~\nThe deployment claim is valid.'],
        ['post-multiple-fence-prose', '```text\none\n```\n~~~text\ntwo\n~~~\nThe deployment claim is valid.'],
        ['html-comment-visible-tail', '<!-- hidden --> The deployment claim is valid.'],
        ['html-pre-visible-tail', '<pre>hidden\n</pre> The deployment claim is valid.'],
        ['ordinary-blockquote-authority', '> The deployment claim is valid.'],
        ['adjacent-generated-ownership-prose', `<!-- fsus-doc-claim
claimId: fixture.generated-adjacent
behaviorId: deployment-blue-green-runtime-role
claimType: generated-section
generatedSectionId: fixture.adjacent
render: generated-section
-->
<!-- FSUSBLOG-GENERATED:BEGIN fixture.adjacent -->
generated body
<!-- FSUSBLOG-GENERATED:END fixture.adjacent -->
The deployment claim is valid.`]
    ]
    const rows = [[...lexicalSamples, ...semanticSamples].map(([classId, source]) => ({
        classId,
        killed: scanReleaseDeploymentSourceResidue(source, 'mutation.md')
            .some((entry) => entry.classId === 'manual-deployment-authority'),
        detector: 'closed-prose-ownership'
    })), ...structuralRows].flat()
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
    return {
        catalog,
        lifecycle,
        migrationLedger,
        sectionCatalog,
        claimReceipt,
        receiptRaw,
        receipt
    }
}

export function buildReleaseDeploymentDocExactnessReceipt({
    repositoryRoot = root,
    observationReceipt,
    sourceCommit,
    worktreeFingerprint,
    approvedBaseRef
})
{
    const inputs = loadReleaseDeploymentExactnessInputs(repositoryRoot, observationReceipt)
    const selectedIds = selectReleaseDeploymentBehaviorIds(inputs.catalog)
    const protectedBase = resolveReleaseDeploymentProtectedBase(repositoryRoot, approvedBaseRef)
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
            .update([...semanticScannerIdentity, protectedBase].join('\n'))
            .digest('hex')
    })
    const documentPaths = inputs.catalog.contracts
        .filter((entry) => selectedIds.includes(entry.id))
        .flatMap((entry) => entry.documents)
    const residue = scanReleaseDeploymentDocResidue(repositoryRoot, documentPaths, {
        approvedBaseRef: protectedBase
    })
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
    const protectedHeadingSource = '# Protected heading\n'
    const protectedHeadingNodes = extractReleaseDeploymentProseNodes(
        protectedHeadingSource,
        'docs/fixture.md'
    )
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
        },
        {
            classId: 'protected-heading-renamed',
            killed: scanReleaseDeploymentSourceResidue(
                '# Renamed heading\n',
                'docs/fixture.md',
                { protectedHeadingNodes }
            ).length === 1,
            detector: 'protected-base-heading-identity'
        },
        {
            classId: 'protected-heading-active-prose-added',
            killed: scanReleaseDeploymentSourceResidue(
                `${protectedHeadingSource}\nTraffic handoff is permitted.\n`,
                'docs/fixture.md',
                { protectedHeadingNodes }
            ).length === 1,
            detector: 'closed-prose-ownership'
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
