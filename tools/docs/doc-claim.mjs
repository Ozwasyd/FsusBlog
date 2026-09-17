import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestCatalog, loadCatalog } from '../contracts/behavior-contract-catalog.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const schemaRelative = 'config/schemas/doc-claim.schema.json'
export const claimMarker = 'fsus-doc-claim'
export const claimSchemaId = 'fsusblog.doc-claim.v1'
export const parseReceiptSchemaId = 'fsusblog.doc-claim-parse-receipt.v1'
export const digestAlgorithm = 'sha256'
export const canonicalSerialization = 'json-utf8-v1'

export const allowedClaimTypes = Object.freeze([
    'scalar',
    'boolean',
    'enum-set',
    'ordered-set',
    'map',
    'transition-set',
    'failure-mode',
    'binary-relation',
    'implication',
    'preservation-rule',
    'generated-section',
    'rationale'
])

export const requiredFields = Object.freeze(['claimId', 'behaviorId', 'claimType', 'render'])
export const optionalFields = Object.freeze(['anchor', 'projection', 'orderPolicy', 'emptyPolicy'])
export const payloadFields = Object.freeze(['factPath', 'generatedSectionId'])
export const allowedFields = Object.freeze([
    ...requiredFields,
    ...payloadFields,
    ...optionalFields
])

export const forbiddenFields = Object.freeze([
    'verified',
    'approved',
    'lastVerifiedCommit',
    'expectedValue',
    'baselineValue',
    'ignoreDifference',
    'waiver',
    'allowStaleUntil'
])

/** Stable machine error codes. Messages may change; codes must not. */
export const DocClaimErrorCode = Object.freeze({
    UNKNOWN_FIELD: 'DOC_CLAIM_UNKNOWN_FIELD',
    FORBIDDEN_FIELD: 'DOC_CLAIM_FORBIDDEN_FIELD',
    MISSING_FIELD: 'DOC_CLAIM_MISSING_FIELD',
    INVALID_FIELD_VALUE: 'DOC_CLAIM_INVALID_FIELD_VALUE',
    UNKNOWN_CLAIM_TYPE: 'DOC_CLAIM_UNKNOWN_CLAIM_TYPE',
    FACT_PATH_CONFLICT: 'DOC_CLAIM_FACT_PATH_CONFLICT',
    INVALID_MARKER: 'DOC_CLAIM_INVALID_MARKER',
    DUPLICATE_CLAIM_ID: 'DOC_CLAIM_DUPLICATE_CLAIM_ID',
    UNKNOWN_BEHAVIOR: 'DOC_CLAIM_UNKNOWN_BEHAVIOR',
    MISSING_BODY: 'DOC_CLAIM_MISSING_BODY',
    BODY_SHARED: 'DOC_CLAIM_BODY_SHARED',
    CROSS_HEADING_DRIFT: 'DOC_CLAIM_CROSS_HEADING_DRIFT',
    DUPLICATE_ANCHOR: 'DOC_CLAIM_DUPLICATE_ANCHOR',
    UNSTABLE_OR_MISSING_ANCHOR: 'DOC_CLAIM_UNSTABLE_OR_MISSING_ANCHOR',
    ACTIVE_IN_NON_CURRENT: 'DOC_CLAIM_ACTIVE_IN_NON_CURRENT',
    HISTORICAL_ACTIVE_BEHAVIOR: 'DOC_CLAIM_HISTORICAL_ACTIVE_BEHAVIOR',
    NON_CURRENT_ACTIVE_BEHAVIOR: 'DOC_CLAIM_NON_CURRENT_ACTIVE_BEHAVIOR',
    RATIONALE_PRECISE_FACT: 'DOC_CLAIM_RATIONALE_PRECISE_FACT',
    LEGACY_MARKER: 'DOC_CLAIM_LEGACY_MARKER',
    SELF_PROVING_SURFACE: 'DOC_CLAIM_SELF_PROVING_SURFACE',
    SECOND_PROTOCOL: 'DOC_CLAIM_SECOND_PROTOCOL',
    COMPAT_PARSER: 'DOC_CLAIM_COMPAT_PARSER',
    SCHEMA_DRIFT: 'DOC_CLAIM_SCHEMA_DRIFT',
    PASS_EVIDENCE_FORBIDDEN: 'DOC_CLAIM_PASS_EVIDENCE_FORBIDDEN'
})

const claimIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u
const behaviorIdPattern = /^[a-z][a-z0-9-]*$/u
const factPathPattern = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/u
const renderPattern = /^[a-z][a-z0-9-]*$/u
const anchorPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const fieldLinePattern = /^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*?)\s*$/u
const claimOpenPattern = new RegExp(`^<!--\\s*${claimMarker}\\s*$`, 'u')
const claimClosePattern = /^-->\s*$/u
const headingPattern = /^(#{1,6})\s+(.+?)\s*#*\s*$/u
const listPattern = /^\s*(?:[-*+]|\d+[.)])\s+\S/u
const tablePattern = /^\s*\|.+\|\s*$/u
const fencePattern = /^\s*(```+|~~~+)/u
const htmlCommentOpenPattern = /^<!--/u
const preciseQuantityPattern = /(?<![A-Za-z0-9_])\d+(?:[.,]\d+)?\s*(?:分钟|秒钟|秒|小时|天|毫秒|字节|位|层|次|个|项|minutes?|seconds?|hours?|days?|ms|bytes?|bits?)/iu
const precisePathPattern = /(?:^|[\s`])((?:src|tools|config|tests|ops|docs)\/[A-Za-z0-9_./-]+)/u
const absoluteCommitmentPattern = /(?:总是|永不|永远|仅|必须|禁止|始终|不得|always|never|must\b|only\b|forbidden|required\b)/iu

const receiptForbiddenKeys = new Set([
    ...forbiddenFields,
    'passed',
    'pass',
    'qualified',
    'qualification',
    'status',
    'observations',
    'implementationObservation',
    'testResult',
    'testResults',
    'expected',
    'baseline',
    'approvedBy',
    'allowlist'
])

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const stable = (value) =>
{
    if (Array.isArray(value))
    {
        return value.map(stable)
    }
    if (isPlainObject(value))
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    }
    return value
}

export const canonicalize = (value) => JSON.stringify(stable(value))
export const digestValue = (value) => createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')

export function loadDocClaimSchema(schemaPath = path.join(root, schemaRelative))
{
    return JSON.parse(readFileSync(schemaPath, 'utf8'))
}

export function validateDocClaimSchemaContract(schema = loadDocClaimSchema())
{
    if (schema?.$id !== claimSchemaId || schema?.additionalProperties !== false)
    {
        throw makeError(DocClaimErrorCode.SCHEMA_DRIFT, 'schema identity or fail-closed root shape drifted')
    }
    const properties = schema.properties ?? {}
    for (const field of forbiddenFields)
    {
        if (Object.hasOwn(properties, field))
        {
            throw makeError(DocClaimErrorCode.SCHEMA_DRIFT, `schema must not declare forbidden field ${field}`)
        }
    }
    if (schema.additionalProperties !== false)
    {
        throw makeError(DocClaimErrorCode.SCHEMA_DRIFT, 'schema must reject unknown fields')
    }
    const claimTypeEnum = properties.claimType?.enum ?? []
    if ([...claimTypeEnum].sort().join('\0') !== [...allowedClaimTypes].sort().join('\0'))
    {
        throw makeError(DocClaimErrorCode.SCHEMA_DRIFT, 'claimType enum drifted from loader contract')
    }
    const forbiddenEnum = schema.$defs?.forbiddenFields?.enum ?? []
    if ([...forbiddenEnum].sort().join('\0') !== [...forbiddenFields].sort().join('\0'))
    {
        throw makeError(DocClaimErrorCode.SCHEMA_DRIFT, 'forbiddenFields enum drifted from loader contract')
    }
    return true
}

export function makeError(code, message, details = {})
{
    const error = new Error(`[doc-claim] ${code}: ${message}`)
    error.code = code
    error.details = details
    return error
}

export function formatDocClaimError(error)
{
    const location = [
        error.details?.documentPath,
        error.details?.line != null ? `:${error.details.line}` : '',
        error.details?.claimId ? ` claimId=${error.details.claimId}` : ''
    ].join('')
    return `${error.code}${location ? ` (${location})` : ''}: ${error.message.replace(/^\[doc-claim\]\s+[A-Z0-9_]+:\s*/u, '')}`
}

function validateFieldValue(field, value, details)
{
    if (typeof value !== 'string' || value.length === 0)
    {
        throw makeError(DocClaimErrorCode.INVALID_FIELD_VALUE, `${field} must be a non-empty string`, details)
    }
    if (field === 'claimId' && !claimIdPattern.test(value))
    {
        throw makeError(DocClaimErrorCode.INVALID_FIELD_VALUE, `invalid claimId ${value}`, details)
    }
    if (field === 'behaviorId' && !behaviorIdPattern.test(value))
    {
        throw makeError(DocClaimErrorCode.INVALID_FIELD_VALUE, `invalid behaviorId ${value}`, details)
    }
    if (field === 'factPath' && !factPathPattern.test(value))
    {
        throw makeError(DocClaimErrorCode.INVALID_FIELD_VALUE, `invalid factPath ${value}`, details)
    }
    if (field === 'generatedSectionId' && !claimIdPattern.test(value))
    {
        throw makeError(DocClaimErrorCode.INVALID_FIELD_VALUE, `invalid generatedSectionId ${value}`, details)
    }
    if (field === 'render' && !renderPattern.test(value))
    {
        throw makeError(DocClaimErrorCode.INVALID_FIELD_VALUE, `invalid render ${value}`, details)
    }
    if (field === 'anchor' && !anchorPattern.test(value))
    {
        throw makeError(DocClaimErrorCode.INVALID_FIELD_VALUE, `invalid anchor ${value}`, details)
    }
}

