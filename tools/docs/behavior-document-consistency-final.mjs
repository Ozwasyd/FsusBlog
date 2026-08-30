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

export const zeroLegacyScanSchema = 'fsusblog.zero-legacy-governance-scan.v1'

const scanRoots = Object.freeze([
    Object.freeze({ path: 'config', pathClass: 'config' }),
    Object.freeze({ path: 'docs', pathClass: 'docs' }),
    Object.freeze({ path: 'src', pathClass: 'production' }),
    Object.freeze({ path: 'tests', pathClass: 'tests' }),
    Object.freeze({ path: 'tools', pathClass: 'tools' })
])

export const zeroLegacyRequiredPathClasses = Object.freeze([
    'config',
    'docs',
    'production',
    'tests',
    'tools',
    'package-scripts',
    'generated-projection',
    'output-schema'
])

const forbiddenMachineFieldParts = Object.freeze([
    ['last', 'verified', 'commit'],
    ['maximum', 'verification', 'distance'],
    ['last', 'reviewed', 'commit'],
    ['last', 'reviewed', 'at'],
    ['verified', 'at'],
    ['content', 'baseline', 'sha'],
    ['approved', 'content', 'digest'],
    ['expected', 'value'],
    ['baseline', 'value'],
    ['ignore', 'difference'],
    ['allow', 'stale', 'until'],
    ['waiver']
])
const booleanSelfCertificationParts = Object.freeze([['verified'], ['reviewed']])
const evidenceSelectionParts = Object.freeze([
    ['latest', 'evidence'], ['latest', 'receipt'], ['latest', 'result'], ['latest', 'report'],
    ['newest', 'evidence'], ['newest', 'receipt'], ['evidence', 'history'], ['receipt', 'history'],
    ['historical', 'evidence'], ['history', 'fallback'], ['evidence', 'fallback'], ['receipt', 'fallback'],
    ['fallback', 'evidence'], ['fallback', 'receipt'], ['last', 'green'], ['last', 'passing'],
    ['evidence', 'mtime'], ['receipt', 'mtime'], ['evidence', 'ctime'], ['receipt', 'ctime'],
    ['evidence', 'age'], ['receipt', 'age'], ['evidence', 'glob'], ['receipt', 'glob'],
    ['evidence', 'search'], ['receipt', 'search'], ['evidence', 'scan'], ['receipt', 'scan'],
    ['retry', 'until', 'pass'], ['retry', 'as', 'correctness']
])
const authorityResidueParts = Object.freeze([
    ['self', 'certified'], ['self', 'certification'], ['self', 'certified', 'fact'],
    ['manual', 'approved'], ['manually', 'approved'], ['checked', 'in', 'authority'],
    ['checked', 'in', 'fact'], ['checked', 'in', 'expected'], ['checked', 'in', 'openapi'],
    ['openapi', 'regex', 'fallback'], ['git', 'diff'], ['git', 'diff', 'synchronization'],
    ['source', 'test', 'doc', 'diff'], ['source', 'tests', 'docs', 'changed'],
    ['test', 'file', 'exists', 'coverage'], ['file', 'presence', 'coverage'],
    ['source', 'patterns'], ['test', 'owners'], ['behavior', 'doc', 'parallel'],
    ['runtime', 'pre', 'runtime', 'parallel'],
    ['validation', 'sha'], ['expected', 'sha'], ['review', 'sha'], ['approved', 'sha'], ['baseline', 'sha'],
    ['llm', 'qualification'], ['embedding', 'qualification'], ['human', 'review', 'qualification'],
    ['release', 'final', 'discovery'], ['release', 'final', 'rerun'], ['release', 'final', 'repair']
])
const legacyRoleParts = Object.freeze([
    ['claim'], ['extractor'], ['renderer'], ['joiner'], ['cli'], ['schema'], ['feature', 'flag']
])
const legacyStateParts = Object.freeze([['legacy'], ['compat'], ['compatibility'], ['deprecated']])
const ignoredDirectoryNames = new Set(['.git', '.tmp', 'bin', 'node_modules', 'obj'])
const machineSourceExtensions = /\.(?:c|cc|cpp|cs|cxx|h|hpp|js|jsx|mjs|ps1|sh|ts|tsx|vue|ya?ml)$/u
const qualificationPathPattern = /(?:artifact|behavior|doc[-_.]?claim|evidence|fact[-_.]?extract|generated[-_.]?fact|governance|mutation|qualification|receipt|release[-_.]?final)/iu
const machineFencePattern = /^```(bash|csharp|cs|javascript|js|json|jsonc|powershell|ps1|sh|shell|toml|typescript|ts|yaml|yml)\s*\n([\s\S]*?)^```\s*$/gimu
const normalizeIdentifier = (value) => String(value).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/gu, '')
const canonicalField = (parts) => parts.map((part, index) => index === 0 ? part : `${part[0].toUpperCase()}${part.slice(1)}`).join('')
const fieldMap = (parts) => new Map(parts.map((entry) => [normalizeIdentifier(entry.join('')), canonicalField(entry)]))
const forbiddenMachineFields = fieldMap(forbiddenMachineFieldParts)
const booleanSelfCertificationFields = fieldMap(booleanSelfCertificationParts)
const evidenceSelectionFields = fieldMap(evidenceSelectionParts)
const authorityResidueFields = fieldMap(authorityResidueParts)
const legacyRoles = legacyRoleParts.map((parts) => normalizeIdentifier(parts.join('')))
const legacyStates = legacyStateParts.map((parts) => normalizeIdentifier(parts.join('')))

