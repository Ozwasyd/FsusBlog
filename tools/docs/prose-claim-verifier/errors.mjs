/**
 * Stable machine error/diagnostic codes for ProseClaimVerifier.
 * Messages may change; codes must not.
 */

export const ProseClaimErrorCode = Object.freeze({
    UNSUPPORTED_CLAIM_TYPE: 'PROSE_CLAIM_UNSUPPORTED_CLAIM_TYPE',
    UNKNOWN_RENDER: 'PROSE_CLAIM_UNKNOWN_RENDER',
    RENDER_SHAPE: 'PROSE_CLAIM_RENDER_SHAPE',
    MISSING_OBSERVATION: 'PROSE_CLAIM_MISSING_OBSERVATION',
    OBSERVATION_FAILED: 'PROSE_CLAIM_OBSERVATION_FAILED',
    OBSERVATION_AMBIGUOUS: 'PROSE_CLAIM_OBSERVATION_AMBIGUOUS',
    REQUIRED_TOKEN_MISSING: 'PROSE_CLAIM_REQUIRED_TOKEN_MISSING',
    FORBIDDEN_TOKEN_PRESENT: 'PROSE_CLAIM_FORBIDDEN_TOKEN_PRESENT',
    CONFLICTING_VALUE: 'PROSE_CLAIM_CONFLICTING_VALUE',
    BOUNDARY_MISMATCH: 'PROSE_CLAIM_BOUNDARY_MISMATCH',
    BOOLEAN_CONFLICT: 'PROSE_CLAIM_BOOLEAN_CONFLICT',
    FAILURE_POLICY_CONFLICT: 'PROSE_CLAIM_FAILURE_POLICY_CONFLICT',
    RELATION_DIRECTION: 'PROSE_CLAIM_RELATION_DIRECTION',
    IMPLICATION_MISMATCH: 'PROSE_CLAIM_IMPLICATION_MISMATCH',
    PRESERVATION_MISMATCH: 'PROSE_CLAIM_PRESERVATION_MISMATCH',
    RATIONALE_UNBOUND: 'PROSE_CLAIM_RATIONALE_UNBOUND',
    RATIONALE_PRECISE_FACT: 'PROSE_CLAIM_RATIONALE_PRECISE_FACT',
    MARKER_ONLY_PASS: 'PROSE_CLAIM_MARKER_ONLY_PASS',
    FUZZY_SCAN_FORBIDDEN: 'PROSE_CLAIM_FUZZY_SCAN_FORBIDDEN',
    REVIEWED_FLAG_FORBIDDEN: 'PROSE_CLAIM_REVIEWED_FLAG_FORBIDDEN',
    BASELINE_ALLOWLIST_FORBIDDEN: 'PROSE_CLAIM_BASELINE_ALLOWLIST_FORBIDDEN',
    COMPAT_PARSER_FORBIDDEN: 'PROSE_CLAIM_COMPAT_PARSER_FORBIDDEN',
    WARNING_ONLY_FORBIDDEN: 'PROSE_CLAIM_WARNING_ONLY_FORBIDDEN',
    SECOND_REGISTRY: 'PROSE_CLAIM_SECOND_REGISTRY',
    LLM_OR_NETWORK_FORBIDDEN: 'PROSE_CLAIM_LLM_OR_NETWORK_FORBIDDEN',
    CLAIM_TYPE_RENDER_MISMATCH: 'PROSE_CLAIM_CLAIM_TYPE_RENDER_MISMATCH'
})

export function makeProseClaimError(code, message, details = {})
{
    const error = new Error(`[prose-claim] ${code}: ${message}`)
    error.code = code
    error.details = details
    return error
}

export function formatProseClaimDiagnostic(diagnostic)
{
    const location = [
        diagnostic.documentPath,
        diagnostic.line != null ? `:${diagnostic.line}` : '',
        diagnostic.claimId ? ` claimId=${diagnostic.claimId}` : ''
    ].join('')
    return `${diagnostic.code}${location ? ` (${location})` : ''}: ${diagnostic.message}`
}

/**
 * Sort diagnostics deterministically: documentPath, claimStartLine, claimId, code, message.
 */
export function sortDiagnostics(diagnostics)
{
    return [...diagnostics].sort((left, right) =>
    {
        const byPath = String(left.documentPath ?? '').localeCompare(String(right.documentPath ?? ''))
        if (byPath !== 0) return byPath
        const byLine = (left.line ?? 0) - (right.line ?? 0)
        if (byLine !== 0) return byLine
        const byClaim = String(left.claimId ?? '').localeCompare(String(right.claimId ?? ''))
        if (byClaim !== 0) return byClaim
        const byCode = String(left.code ?? '').localeCompare(String(right.code ?? ''))
        if (byCode !== 0) return byCode
        return String(left.message ?? '').localeCompare(String(right.message ?? ''))
    })
}
