/**
 * Coverage + weak-negative governance for the staleness mutation suite.
 * Fails when claimType/renderer/invariant lacks mutation coverage, or when
 * broad bad-doc fixtures / allowlists / flaky retry surfaces reappear.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { allowedClaimTypes } from '../doc-claim.mjs'
import { allowedProseRenders } from '../prose-claim-verifier/renderers.mjs'
import { allowedRenderers } from '../generated-fact-sections/renderers.mjs'
import {
    mutationCases,
    requiredMutationIds,
    requiredPositiveControlIds,
    surfaceCoverage,
    targetInvariants
} from './catalog.mjs'
import { allowedMutationLayers, forbiddenReasonCodes } from './layers.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export const suiteFiles = Object.freeze([
    'tools/docs/doc-claim-staleness-mutation/layers.mjs',
    'tools/docs/doc-claim-staleness-mutation/fixture.mjs',
    'tools/docs/doc-claim-staleness-mutation/catalog.mjs',
    'tools/docs/doc-claim-staleness-mutation/runner.mjs',
    'tools/docs/doc-claim-staleness-mutation/governance.mjs',
    'tools/docs/doc-claim-staleness-mutation/index.mjs',
    'tests/tools/doc-claim-staleness-mutation.test.mjs'
])

const weakPatterns = Object.freeze([
    {
        id: 'bad-doc-multifile-fixture',
        // Multi-file fuzzy bad-doc repos used as a single negative blob.
        regex: /\bbadDocs?FixtureRepository\b|\bfuzzyBadDoc(?:s|Fixture)?\b|\bmultiFileBadDoc\b|\bweakNegativeDocFixture\b/iu,
        message: 'multi-file fuzzy bad-doc fixture surface is forbidden'
    },
    {
        id: 'mutation-allowlist',
        regex: /\bstalenessMutationAllowlist\b|\bmutationCaseAllowlist\b|\bbaselineOnlyAllowlist\b|\ballowStaleDocClaim\b/iu,
        message: 'mutation/baseline allowlist surface is forbidden'
    },
    {
        id: 'flaky-retry',
        regex: /\bflakyRetryMutation\b|\bretryUntilMutationPasses\b|\bsleep\s*\(\s*\d+\s*\).{0,80}mutation/iu,
        message: 'flaky retry / sleep-based mutation surface is forbidden'
    },
    {
        id: 'vague-exit-only',
        // Suite code must not assert only process exit without reasonCode.
        regex: /assert\.notEqual\s*\(\s*\w+\.status\s*,\s*0\s*\)\s*(?:;|\n)(?![\s\S]{0,200}reasonCode)/iu,
        message: 'exit!=0-only assertion without reasonCode is forbidden in suite'
    },
    {
        id: 'compat-runner',
        regex: /\blegacyMutationRunner\b|\bcompatStalenessSuite\b|\bfeatureFlagStalenessMutation\b/iu,
        message: 'compat/legacy mutation runner surface is forbidden'
    },
    {
        id: 'llm-judge',
        regex: /\bllmJudgeMutation\b|\bcallLlm\b.*mutation|mutation.*\bopenai\b/iu,
        message: 'LLM-judged mutation surface is forbidden'
    }
])

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
 * Ensure every required mutation id and positive control is present exactly once.
 */
export function assertRequiredCaseCoverage(cases = mutationCases)
{
    const violations = []
    const ids = cases.map((entry) => entry.id)
    const unique = new Set(ids)
    if (unique.size !== ids.length)
    {
        violations.push({ code: 'DUPLICATE_CASE_ID', message: 'mutation case ids must be unique' })
    }
    for (const id of requiredMutationIds)
    {
        if (!unique.has(id))
        {
            violations.push({ code: 'MISSING_MUTATION_CASE', message: `required mutation case missing: ${id}` })
        }
    }
    for (const id of requiredPositiveControlIds)
    {
        if (!unique.has(id))
        {
            violations.push({ code: 'MISSING_POSITIVE_CONTROL', message: `required positive control missing: ${id}` })
        }
    }
    return violations
}