function zeroLegacyFail(message)
{
    throw new Error(`[zero-legacy-governance] ${message}`)
}

function pathClassesFor(file)
{
    const classes = []
    const rootEntry = scanRoots.find((entry) => file === entry.path || file.startsWith(`${entry.path}/`))
    if (rootEntry) classes.push(rootEntry.pathClass)
    if (path.posix.basename(file) === 'package.json') classes.push('package-scripts')
    if (/(?:^|\/)(?:generated|projections?)(?:[-_.\/]|$)|(?:^|[-_.])generated(?:[-_.]|$)/iu.test(file)) classes.push('generated-projection')
    if (/(?:^|\/)schemas?(?:\/|$)|\.schema\.json$/iu.test(file)) classes.push('output-schema')
    return [...new Set(classes)].sort()
}

function addFinding(findings, file, pathClasses, rule, location)
{
    findings.push({ file, pathClasses, rule, location })
}

function isQualificationPath(file)
{
    return qualificationPathPattern.test(file)
}

function isForbiddenMachineField(normalized, qualification)
{
    const canonical = forbiddenMachineFields.get(normalized)
    if (!canonical) return null
    if (!qualification && ['expectedValue', 'baselineValue', 'verifiedAt', 'waiver'].includes(canonical)) return null
    return canonical
}

function legacySurfaceName(value)
{
    const normalized = normalizeIdentifier(value)
    if (normalized.includes('zerolegacy') || normalized.startsWith('assertnolegacy')
        || normalized.startsWith('checknolegacy') || normalized.startsWith('rejectlegacy')) return false
    return legacyStates.some((state) => normalized.includes(state))
        && legacyRoles.some((role) => normalized.includes(role))
}

function evidenceSelectionField(identifier)
{
    const normalized = normalizeIdentifier(identifier)
    const exact = evidenceSelectionFields.get(normalized)
    if (exact) return exact
    const evidenceKind = '(?:artifact|evidence|fact|mutation|receipt|report|result|runtime|trx)'
    const selector = '(?:ctime|fallback|history|historical|latest|mtime|newest)'
    if (new RegExp(`^(?:${selector}.*${evidenceKind}|${evidenceKind}.*${selector})$`, 'u').test(normalized)
        || /(?:lastgreen|lastpassing|retry.*(?:correctness|pass))/u.test(normalized))
    {
        return identifier
    }
    return null
}

