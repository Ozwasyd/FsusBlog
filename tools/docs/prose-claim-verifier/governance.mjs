/**
 * Repository governance for ProseClaimVerifier:
 * single registry, no fuzzy whole-document scan, no reviewed flag,
 * no baseline allowlist, no compat/loose/warning-only modes, no LLM/network.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProseClaimErrorCode } from './errors.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export const frameworkFiles = Object.freeze([
    'tools/docs/prose-claim-verifier/errors.mjs',
    'tools/docs/prose-claim-verifier/phrases.mjs',
    'tools/docs/prose-claim-verifier/renderers.mjs',
    'tools/docs/prose-claim-verifier/parser.mjs',
    'tools/docs/prose-claim-verifier/verifier.mjs',
    'tools/docs/prose-claim-verifier/governance.mjs',
    'tools/docs/check-prose-claims.mjs',
    'tests/tools/prose-claim-verifier.test.mjs',
    'docs/development/doc-claim-protocol.md',
    'config/schemas/doc-claim.schema.json',
    'tools/docs/doc-claim.mjs'
])

const scanRoots = Object.freeze(['tools', 'tests', 'config', 'docs'])

function walkFiles(directory, out = [])
{
    if (!existsSync(directory)) return out
    for (const entry of readdirSync(directory, { withFileTypes: true }))
    {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.tmp') continue
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) walkFiles(absolute, out)
        else if (entry.isFile()) out.push(absolute)
    }
    return out
}

function relativeOf(repositoryRoot, absolute)
{
    return path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/')
}

/**
 * Patterns that must return 0 hits outside framework allowlist / ban-list documentation.
 */
const forbiddenPatterns = Object.freeze([
    {
        code: ProseClaimErrorCode.FUZZY_SCAN_FORBIDDEN,
        // Whole-document keyword scan used as verification (not bound-block parser).
        regex: /\bfuzzy(?:FullText|Keyword|Prose)?(?:Scan|Match|Search|Compare)\b|\bscanEntireDocumentForClaim\b|\bwholeDocumentKeyword(?:Scan|Match)\b/iu,
        message: 'fuzzy full-text / whole-document keyword scan surface is forbidden'
    },
    {
        code: ProseClaimErrorCode.REVIEWED_FLAG_FORBIDDEN,
        regex: /\bproseReviewed\b|\breviewed\s*[:=]\s*true\b.*prose|\bhumanReviewedProse\b|\bmanualProseReview\b/iu,
        message: 'human reviewed flag / manual prose review surface is forbidden'
    },
    {
        code: ProseClaimErrorCode.BASELINE_ALLOWLIST_FORBIDDEN,
        regex: /\bproseClaimBaselineAllowlist\b|\bproseBaselineAllowlist\b|\ballowStaleProse\b|\bproseDiffAllowlist\b/iu,
        message: 'prose claim baseline allowlist surface is forbidden'
    },
    {
        code: ProseClaimErrorCode.COMPAT_PARSER_FORBIDDEN,
        regex: /\b(?:compat(?:ibility)?|legacy|deprecated|loose)[_-]?prose[_-]?(?:claim[_-]?)?(?:parser|verifier|reader|mode)\b|\bwarningOnlyProseClaims\b|\bproseClaimFeatureFlag\b/iu,
        message: 'compat/loose/warning-only prose claim surface is forbidden'
    },
    {
        code: ProseClaimErrorCode.WARNING_ONLY_FORBIDDEN,
        regex: /\bproseClaimWarningOnly\b|\bwarnOnlyProseVerifier\b/iu,
        message: 'warning-only prose verifier surface is forbidden'
    },
    {
        code: ProseClaimErrorCode.SECOND_REGISTRY,
        regex: /\bcreateProseRenderRegistry\b|\blegacyProseRenderRegistry\b|\bdomainProseRenderRegistry\b|\bsecondProseClaimVerifier\b/iu,
        message: 'second prose render/verifier registry surface is forbidden'
    },
    {
        code: ProseClaimErrorCode.LLM_OR_NETWORK_FORBIDDEN,
        regex: /\b(?:openai|anthropic|embeddingModel|callLlm|llmJudge|vectorSimilarity)\b.*prose|prose.*\b(?:openai|anthropic|embeddingModel|callLlm|llmJudge)\b/iu,
        message: 'LLM/network/embedding prose judgment surface is forbidden'
    }
])