/**
 * Validate a raw claim declaration object. Fail-closed on unknown/forbidden fields.
 * Does not compare implementation values or produce pass evidence.
 */
export function validateClaimDeclaration(raw, details = {})
{
    if (!isPlainObject(raw))
    {
        throw makeError(DocClaimErrorCode.INVALID_MARKER, 'claim declaration must be an object', details)
    }
    for (const key of Object.keys(raw))
    {
        if (forbiddenFields.includes(key))
        {
            throw makeError(DocClaimErrorCode.FORBIDDEN_FIELD, `forbidden field ${key}`, { ...details, field: key })
        }
        if (!allowedFields.includes(key))
        {
            throw makeError(DocClaimErrorCode.UNKNOWN_FIELD, `unknown field ${key}`, { ...details, field: key })
        }
    }
    for (const field of requiredFields)
    {
        if (!Object.hasOwn(raw, field))
        {
            throw makeError(DocClaimErrorCode.MISSING_FIELD, `missing required field ${field}`, { ...details, field })
        }
        validateFieldValue(field, raw[field], { ...details, field })
    }
    if (!allowedClaimTypes.includes(raw.claimType))
    {
        throw makeError(DocClaimErrorCode.UNKNOWN_CLAIM_TYPE, `unknown claimType ${raw.claimType}`, details)
    }
    const hasFactPath = Object.hasOwn(raw, 'factPath')
    const hasGeneratedSectionId = Object.hasOwn(raw, 'generatedSectionId')
    if (raw.claimType === 'generated-section')
    {
        if (!hasGeneratedSectionId || hasFactPath)
        {
            throw makeError(
                DocClaimErrorCode.FACT_PATH_CONFLICT,
                'generated-section claims require generatedSectionId and forbid factPath',
                details
            )
        }
        validateFieldValue('generatedSectionId', raw.generatedSectionId, { ...details, field: 'generatedSectionId' })
    }
    else if (!hasFactPath || hasGeneratedSectionId)
    {
        throw makeError(
            DocClaimErrorCode.FACT_PATH_CONFLICT,
            'non-generated claims require factPath and forbid generatedSectionId',
            details
        )
    }
    else
    {
        validateFieldValue('factPath', raw.factPath, { ...details, field: 'factPath' })
    }
    for (const field of optionalFields)
    {
        if (Object.hasOwn(raw, field))
        {
            validateFieldValue(field, raw[field], { ...details, field })
        }
    }
    const declaration = {
        claimId: raw.claimId,
        behaviorId: raw.behaviorId,
        claimType: raw.claimType,
        render: raw.render
    }
    if (hasFactPath)
    {
        declaration.factPath = raw.factPath
    }
    if (hasGeneratedSectionId)
    {
        declaration.generatedSectionId = raw.generatedSectionId
    }
    for (const field of optionalFields)
    {
        if (Object.hasOwn(raw, field))
        {
            declaration[field] = raw[field]
        }
    }
    return declaration
}

/** Canonical HTML comment serializer. One format only; field order is fixed. */
export function serializeClaimDeclaration(raw)
{
    const declaration = validateClaimDeclaration(raw)
    const order = [
        'claimId',
        'behaviorId',
        'claimType',
        'factPath',
        'generatedSectionId',
        'render',
        'anchor',
        'projection',
        'orderPolicy',
        'emptyPolicy'
    ]
    const lines = [`<!-- ${claimMarker}`]
    for (const field of order)
    {
        if (Object.hasOwn(declaration, field))
        {
            lines.push(`${field}: ${declaration[field]}`)
        }
    }
    lines.push('-->')
    return `${lines.join('\n')}\n`
}

function parseClaimBodyLines(lines, startLine, details)
{
    const raw = {}
    for (let index = 0; index < lines.length; index += 1)
    {
        const line = lines[index]
        if (!line.trim())
        {
            continue
        }
        const match = line.match(fieldLinePattern)
        if (!match)
        {
            throw makeError(
                DocClaimErrorCode.INVALID_MARKER,
                `claim field line must be 'key: value' (line ${startLine + index})`,
                { ...details, line: startLine + index }
            )
        }
        const [, key, value] = match
        if (Object.hasOwn(raw, key))
        {
            throw makeError(DocClaimErrorCode.INVALID_MARKER, `duplicate field ${key}`, { ...details, line: startLine + index, field: key })
        }
        raw[key] = value
    }
    return raw
}

export function headingAnchor(title)
{
    return title
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/gu, '-')
        .replace(/-+/gu, '-')
        .replace(/^-|-$/gu, '')
}

function classifyBodyLine(line)
{
    if (listPattern.test(line))
    {
        return 'list'
    }
    if (tablePattern.test(line))
    {
        return 'table'
    }
    if (line.trim().length > 0)
    {
        return 'paragraph'
    }
    return null
}