function authorityResidueField(identifier)
{
    const normalized = normalizeIdentifier(identifier)
    const exact = authorityResidueFields.get(normalized)
    if (exact) return exact
    if (/(?:releasefinal).*(?:discover|parse|repair|rerun)|(?:discover|parse|repair|rerun).*(?:releasefinal)/u.test(normalized)
        || /openapi.*regex.*fallback|regex.*openapi.*fallback/u.test(normalized)
        || /gitdiff.*(?:sync|synchron)|(?:sync|synchron).*gitdiff/u.test(normalized))
    {
        return identifier
    }
    return null
}

function scanValueResidue(owner, rawValue, context)
{
    if (!context.qualification || typeof rawValue !== 'string') return
    const value = rawValue.trim().replace(/^["']|["']$/gu, '')
    if (!value || value.length > 512) return
    const ownerName = normalizeIdentifier(owner)
    if (/^(?:deny|forbidden|reject)/u.test(ownerName)) return
    const valueName = normalizeIdentifier(value)
    const selectionOwner = /(?:artifact|discovery|evidence|locator|mode|receipt|result|selection|source|strategy)/u.test(ownerName)
    const authorityOwner = /(?:authority|cli|command|featureflag|input|kind|mode|path|provider|schema|source|strategy|type)/u.test(ownerName)
    const simpleSelector = new Set(['age', 'ctime', 'fallback', 'glob', 'historical', 'history', 'latest', 'mtime', 'newest', 'scan', 'search'])
    const selectionField = evidenceSelectionField(value)
    if (selectionOwner && (selectionField || simpleSelector.has(valueName)))
    {
        addFinding(context.findings, context.file, context.pathClasses, `forbidden-evidence-selection:${selectionField ?? `${owner}=${value}`}`, context.location)
    }
    const authorityField = authorityResidueField(value)
    if (authorityOwner && authorityField)
    {
        addFinding(context.findings, context.file, context.pathClasses, `forbidden-self-authority:${authorityField}`, context.location)
    }
    if (authorityOwner && legacySurfaceName(value))
    {
        addFinding(context.findings, context.file, context.pathClasses, `forbidden-legacy-surface:${value}`, context.location)
    }
}

function scanIdentifier(identifier, valueText, context)
{
    const normalized = normalizeIdentifier(identifier)
    const pathLike = /[./\\]/u.test(identifier)
    const forbiddenField = isForbiddenMachineField(normalized, context.qualification)
    if (forbiddenField)
    {
        addFinding(context.findings, context.file, context.pathClasses, `forbidden-machine-field:${forbiddenField}`, context.location)
    }
    const booleanAttestation = booleanSelfCertificationFields.get(normalized)
    if (context.qualification && booleanAttestation && /^true\b/iu.test(String(valueText).trim()))
    {
        addFinding(context.findings, context.file, context.pathClasses, `forbidden-self-certification:${booleanAttestation}`, context.location)
    }
    const selectionField = pathLike ? null : evidenceSelectionField(identifier)
    if (context.qualification && selectionField)
    {
        addFinding(context.findings, context.file, context.pathClasses, `forbidden-evidence-selection:${selectionField}`, context.location)
    }
    const authorityField = pathLike ? null : authorityResidueField(identifier)
    if (context.qualification && authorityField)
    {
        addFinding(context.findings, context.file, context.pathClasses, `forbidden-self-authority:${authorityField}`, context.location)
    }
    if (!pathLike && legacySurfaceName(identifier))
    {
        addFinding(context.findings, context.file, context.pathClasses, `forbidden-legacy-surface:${identifier}`, context.location)
    }
    scanValueResidue(identifier, typeof valueText === 'string' ? valueText : '', context)
}

function scanObjectKeys(value, context, negated = false, location = '$')
{
    if (Array.isArray(value))
    {
        value.forEach((entry, index) => scanObjectKeys(entry, context, negated, `${location}[${index}]`))
        return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, nested] of Object.entries(value))
    {
        if (!negated) scanIdentifier(key, nested, { ...context, location: `${location}.${key}` })
        scanObjectKeys(nested, context, negated || key === 'not', `${location}.${key}`)
    }
}

function sourceAssignments(source)
{
    const assignments = []
    const expression = /(?:^|[,;{([.\s])(?:["']([^"']+)["']|([A-Za-z][A-Za-z0-9_-]*))\s*\??\s*(?::|=(?!=))\s*([^\n,;}]+)/gmu
    let match
    while ((match = expression.exec(source)) !== null)
    {
        assignments.push({
            identifier: match[1] ?? match[2],
            valueText: match[3],
            line: source.slice(0, match.index).split('\n').length
        })
    }
    return assignments
}

function declaredIdentifiers(source)
{
    const identifiers = []
    const expressions = [
        /\b(?:class|const|enum|function|interface|let|type|var)\s+([A-Za-z][A-Za-z0-9_-]*)/gu,
        /\b([A-Za-z][A-Za-z0-9_-]*)\s*(?:\??\s*:|\{[\t ]*(?:get|init|set)\s*;)/gu
    ]
    for (const expression of expressions)
    {
        let match
        while ((match = expression.exec(source)) !== null)
        {
            identifiers.push({ identifier: match[1], line: source.slice(0, match.index).split('\n').length })
        }
    }
    return [...new Map(identifiers.map((entry) => [`${entry.identifier}\0${entry.line}`, entry])).values()]
}

function scanMachineSource(source, context, locationPrefix = 'source')
{
    for (const assignment of sourceAssignments(source))
    {
        scanIdentifier(assignment.identifier, assignment.valueText, {
            ...context,
            location: `${locationPrefix}:line:${assignment.line}`
        })
    }
    for (const declaration of declaredIdentifiers(source))
    {
        scanIdentifier(declaration.identifier, '', {
            ...context,
            location: `${locationPrefix}:line:${declaration.line}`
        })
    }
}

function scanDocumentFences(source, context)
{
    machineFencePattern.lastIndex = 0
    let match
    while ((match = machineFencePattern.exec(source)) !== null)
    {
        const line = source.slice(0, match.index).split('\n').length
        scanMachineSource(match[2], { ...context, qualification: true }, `fence:${match[1].toLowerCase()}:line:${line}`)
    }
}

function scanPackageScripts(manifest, context)
{
    if (!manifest?.scripts || typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts)) return
    for (const [scriptName, command] of Object.entries(manifest.scripts))
    {
        const location = `$.scripts.${scriptName}`
        scanIdentifier(scriptName, command, { ...context, qualification: true, location })
        scanMachineSource(String(command), { ...context, qualification: true }, `package-script:${scriptName}`)
        for (const token of String(command).split(/\s+/u))
        {
            if (legacySurfaceName(token))
            {
                addFinding(context.findings, context.file, context.pathClasses, `forbidden-legacy-surface:${token}`, location)
            }
            const selectionField = evidenceSelectionField(token)
            if (selectionField) addFinding(context.findings, context.file, context.pathClasses, `forbidden-evidence-selection:${selectionField}`, location)
            const authorityField = authorityResidueField(token)
            if (authorityField) addFinding(context.findings, context.file, context.pathClasses, `forbidden-self-authority:${authorityField}`, location)
        }
    }
}

function walkFiles(repositoryRoot, relative, output, predicate = () => true)
{
    const absolute = path.join(repositoryRoot, relative)
    if (!fs.existsSync(absolute)) return
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) return
    if (stat.isFile())
    {
        const normalized = relative.replaceAll(path.sep, '/').replace(/^\.\//u, '')
        if (predicate(normalized)) output.push(normalized)
        return
    }
    if (!stat.isDirectory()) return
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }))
    {
        if (ignoredDirectoryNames.has(entry.name)) continue
        walkFiles(repositoryRoot, path.join(relative, entry.name), output, predicate)
    }
}