export function scanProseClaimGovernance(repositoryRoot = root)
{
    const violations = []
    const allow = new Set(frameworkFiles)

    for (const relative of frameworkFiles)
    {
        if (relative.endsWith('.md') || relative.endsWith('.test.mjs')) continue
        const absolute = path.join(repositoryRoot, relative)
        if (!existsSync(absolute))
        {
            violations.push({
                code: ProseClaimErrorCode.SECOND_REGISTRY,
                documentPath: relative,
                message: `missing prose-claim framework file ${relative}`
            })
        }
    }

    // Framework files may document ban lists; still forbid real alternate entrypoints.
    for (const relative of [
        'tools/docs/prose-claim-verifier/renderers.mjs',
        'tools/docs/prose-claim-verifier/verifier.mjs',
        'tools/docs/prose-claim-verifier/parser.mjs'
    ])
    {
        const absolute = path.join(repositoryRoot, relative)
        if (!existsSync(absolute)) continue
        const source = readFileSync(absolute, 'utf8')
        if (/from\s+['"][^'"]*fact-extractors\/(?!reader\.mjs)[^'"]*['"]/u.test(source)
            && /extract\s*\(/u.test(source))
        {
            violations.push({
                code: ProseClaimErrorCode.LLM_OR_NETWORK_FORBIDDEN,
                documentPath: relative,
                message: 'prose verifier must consume receipts only; must not invoke extractors'
            })
        }
        if (/from\s+['"][^'"]*\/src\//u.test(source) || /from\s+['"][^'"]*tests\//u.test(source))
        {
            violations.push({
                code: ProseClaimErrorCode.LLM_OR_NETWORK_FORBIDDEN,
                documentPath: relative,
                message: 'prose verifier must not import business implementations or tests'
            })
        }
        if (/\bfetch\s*\(|\bhttps?:\/\//u.test(source) && /verifyProse|ProseClaim/u.test(source))
        {
            // Allow comments that ban network; only fail on actual fetch usage near verifier exports.
            if (/\bfetch\s*\(/u.test(source))
            {
                violations.push({
                    code: ProseClaimErrorCode.LLM_OR_NETWORK_FORBIDDEN,
                    documentPath: relative,
                    message: 'prose verifier must not perform network I/O'
                })
            }
        }
    }

    for (const relativeRoot of scanRoots)
    {
        const absoluteRoot = path.join(repositoryRoot, relativeRoot)
        for (const absolute of walkFiles(absoluteRoot))
        {
            if (!/\.(?:mjs|js|ts|json|md)$/u.test(absolute)) continue
            const relative = relativeOf(repositoryRoot, absolute)
            if (allow.has(relative)) continue
            if (relative.includes('document-inventory.generated.json')) continue
            if (relative.includes('node_modules')) continue

            let source
            try
            {
                const size = statSync(absolute).size
                if (size > 1_500_000) continue
                source = readFileSync(absolute, 'utf8')
            }
            catch
            {
                continue
            }

            for (const pattern of forbiddenPatterns)
            {
                if (pattern.regex.test(source))
                {
                    violations.push({
                        code: pattern.code,
                        documentPath: relative,
                        message: pattern.message
                    })
                }
            }
        }
    }

    return violations
}

export function formatGovernanceViolations(violations)
{
    return violations.map((entry) => `[${entry.code}] ${entry.documentPath}: ${entry.message}`)
}

/**
 * Code-search style checks required by acceptance: fuzzy scan, reviewed flag,
 * baseline allowlist must return 0 matches outside framework ban documentation.
 */
export function countForbiddenProseSurfaces(repositoryRoot = root)
{
    const violations = scanProseClaimGovernance(repositoryRoot)
    return {
        fuzzy: violations.filter((entry) => entry.code === ProseClaimErrorCode.FUZZY_SCAN_FORBIDDEN).length,
        reviewed: violations.filter((entry) => entry.code === ProseClaimErrorCode.REVIEWED_FLAG_FORBIDDEN).length,
        baseline: violations.filter((entry) => entry.code === ProseClaimErrorCode.BASELINE_ALLOWLIST_FORBIDDEN).length,
        total: violations.length,
        violations
    }
}