function isBodyTerminator(line, inFence)
{
    if (inFence)
    {
        return false
    }
    if (headingPattern.test(line) || claimOpenPattern.test(line.trim()))
    {
        return true
    }
    return false
}

function skipNonClaimHtmlComment(lines, startIndex)
{
    let index = startIndex
    const line = lines[index] ?? ''
    if (!htmlCommentOpenPattern.test(line.trim()) || claimOpenPattern.test(line.trim()))
    {
        return startIndex
    }
    if (line.includes('-->'))
    {
        return index + 1
    }
    index += 1
    while (index < lines.length)
    {
        if (lines[index].includes('-->'))
        {
            return index + 1
        }
        index += 1
    }
    return index
}

function extractBody(lines, startIndex)
{
    let index = startIndex
    while (index < lines.length)
    {
        const line = lines[index]
        if (!line.trim())
        {
            index += 1
            continue
        }
        if (htmlCommentOpenPattern.test(line.trim()) && !claimOpenPattern.test(line.trim()))
        {
            index = skipNonClaimHtmlComment(lines, index)
            continue
        }
        break
    }
    if (index >= lines.length)
    {
        return { kind: null, start: null, end: null, text: '', nextIndex: index, crossHeading: false, hitClaim: false }
    }
    if (headingPattern.test(lines[index]))
    {
        return { kind: null, start: null, end: null, text: '', nextIndex: index, crossHeading: true, hitClaim: false }
    }
    if (claimOpenPattern.test(lines[index].trim()))
    {
        return { kind: null, start: null, end: null, text: '', nextIndex: index, crossHeading: false, hitClaim: true }
    }
    if (fencePattern.test(lines[index]))
    {
        return { kind: null, start: null, end: null, text: '', nextIndex: index, crossHeading: false, hitClaim: false }
    }
    const kind = classifyBodyLine(lines[index])
    if (!kind)
    {
        return { kind: null, start: null, end: null, text: '', nextIndex: index, crossHeading: false, hitClaim: false }
    }
    const bodyLines = []
    const start = index
    let end = index
    while (index < lines.length)
    {
        const line = lines[index]
        if (fencePattern.test(line) || !line.trim() || isBodyTerminator(line, false))
        {
            break
        }
        if (kind === 'paragraph' && (listPattern.test(line) || tablePattern.test(line)))
        {
            break
        }
        if (kind === 'list' && line.trim() && !listPattern.test(line) && !/^\s+\S/u.test(line))
        {
            break
        }
        if (kind === 'table' && line.trim() && !tablePattern.test(line))
        {
            break
        }
        bodyLines.push(line)
        end = index
        index += 1
    }
    return {
        kind,
        start,
        end,
        text: bodyLines.join('\n').trimEnd(),
        nextIndex: index,
        crossHeading: false,
        hitClaim: false
    }
}

function assertRationaleBody(bodyText, details)
{
    if (!bodyText)
    {
        return
    }
    if (preciseQuantityPattern.test(bodyText) || precisePathPattern.test(bodyText))
    {
        throw makeError(
            DocClaimErrorCode.RATIONALE_PRECISE_FACT,
            'rationale body contains an unregistered precise quantity, path, or absolute fact',
            details
        )
    }
    if (absoluteCommitmentPattern.test(bodyText) && /(?:redis|postgres|jwt|cookie|permission|session|endpoint|route|api)/iu.test(bodyText))
    {
        throw makeError(
            DocClaimErrorCode.RATIONALE_PRECISE_FACT,
            'rationale body contains an absolute behavior commitment without an executable claim',
            details
        )
    }
}

/**
 * Parse claim blocks from a single Markdown document.
 * Output contains only declarations and locations — never observations, tests, or pass evidence.
 */
