/**
 * Unique ProseClaimVerifier.
 * Consumes DocClaim located claims + FactObservation receipts only.
 * Does not read implementations, tests, network, embeddings, or human review state.
 */

import { readFactObservationReceipt } from '../../fact-extractors/reader.mjs'
import {
    ProseClaimErrorCode,
    makeProseClaimError,
    sortDiagnostics
} from './errors.mjs'
import {
    ProseRenderRegistry,
    proseRejectedClaimTypes,
    proseSupportedClaimTypes
} from './renderers.mjs'
import { verifyBodyAgainstPlan } from './parser.mjs'

const absoluteCommitmentPattern = /(?:总是|永不|永远|仅|必须|禁止|始终|不得|always|never|must\b|only\b|forbidden|required\b)/iu
const preciseQuantityPattern = /(?<![A-Za-z0-9_])\d+(?:[.,]\d+)?\s*(?:分钟|秒钟|秒|小时|天|毫秒|字节|位|层|次|个|项|minutes?|seconds?|hours?|days?|ms|bytes?|bits?)/iu
const precisePathPattern = /(?:^|[\s`])((?:src|tools|config|tests|ops|docs)\/[A-Za-z0-9_./-]+)/u

const executableNeighborTypes = new Set([
    'scalar',
    'boolean',
    'failure-mode',
    'binary-relation',
    'implication',
    'preservation-rule'
])

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Resolve a fact path against receipt observations.
 * Prefers exact key match (including dotted keys), then nested descent.
 */
export function resolveFactPath(observations, factPath)
{
    if (!isPlainObject(observations))
    {
        return undefined
    }
    if (Object.hasOwn(observations, factPath))
    {
        return observations[factPath]
    }
    const parts = String(factPath).split('.')
    let current = observations
    let index = 0
    while (index < parts.length)
    {
        if (!isPlainObject(current))
        {
            return undefined
        }
        let matched = null
        for (let end = parts.length; end > index; end -= 1)
        {
            const candidate = parts.slice(index, end).join('.')
            if (Object.hasOwn(current, candidate))
            {
                matched = { key: candidate, end }
                break
            }
        }
        if (matched === null) return undefined
        current = current[matched.key]
        index = matched.end
    }
    return current
}

/**
 * Index sealed receipts / reader views. Accepts paths or objects.
 * Does not invoke extractors.
 */
export function indexReceipts(receipts = [])
{
    const byExtractor = new Map()
    const list = []
    for (const entry of receipts)
    {
        const view = typeof entry === 'string'
            ? readFactObservationReceipt(entry)
            : readFactObservationReceipt(entry)
        if (byExtractor.has(view.extractorId))
        {
            throw makeProseClaimError(
                ProseClaimErrorCode.OBSERVATION_AMBIGUOUS,
                `duplicate receipt for extractor ${view.extractorId}`
            )
        }
        byExtractor.set(view.extractorId, view)
        list.push(view)
    }
    return { byExtractor, list }
}

/**
 * Find observation value for a claim across receipts.
 * Prefers receipts whose behaviorIds include the claim behaviorId.
 */
export function findObservationForClaim(claim, receiptIndex)
{
    const factPath = claim.declaration.factPath
    if (!factPath)
    {
        return { status: 'missing', reason: 'no factPath' }
    }
    const behaviorId = claim.declaration.behaviorId
    const matches = []
    for (const receipt of receiptIndex.list)
    {
        if (receipt.status !== 'ok')
        {
            if (receipt.behaviorIds.includes(behaviorId))
            {
                return {
                    status: 'failed',
                    receipt,
                    reason: `receipt status=${receipt.status}`,
                    failureReasons: receipt.failureReasons
                }
            }
            continue
        }
        if (!receipt.behaviorIds.includes(behaviorId) && receipt.behaviorIds.length > 0)
        {
            // Still allow exact factPath hit from any ok receipt, but prefer behavior match.
        }
        const value = resolveFactPath(receipt.observations, factPath)
        if (value !== undefined)
        {
            matches.push({
                receipt,
                value,
                behaviorMatch: receipt.behaviorIds.includes(behaviorId)
            })
        }
    }
    const preferred = matches.filter((entry) => entry.behaviorMatch)
    const pool = preferred.length > 0 ? preferred : matches
    if (pool.length === 0)
    {
        return { status: 'missing', reason: `factPath ${factPath} not found in receipts` }
    }
    if (pool.length > 1)
    {
        // Ambiguous only when values differ across receipts.
        const serialized = new Set(pool.map((entry) => JSON.stringify(entry.value)))
        if (serialized.size > 1)
        {
            return {
                status: 'ambiguous',
                reason: `factPath ${factPath} has conflicting observations across receipts`
            }
        }
    }
    return {
        status: 'ok',
        value: pool[0].value,
        receipt: pool[0].receipt
    }
}

function diagnosticBase(claim)
{
    return {
        claimId: claim.declaration.claimId,
        documentPath: claim.location.documentPath,
        line: claim.location.claimStartLine,
        claimType: claim.declaration.claimType,
        render: claim.declaration.render
    }
}

function neighboringExecutableClaims(claim, allClaims)
{
    const documentPath = claim.location.documentPath
    const headingKey = (claim.location.headingPath ?? []).join('\0')
    return allClaims.filter((other) =>
    {
        if (other.declaration.claimId === claim.declaration.claimId) return false
        if (other.location.documentPath !== documentPath) return false
        if (!executableNeighborTypes.has(other.declaration.claimType)) return false
        const otherHeading = (other.location.headingPath ?? []).join('\0')
        // Neighbor = same heading path or same behaviorId in the same document.
        return otherHeading === headingKey || other.declaration.behaviorId === claim.declaration.behaviorId
    })
}

function verifyRationaleClaim(claim, allClaims)
{
    const diagnostics = []
    const body = claim.location.bodyText ?? ''
    const base = diagnosticBase(claim)

    if (preciseQuantityPattern.test(body) || precisePathPattern.test(body))
    {
        diagnostics.push({
            ...base,
            code: ProseClaimErrorCode.RATIONALE_PRECISE_FACT,
            message: 'rationale body contains an unregistered precise quantity or path'
        })
    }

    if (absoluteCommitmentPattern.test(body))
    {
        const neighbors = neighboringExecutableClaims(claim, allClaims)
        if (neighbors.length === 0)
        {
            diagnostics.push({
                ...base,
                code: ProseClaimErrorCode.RATIONALE_UNBOUND,
                message: 'rationale absolute commitment has no neighboring executable claim'
            })
        }
    }

    return diagnostics
}

/**
 * Verify one located DocClaim against receipt-backed observations.
 */
export function verifyLocatedClaim(claim, receiptIndex, allClaims = [])
{
    const declaration = claim.declaration
    const base = diagnosticBase(claim)
    const claimType = declaration.claimType
    const render = declaration.render

    if (claimType === 'generated-section')
    {
        // Owned by generated-fact-sections engine; prose verifier does not pass on marker alone.
        return []
    }

    if (proseRejectedClaimTypes.includes(claimType))
    {
        return [{
            ...base,
            code: ProseClaimErrorCode.UNSUPPORTED_CLAIM_TYPE,
            message: `claimType ${claimType} must use generated-section; free-prose / fuzzy comparison is rejected`
        }]
    }

    if (!proseSupportedClaimTypes.includes(claimType))
    {
        return [{
            ...base,
            code: ProseClaimErrorCode.UNSUPPORTED_CLAIM_TYPE,
            message: `claimType ${claimType} is not admitted for prose verification`
        }]
    }

    if (claimType === 'rationale')
    {
        return verifyRationaleClaim(claim, allClaims)
    }

    // Marker without observation comparison must never count as pass.
    const observed = findObservationForClaim(claim, receiptIndex)
    if (observed.status === 'failed')
    {
        return [{
            ...base,
            code: ProseClaimErrorCode.OBSERVATION_FAILED,
            message: observed.reason,
            details: { failureReasons: observed.failureReasons }
        }]
    }
    if (observed.status === 'ambiguous')
    {
        return [{
            ...base,
            code: ProseClaimErrorCode.OBSERVATION_AMBIGUOUS,
            message: observed.reason
        }]
    }
    if (observed.status === 'missing')
    {
        return [{
            ...base,
            code: ProseClaimErrorCode.MISSING_OBSERVATION,
            message: observed.reason
        }]
    }

    let plan
    try
    {
        plan = ProseRenderRegistry.render(claimType, render, observed.value, {
            projection: declaration.projection
        })
    }
    catch (error)
    {
        return [{
            ...base,
            code: error.code ?? ProseClaimErrorCode.RENDER_SHAPE,
            message: error.message?.replace(/^\[prose-claim\]\s+[A-Z0-9_]+:\s*/u, '') ?? String(error),
            details: error.details
        }]
    }

    const bodyDiagnostics = verifyBodyAgainstPlan(claim.location.bodyText, plan, base)
    if (bodyDiagnostics.length === 0 && !claim.location.bodyText)
    {
        return [{
            ...base,
            code: ProseClaimErrorCode.MARKER_ONLY_PASS,
            message: 'claim marker without verifiable body cannot pass'
        }]
    }
    return bodyDiagnostics
}

/**
 * Unique ProseClaimVerifier entrypoint.
 *
 * @param {object} options
 * @param {Array} options.claims - located claims from DocClaim parser
 * @param {Array} options.receipts - FactObservation receipts (objects or paths)
 * @returns {{ ok: boolean, diagnostics: Array }}
 */
export function verifyProseClaims({ claims = [], receipts = [] } = {})
{
    const receiptIndex = indexReceipts(receipts)
    const located = [...claims]
    let diagnostics = []

    for (const claim of located)
    {
        diagnostics = diagnostics.concat(verifyLocatedClaim(claim, receiptIndex, located))
    }

    diagnostics = sortDiagnostics(diagnostics)
    return {
        ok: diagnostics.length === 0,
        diagnostics
    }
}

/** Convenience: build a minimal located claim for unit tests. */
export function makeLocatedClaim({
    claimId,
    behaviorId,
    claimType,
    factPath,
    render,
    bodyText,
    projection,
    documentPath = 'docs/example.md',
    claimStartLine = 1,
    headingPath = []
} = {})
{
    const declaration = {
        claimId,
        behaviorId,
        claimType,
        render
    }
    if (factPath) declaration.factPath = factPath
    if (projection) declaration.projection = projection
    return {
        declaration,
        location: {
            documentPath,
            claimStartLine,
            claimEndLine: claimStartLine + 4,
            documentStatus: 'current',
            headingPath: [...headingPath],
            bodyKind: bodyText ? 'paragraph' : 'none',
            bodyStartLine: bodyText ? claimStartLine + 5 : null,
            bodyEndLine: bodyText ? claimStartLine + 5 : null,
            bodyText: bodyText ?? ''
        }
    }
}

export const ProseClaimVerifier = Object.freeze({
    verify: verifyProseClaims,
    verifyLocatedClaim,
    findObservationForClaim,
    resolveFactPath,
    supportedClaimTypes: proseSupportedClaimTypes,
    rejectedClaimTypes: proseRejectedClaimTypes,
    renderRegistry: ProseRenderRegistry
})