/**
 * Ensure claimType / prose render / generated renderer surfaces have mutation coverage.
 */
export function assertSurfaceMutationCoverage()
{
    const violations = []
    const caseIds = new Set(mutationCases.map((entry) => entry.id))

    for (const claimType of allowedClaimTypes)
    {
        const covering = surfaceCoverage.claimTypes[claimType]
        if (!covering || covering.length === 0)
        {
            violations.push({
                code: 'CLAIM_TYPE_COVERAGE_MISSING',
                message: `claimType ${claimType} lacks mutation coverage declaration`
            })
            continue
        }
        for (const id of covering)
        {
            if (!caseIds.has(id))
            {
                violations.push({
                    code: 'CLAIM_TYPE_COVERAGE_DANGLE',
                    message: `claimType ${claimType} coverage references missing case ${id}`
                })
            }
        }
    }

    for (const render of allowedProseRenders)
    {
        const covering = surfaceCoverage.proseRenders[render]
        if (!covering || covering.length === 0)
        {
            violations.push({
                code: 'PROSE_RENDER_COVERAGE_MISSING',
                message: `prose render ${render} lacks mutation coverage declaration`
            })
            continue
        }
        for (const id of covering)
        {
            if (!caseIds.has(id))
            {
                violations.push({
                    code: 'PROSE_RENDER_COVERAGE_DANGLE',
                    message: `prose render ${render} coverage references missing case ${id}`
                })
            }
        }
    }

    for (const renderer of allowedRenderers)
    {
        const covering = surfaceCoverage.generatedRenderers[renderer]
        if (!covering || covering.length === 0)
        {
            violations.push({
                code: 'GENERATED_RENDERER_COVERAGE_MISSING',
                message: `generated renderer ${renderer} lacks mutation coverage declaration`
            })
            continue
        }
        for (const id of covering)
        {
            if (!caseIds.has(id))
            {
                violations.push({
                    code: 'GENERATED_RENDERER_COVERAGE_DANGLE',
                    message: `generated renderer ${renderer} coverage references missing case ${id}`
                })
            }
        }
    }

    const coveredInvariants = new Set(mutationCases.map((entry) => entry.targetInvariantId))
    for (const invariantId of targetInvariants)
    {
        if (!coveredInvariants.has(invariantId))
        {
            violations.push({
                code: 'INVARIANT_COVERAGE_MISSING',
                message: `target invariant ${invariantId} has no mutation case`
            })
        }
    }

    return violations
}

/**
 * Case schema hygiene: exact layer + non-vague reasonCode; no multi-mutation markers.
 */
export function assertCaseSchemaHygiene(cases = mutationCases)
{
    const violations = []
    const layers = new Set(allowedMutationLayers)
    for (const entry of cases)
    {
        if (!entry.id || !entry.targetInvariantId || !entry.singleMutation || !entry.expectedReasonCode || !entry.expectedLayer)
        {
            violations.push({
                code: 'CASE_SCHEMA_INCOMPLETE',
                message: `case ${entry.id ?? '<unknown>'} missing required schema fields`
            })
        }
        if (!layers.has(entry.expectedLayer))
        {
            violations.push({
                code: 'CASE_LAYER_UNKNOWN',
                message: `case ${entry.id} expectedLayer ${entry.expectedLayer} is not admitted`
            })
        }
        if (forbiddenReasonCodes.includes(String(entry.expectedReasonCode).toLowerCase()))
        {
            violations.push({
                code: 'CASE_REASON_VAGUE',
                message: `case ${entry.id} expectedReasonCode is vague: ${entry.expectedReasonCode}`
            })
        }
        if (entry.singleMutation?.kind === 'multi' || Array.isArray(entry.singleMutation?.mutations))
        {
            violations.push({
                code: 'CASE_MULTI_MUTATION',
                message: `case ${entry.id} declares multi-mutation payload`
            })
        }
        if (entry.singleMutation?.kind === 'lifecycle-field' && entry.singleMutation?.alsoBreakLinks)
        {
            violations.push({
                code: 'CASE_BASELINE_WITH_LINK_BREAK',
                message: `case ${entry.id} baseline-only mutation also breaks links`
            })
        }
    }
    return violations
}