export function parseDocumentClaims(markdown, {
    documentPath = 'docs/unknown.md',
    documentStatus = 'current'
} = {})
{
    const lines = String(markdown).split(/\r?\n/u)
    const claims = []
    const headingStack = []
    const seenAnchors = new Map()
    const bodyOwners = new Map()
    let inFence = false
    let index = 0

    while (index < lines.length)
    {
        const line = lines[index]
        const lineNumber = index + 1
        if (fencePattern.test(line))
        {
            inFence = !inFence
            index += 1
            continue
        }
        if (inFence)
        {
            index += 1
            continue
        }
        const heading = line.match(headingPattern)
        if (heading)
        {
            const level = heading[1].length
            const title = heading[2].trim()
            const anchor = headingAnchor(title)
            while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level)
            {
                headingStack.pop()
            }
            if (seenAnchors.has(anchor))
            {
                // Only fail when claims are present in the document; checked after if any claim uses anchors or later.
                seenAnchors.set(anchor, (seenAnchors.get(anchor) ?? 0) + 1)
            }
            else
            {
                seenAnchors.set(anchor, 1)
            }
            headingStack.push({ level, title, anchor, line: lineNumber })
            index += 1
            continue
        }
        if (!claimOpenPattern.test(line.trim()))
        {
            index += 1
            continue
        }
        const claimStartLine = lineNumber
        index += 1
        const fieldLines = []
        let closed = false
        while (index < lines.length)
        {
            if (claimClosePattern.test(lines[index].trim()))
            {
                closed = true
                index += 1
                break
            }
            if (claimOpenPattern.test(lines[index].trim()) || headingPattern.test(lines[index]))
            {
                break
            }
            fieldLines.push(lines[index])
            index += 1
        }
        const details = { documentPath, line: claimStartLine }
        if (!closed)
        {
            throw makeError(DocClaimErrorCode.INVALID_MARKER, 'unclosed doc claim block', details)
        }
        const raw = parseClaimBodyLines(fieldLines, claimStartLine + 1, details)
        const declaration = validateClaimDeclaration(raw, { ...details, claimId: raw.claimId })
        details.claimId = declaration.claimId

        let bodyKind = 'none'
        let bodyStartLine = null
        let bodyEndLine = null
        let bodyText = ''
        if (declaration.claimType === 'generated-section')
        {
            // generated-section only declares an ID; no prose body binding.
        }
        else
        {
            const body = extractBody(lines, index)
            if (body.crossHeading)
            {
                throw makeError(
                    DocClaimErrorCode.CROSS_HEADING_DRIFT,
                    'claim body cannot cross a heading boundary',
                    details
                )
            }
            if (body.hitClaim || !body.kind)
            {
                throw makeError(
                    DocClaimErrorCode.MISSING_BODY,
                    'non-generated claim must bind the next non-empty paragraph, list, or table',
                    details
                )
            }
            bodyKind = body.kind
            bodyStartLine = body.start + 1
            bodyEndLine = body.end + 1
            bodyText = body.text
            const bodyKey = `${documentPath}:${bodyStartLine}:${bodyEndLine}`
            const previous = bodyOwners.get(bodyKey)
            if (previous && previous.behaviorId !== declaration.behaviorId)
            {
                throw makeError(
                    DocClaimErrorCode.BODY_SHARED,
                    `body block is already bound to behavior ${previous.behaviorId}`,
                    details
                )
            }
            bodyOwners.set(bodyKey, declaration)
            if (declaration.claimType === 'rationale')
            {
                assertRationaleBody(bodyText, details)
            }
        }

        if (declaration.anchor)
        {
            const count = seenAnchors.get(declaration.anchor) ?? 0
            if (count === 0)
            {
                throw makeError(
                    DocClaimErrorCode.UNSTABLE_OR_MISSING_ANCHOR,
                    `claim anchor ${declaration.anchor} does not match a heading in the document`,
                    details
                )
            }
            if (count > 1)
            {
                throw makeError(
                    DocClaimErrorCode.DUPLICATE_ANCHOR,
                    `claim anchor ${declaration.anchor} is not unique in the document`,
                    details
                )
            }
        }

        claims.push({
            declaration,
            location: {
                documentPath,
                claimStartLine,
                claimEndLine: index,
                documentStatus,
                headingPath: headingStack.map((entry) => entry.title),
                bodyKind,
                bodyStartLine,
                bodyEndLine,
                bodyText
            }
        })
    }

    // Duplicate heading anchors only matter when a claim references anchors or any claim exists.
    if (claims.length > 0)
    {
        for (const [anchor, count] of seenAnchors)
        {
            if (count > 1 && claims.some((claim) => claim.declaration.anchor === anchor))
            {
                throw makeError(
                    DocClaimErrorCode.DUPLICATE_ANCHOR,
                    `heading anchor ${anchor} is duplicated`,
                    { documentPath }
                )
            }
        }
    }

    return claims
}

function loadLifecycleStatusMap(repositoryRoot)
{
    const lifecyclePath = path.join(repositoryRoot, 'config/development/document-lifecycle.json')
    if (!existsSync(lifecyclePath))
    {
        return new Map()
    }
    const policy = JSON.parse(readFileSync(lifecyclePath, 'utf8'))
    return new Map((policy.documents ?? []).map((document) => [document.path, document.status]))
}

function walkMarkdown(directory, out = [])
{
    if (!existsSync(directory))
    {
        return out
    }
    for (const entry of readdirSync(directory))
    {
        if (entry === 'node_modules' || entry === '.git' || entry === '.tmp')
        {
            continue
        }
        const target = path.join(directory, entry)
        const stat = statSync(target)
        if (stat.isDirectory())
        {
            walkMarkdown(target, out)
        }
        else if (entry.endsWith('.md'))
        {
            out.push(target)
        }
    }
    return out
}

/**
 * Build a parse receipt. Never includes lastVerifiedCommit, observations, or pass/fail.
 */