export function validateZeroLegacyScan(scan)
{
    if (scan?.schema !== zeroLegacyScanSchema) zeroLegacyFail('scan schema mismatch')
    if (JSON.stringify(scan.scanRoots) !== JSON.stringify(scanRoots)) zeroLegacyFail('scan roots are incomplete')
    const pathClassKeys = Object.keys(scan.pathClassCounts ?? {}).sort()
    if (JSON.stringify(pathClassKeys) !== JSON.stringify([...zeroLegacyRequiredPathClasses].sort())) zeroLegacyFail('path classes are incomplete')
    if (!Number.isInteger(scan.scannedFileCount) || scan.scannedFileCount < 0) zeroLegacyFail('scanned file count is invalid')
    if (pathClassKeys.some((key) => !Number.isInteger(scan.pathClassCounts[key]) || scan.pathClassCounts[key] < 0)) zeroLegacyFail('path class count is invalid')
    if (!Array.isArray(scan.findings)) zeroLegacyFail('findings are invalid')
    for (const finding of scan.findings)
    {
        if (!finding || typeof finding.file !== 'string' || finding.file.length === 0
            || !Array.isArray(finding.pathClasses) || finding.pathClasses.length === 0
            || finding.pathClasses.some((entry) => !zeroLegacyRequiredPathClasses.includes(entry))
            || typeof finding.rule !== 'string' || finding.rule.length === 0
            || typeof finding.location !== 'string' || finding.location.length === 0)
        {
            zeroLegacyFail('finding shape is invalid')
        }
    }
    return scan
}