/**
 * Code search for weak multi-file fuzzy negatives / allowlists / flaky retry → must be 0.
 */
export function scanWeakNegativeSurfaces(repositoryRoot = root)
{
    const violations = []
    const suiteRoots = [
        path.join(repositoryRoot, 'tools/docs/doc-claim-staleness-mutation'),
        path.join(repositoryRoot, 'tests/tools/doc-claim-staleness-mutation.test.mjs')
    ]
    const files = []
    for (const target of suiteRoots)
    {
        if (!existsSync(target)) continue
        if (statSync(target).isDirectory()) walkFiles(target, files)
        else files.push(target)
    }

    for (const absolute of files)
    {
        const relative = relativeOf(repositoryRoot, absolute)
        // Governance file may name forbidden patterns only inside ban-list regexes.
        if (relative.endsWith('/governance.mjs')) continue
        const source = readFileSync(absolute, 'utf8')
        for (const pattern of weakPatterns)
        {
            if (pattern.id === 'vague-exit-only')
            {
                // Skip governance ban definition; apply to test/runner only.
                if (!relative.endsWith('.test.mjs') && !relative.endsWith('/runner.mjs')) continue
            }
            if (pattern.regex.test(source))
            {
                violations.push({
                    code: 'WEAK_NEGATIVE_SURFACE',
                    patternId: pattern.id,
                    path: relative,
                    message: pattern.message
                })
            }
        }
    }
    return violations
}

/**
 * One-shot migration proof: no checked-in multi-file fuzzy bad-doc fixture trees remain
 * under tests/fixtures for docs-governance.
 */
export function scanMigratedBadDocFixtures(repositoryRoot = root)
{
    const violations = []
    const candidates = [
        'tests/fixtures/docs-governance/bad',
        'tests/fixtures/docs-governance/fuzzy',
        'tests/fixtures/doc-claim/bad-multi',
        'tests/fixtures/prose-claim/weak-negatives',
        'tests/fixtures/generated-fact-sections/bad-docs'
    ]
    for (const relative of candidates)
    {
        const absolute = path.join(repositoryRoot, relative)
        if (existsSync(absolute))
        {
            violations.push({
                code: 'WEAK_BAD_DOC_FIXTURE_TREE',
                path: relative,
                message: 'weak multi-file bad-doc fixture tree must be deleted in favor of single-mutation cases'
            })
        }
    }
    return violations
}

export function runStalenessMutationGovernance(repositoryRoot = root)
{
    return [
        ...assertRequiredCaseCoverage(),
        ...assertSurfaceMutationCoverage(),
        ...assertCaseSchemaHygiene(),
        ...scanWeakNegativeSurfaces(repositoryRoot),
        ...scanMigratedBadDocFixtures(repositoryRoot)
    ]
}

export function formatGovernanceViolations(violations)
{
    return violations.map((entry) =>
        `${entry.code}${entry.path ? ` (${entry.path})` : ''}: ${entry.message}`)
}

export function countWeakNegativeHits(repositoryRoot = root)
{
    const hits = scanWeakNegativeSurfaces(repositoryRoot)
    return {
        total: hits.length,
        badDoc: hits.filter((entry) => entry.patternId === 'bad-doc-multifile-fixture').length,
        allowlist: hits.filter((entry) => entry.patternId === 'mutation-allowlist').length,
        flakyRetry: hits.filter((entry) => entry.patternId === 'flaky-retry').length
    }
}