export function buildParseReceipt(locatedClaims, { behaviorCatalogDigest })
{
    const claims = [...locatedClaims]
        .map((entry) => ({
            declaration: entry.declaration,
            location: {
                documentPath: entry.location.documentPath,
                claimStartLine: entry.location.claimStartLine,
                claimEndLine: entry.location.claimEndLine,
                documentStatus: entry.location.documentStatus,
                headingPath: [...entry.location.headingPath],
                bodyKind: entry.location.bodyKind,
                bodyStartLine: entry.location.bodyStartLine,
                bodyEndLine: entry.location.bodyEndLine,
                bodyText: entry.location.bodyText
            }
        }))
        .sort((left, right) =>
        {
            const byId = left.declaration.claimId.localeCompare(right.declaration.claimId)
            if (byId !== 0)
            {
                return byId
            }
            return left.location.documentPath.localeCompare(right.location.documentPath)
        })

    const receipt = {
        schema: parseReceiptSchemaId,
        digestAlgorithm,
        canonicalSerialization,
        behaviorCatalogDigest,
        claims
    }
    assertReceiptHasNoPassEvidence(receipt)
    return {
        ...receipt,
        contentDigest: digestValue(receipt)
    }
}

export function receiptProducesPassEvidence(receipt)
{
    if (!isPlainObject(receipt))
    {
        return false
    }
    for (const key of Object.keys(receipt))
    {
        if (receiptForbiddenKeys.has(key))
        {
            return true
        }
    }
    // Parse receipts only declare shape; they never encode pass.
    return false
}

export function assertReceiptHasNoPassEvidence(receipt)
{
    if (receiptProducesPassEvidence(receipt))
    {
        throw makeError(
            DocClaimErrorCode.PASS_EVIDENCE_FORBIDDEN,
            'DocClaim parse receipt must not contain pass/fail, verification, observation, or lastVerifiedCommit inputs'
        )
    }
    const serialized = canonicalize(receipt)
    for (const field of forbiddenFields)
    {
        if (new RegExp(`"${field}"\\s*:`, 'u').test(serialized))
        {
            throw makeError(
                DocClaimErrorCode.PASS_EVIDENCE_FORBIDDEN,
                `DocClaim receipt digest input contains forbidden field ${field}`
            )
        }
    }
    if (/"lastVerifiedCommit"\s*:/u.test(serialized))
    {
        throw makeError(
            DocClaimErrorCode.PASS_EVIDENCE_FORBIDDEN,
            'lastVerifiedCommit must not enter DocClaim receipt or digest inputs'
        )
    }
}

function validateClaimAgainstBehavior(declaration, location, contracts)
{
    const contract = contracts.get(declaration.behaviorId)
    if (!contract)
    {
        throw makeError(
            DocClaimErrorCode.UNKNOWN_BEHAVIOR,
            `claimId ${declaration.claimId} binds unknown behaviorId ${declaration.behaviorId}`,
            { documentPath: location.documentPath, line: location.claimStartLine, claimId: declaration.claimId }
        )
    }
    const status = location.documentStatus
    if (contract.status === 'active')
    {
        if (status !== 'current')
        {
            throw makeError(
                status === 'historical'
                    ? DocClaimErrorCode.HISTORICAL_ACTIVE_BEHAVIOR
                    : DocClaimErrorCode.ACTIVE_IN_NON_CURRENT,
                `active behavior ${declaration.behaviorId} may only be claimed from current documentation`,
                { documentPath: location.documentPath, line: location.claimStartLine, claimId: declaration.claimId }
            )
        }
        return
    }
    if (status === 'current')
    {
        throw makeError(
            DocClaimErrorCode.NON_CURRENT_ACTIVE_BEHAVIOR,
            `current documentation cannot claim ${contract.status} behavior ${declaration.behaviorId}`,
            { documentPath: location.documentPath, line: location.claimStartLine, claimId: declaration.claimId }
        )
    }
    if (status === 'historical')
    {
        if (contract.status !== 'migration-only' && contract.status !== 'retired')
        {
            throw makeError(
                DocClaimErrorCode.HISTORICAL_ACTIVE_BEHAVIOR,
                'historical documentation may only reference migration-only or retired behaviors',
                { documentPath: location.documentPath, line: location.claimStartLine, claimId: declaration.claimId }
            )
        }
        // Historical migration/retired claims parse, but parse receipts never produce qualification evidence.
        return
    }
    throw makeError(
        DocClaimErrorCode.ACTIVE_IN_NON_CURRENT,
        `document status ${status} cannot host DocClaim declarations`,
        { documentPath: location.documentPath, line: location.claimStartLine, claimId: declaration.claimId }
    )
}

/**
 * Parse and gate claims across repository Markdown governed by document lifecycle.
 * Does not run extractors, compare implementation values, or emit pass evidence.
 */