export function scanZeroLegacyGovernance(repositoryRoot = root)
{
    const files = []
    for (const entry of scanRoots) walkFiles(repositoryRoot, entry.path, files)
    walkFiles(repositoryRoot, '.', files, (file) => path.posix.basename(file) === 'package.json')
    const uniqueFiles = [...new Set(files)].sort()
    const pathClassCounts = Object.fromEntries(zeroLegacyRequiredPathClasses.map((pathClass) => [pathClass, 0]))
    const findings = []
    for (const file of uniqueFiles)
    {
        const pathClasses = pathClassesFor(file)
        pathClasses.forEach((pathClass) => { pathClassCounts[pathClass] += 1 })
        const absolute = path.join(repositoryRoot, file)
        const context = { file, findings, pathClasses, qualification: isQualificationPath(file) }
        if (file.endsWith('.json'))
        {
            try
            {
                const document = JSON.parse(fs.readFileSync(absolute, 'utf8'))
                scanObjectKeys(document, context)
                if (pathClasses.includes('package-scripts')) scanPackageScripts(document, context)
            }
            catch { /* Syntax belongs to the corresponding schema or package gate. */ }
        }
        if (pathClasses.includes('docs'))
        {
            scanDocumentFences(fs.readFileSync(absolute, 'utf8'), context)
        }
        else if (!pathClasses.includes('tests') && machineSourceExtensions.test(file))
        {
            scanMachineSource(fs.readFileSync(absolute, 'utf8'), context)
        }
        if (legacySurfaceName(file))
        {
            addFinding(findings, file, pathClasses, `forbidden-legacy-surface:${path.posix.basename(file)}`, 'path')
        }
    }
    const uniqueFindings = [...new Map(findings.map((finding) => [
        `${finding.file}\0${finding.rule}\0${finding.location}`,
        finding
    ])).values()].sort((left, right) => `${left.file}\0${left.rule}\0${left.location}`.localeCompare(`${right.file}\0${right.rule}\0${right.location}`))
    return validateZeroLegacyScan({
        schema: zeroLegacyScanSchema,
        scanRoots: scanRoots.map((entry) => ({ ...entry })),
        scannedFileCount: uniqueFiles.length,
        pathClassCounts,
        findings: uniqueFindings
    })
}

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

export function validateFinalReport(report)
{
    if (report?.schema !== finalReportSchema) fail('report schema mismatch')
    validateZeroLegacyScan(report.zeroLegacyScan)
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
    const legacy = validateZeroLegacyScan(zeroLegacyScan ?? scanZeroLegacyGovernance(root))
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