export function parseRepositoryClaims(repositoryRoot = root, options = {})
{
    validateDocClaimSchemaContract(loadDocClaimSchema(path.join(repositoryRoot, schemaRelative)))
    const catalog = options.catalog ?? loadCatalog(path.join(repositoryRoot, 'config/contracts/behavior-contracts.json'))
    const contracts = new Map(catalog.contracts.map((contract) => [contract.id, contract]))
    const behaviorCatalogDigest = options.behaviorCatalogDigest ?? digestCatalog(catalog)
    const statusMap = options.statusMap ?? loadLifecycleStatusMap(repositoryRoot)
    const docsRoot = path.join(repositoryRoot, 'docs')
    const located = []
    const claimIds = new Map()

    for (const absolute of walkMarkdown(docsRoot).sort())
    {
        const documentPath = path.relative(repositoryRoot, absolute).split(path.sep).join('/')
        const source = readFileSync(absolute, 'utf8')
        if (!source.includes(claimMarker) && !/fsus[-_]doc[-_]claim/i.test(source) && !/<!--\s*fsus-claim/i.test(source))
        {
            continue
        }
        // Legacy/second-protocol markers fail closed even inside non-current docs.
        assertNoLegacyClaimSurfaces(source, documentPath)
        if (!source.includes(`<!-- ${claimMarker}`) && !source.includes(`<!--${claimMarker}`))
        {
            continue
        }
        const documentStatus = statusMap.get(documentPath)
        if (!documentStatus)
        {
            // Unclassified docs under docs/ cannot host claims.
            if (source.includes(claimMarker))
            {
                throw makeError(
                    DocClaimErrorCode.NON_CURRENT_ACTIVE_BEHAVIOR,
                    `${documentPath} is not registered in document lifecycle and cannot host DocClaim`,
                    { documentPath }
                )
            }
            continue
        }
        // Parser only accepts claims from current docs for active pipeline, and historical for migration/retired.
        if (documentStatus !== 'current' && documentStatus !== 'historical')
        {
            if (source.includes(claimMarker))
            {
                throw makeError(
                    DocClaimErrorCode.NON_CURRENT_ACTIVE_BEHAVIOR,
                    `${documentPath} status ${documentStatus} cannot host DocClaim declarations`,
                    { documentPath }
                )
            }
            continue
        }
        const parsed = parseDocumentClaims(source, { documentPath, documentStatus })
        for (const entry of parsed)
        {
            const previous = claimIds.get(entry.declaration.claimId)
            if (previous)
            {
                throw makeError(
                    DocClaimErrorCode.DUPLICATE_CLAIM_ID,
                    `claimId ${entry.declaration.claimId} is duplicated in ${previous} and ${documentPath}`,
                    { documentPath, line: entry.location.claimStartLine, claimId: entry.declaration.claimId }
                )
            }
            claimIds.set(entry.declaration.claimId, documentPath)
            validateClaimAgainstBehavior(entry.declaration, entry.location, contracts)
            located.push(entry)
        }
    }

    return buildParseReceipt(located, { behaviorCatalogDigest })
}

export function assertNoLegacyClaimSurfaces(source, documentPath = '<input>')
{
    const patterns = [
        { code: DocClaimErrorCode.LEGACY_MARKER, regex: /<!--\s*fsus-claim(?:-v\d+)?\b/iu, message: 'legacy claim marker is forbidden' },
        { code: DocClaimErrorCode.LEGACY_MARKER, regex: /<!--\s*fsus-doc-claim-legacy\b/iu, message: 'legacy doc-claim marker is forbidden' },
        { code: DocClaimErrorCode.SECOND_PROTOCOL, regex: /fsusblog\.doc-claim\.v0\b/u, message: 'second DocClaim protocol version is forbidden' },
        { code: DocClaimErrorCode.COMPAT_PARSER, regex: /\b(?:compat(?:ibility)?|legacy|deprecated)[_-]?doc[_-]?claim[_-]?(?:parser|reader|format)?\b/iu, message: 'compatibility DocClaim parser surface is forbidden' },
        {
            code: DocClaimErrorCode.SELF_PROVING_SURFACE,
            regex: /<!--\s*fsus-doc-claim[\s\S]*?\b(?:verified|approved|lastVerifiedCommit|expectedValue|baselineValue|ignoreDifference|waiver|allowStaleUntil)\s*:/u,
            message: 'self-proving field inside claim block is forbidden'
        }
    ]
    for (const pattern of patterns)
    {
        if (pattern.regex.test(source))
        {
            throw makeError(pattern.code, pattern.message, { documentPath })
        }
    }
}

const governanceScanRoots = ['tools', 'tests', 'config', 'docs', 'src']
const governanceAllowRelative = new Set([
    'config/schemas/doc-claim.schema.json',
    'tools/contracts/behavior-graph-join.mjs',
    'tools/docs/doc-claim.mjs',
    'tools/docs/check-doc-claim.mjs',
    'tests/tools/doc-claim.test.mjs',
    'tests/tools/doc-claim-staleness-mutation.test.mjs',
    'tools/docs/doc-claim-staleness-mutation/layers.mjs',
    'tools/docs/doc-claim-staleness-mutation/fixture.mjs',
    'tools/docs/doc-claim-staleness-mutation/catalog.mjs',
    'tools/docs/doc-claim-staleness-mutation/runner.mjs',
    'tools/docs/doc-claim-staleness-mutation/governance.mjs',
    'tools/docs/doc-claim-staleness-mutation/index.mjs',
    'docs/development/doc-claim-protocol.md'
])

/**
 * Repository governance scan: no second protocol, compat parser, or self-proving baseline surfaces.
 */
export function scanDocClaimGovernance(repositoryRoot = root)
{
    const violations = []
    const forbiddenSurface = /\b(?:compat(?:ibility)?|legacy|deprecated)[_-]?doc[_-]?claim[_-]?(?:parser|reader|format)?\b/iu
    const secondProtocol = /fsusblog\.doc-claim\.v0\b|<!--\s*fsus-claim(?:-v\d+)?\b|<!--\s*fsus-doc-claim-legacy\b/iu
    const selfProvingInClaimTools = /\bexpectedValue\b|\bbaselineValue\b|\ballowStaleUntil\b|\bignoreDifference\b/
    const passEvidenceHook = /lastVerifiedCommit.*(?:pass|qualify|digest)|(?:pass|qualify|digest).*lastVerifiedCommit/iu

    const walk = (directory) =>
    {
        for (const entry of readdirSync(directory))
        {
            if (entry === 'node_modules' || entry === '.git' || entry === '.tmp' || entry === 'bin' || entry === 'obj')
            {
                continue
            }
            const absolute = path.join(directory, entry)
            const stat = statSync(absolute)
            if (stat.isDirectory())
            {
                walk(absolute)
                continue
            }
            if (!/\.(?:mjs|js|ts|tsx|json|md|cs|yml|yaml)$/u.test(entry))
            {
                continue
            }
            const relative = path.relative(repositoryRoot, absolute).split(path.sep).join('/')
            if (governanceAllowRelative.has(relative))
            {
                // Allowed owners may document ban lists. Only real compatibility entrypoints fail.
                const source = readFileSync(absolute, 'utf8')
                if (/(?:export\s+)?(?:async\s+)?function\s+parseLegacyDocClaim\b|export\s+const\s+legacyDocClaimParser\b/u.test(source))
                {
                    violations.push({ code: DocClaimErrorCode.COMPAT_PARSER, documentPath: relative, message: 'compatibility parser implementation is forbidden' })
                }
                continue
            }
            const source = readFileSync(absolute, 'utf8')
            if (forbiddenSurface.test(source))
            {
                violations.push({ code: DocClaimErrorCode.COMPAT_PARSER, documentPath: relative, message: 'compatibility DocClaim surface detected' })
            }
            if (secondProtocol.test(source))
            {
                violations.push({ code: DocClaimErrorCode.SECOND_PROTOCOL, documentPath: relative, message: 'second/legacy DocClaim protocol marker detected' })
            }
            if (relative.startsWith('tools/') && selfProvingInClaimTools.test(source) && /doc-claim|DocClaim/u.test(source))
            {
                violations.push({ code: DocClaimErrorCode.SELF_PROVING_SURFACE, documentPath: relative, message: 'self-proving claim field surface detected' })
            }
            if (relative.startsWith('tools/docs/') && passEvidenceHook.test(source))
            {
                violations.push({ code: DocClaimErrorCode.PASS_EVIDENCE_FORBIDDEN, documentPath: relative, message: 'lastVerifiedCommit must not participate in DocClaim pass/fail' })
            }
        }
    }

    for (const relativeRoot of governanceScanRoots)
    {
        const absolute = path.join(repositoryRoot, relativeRoot)
        if (existsSync(absolute))
        {
            walk(absolute)
        }
    }
    return violations
}

/**
 * Assert document-lifecycle and markdown lint tooling do not re-host claim schema authority.
 */
export function assertNoClaimSchemaDuplication(repositoryRoot = root)
{
    const suspects = [
        'tools/docs/document-lifecycle.mjs',
        'tools/docs/generate-document-lifecycle.mjs',
        'tools/docs/check-authoritative-development-docs.mjs',
        '.markdownlint-cli2.jsonc'
    ]
    for (const relative of suspects)
    {
        const absolute = path.join(repositoryRoot, relative)
        if (!existsSync(absolute))
        {
            continue
        }
        const source = readFileSync(absolute, 'utf8')
        if (source.includes(claimSchemaId) || source.includes('allowedClaimTypes =') || /factPath.*generatedSectionId/u.test(source))
        {
            throw makeError(
                DocClaimErrorCode.SECOND_PROTOCOL,
                `${relative} must not copy DocClaim schema authority`
            )
        }
    }
}
