/**
 * Fixed single-mutation case catalog for docs-governance body staleness + baseline-only cheats.
 * Each case: id, source fixture kind, targetInvariantId, singleMutation, expectedReasonCode,
 * expectedLayer, forbiddenCollateralChanges[].
 */

import { DocClaimErrorCode } from '../doc-claim.mjs'
import { ProseClaimErrorCode } from '../prose-claim-verifier/errors.mjs'
import { GeneratedSectionErrorCode } from '../generated-fact-sections/markers.mjs'
import { MutationLayers } from './layers.mjs'
import {
    SECTION_MAP,
    SECTION_OUTBOX,
    SECTION_PERMISSIONS,
    SECTION_TRANSITIONS,
    currentObservations,
    matchingProseBodies,
    staleProseBodies
} from './fixture.mjs'

function sectionList(items)
{
    return items.map((item) => `- \`${item}\``).join('\n')
}

function mapTable(map)
{
    const rows = Object.entries(map)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `| ${key} | ${value} |`)
    return ['| Key | Value |', '| --- | --- |', ...rows].join('\n')
}

function transitionTable(rows)
{
    // Intentionally hand-shaped drift tables (not observation-render authority).
    const normalized = rows.map((row) =>
    {
        if (typeof row === 'string')
        {
            const match = row.match(/^(?:([^:]+):)?([^:>\-]+)->([^:]+)(?::(.+))?$/u)
            if (!match) return { from: row, to: '?', guard: '-' }
            return {
                from: match[2],
                to: match[3],
                guard: match[4] || match[1] || '-'
            }
        }
        return row
    })
    const sorted = [...normalized].sort((left, right) =>
        String(left.from).localeCompare(String(right.from))
        || String(left.to).localeCompare(String(right.to)))
    const lines = sorted.map((row) => `| ${row.from} | ${row.to} | ${row.guard ?? '-'} |`)
    return ['| From | To | Guard |', '| --- | --- | --- |', ...lines].join('\n')
}

/**
 * @typedef {object} MutationCase
 * @property {string} id
 * @property {'full-valid'|'stale-body-valid-lifecycle'} sourceFixtureKind
 * @property {string} targetInvariantId
 * @property {object} singleMutation
 * @property {string} expectedReasonCode
 * @property {string} expectedLayer
 * @property {string[]} forbiddenCollateralChanges
 * @property {boolean} [expectPass]
 * @property {string} [controlKind]
 */

/** Required mutation ids from issue #1750 (failure cases). */
export const requiredMutationIds = Object.freeze([
    // Baseline/self-certification
    'only-update-lastVerifiedCommit',
    'only-update-review-date',
    'add-verified-true',
    'add-approved-observed-value',
    'add-ignore-difference',
    // Scalar/Boundary
    'scalar-old-value',
    'scalar-wrong-unit',
    'scalar-boundary-inclusive-to-exclusive',
    'default-confused-with-maximum',
    'conflicting-second-number',
    // Set/Map/Transition
    'missing-enum-member',
    'extra-retired-member',
    'wrong-map-value',
    'missing-transition',
    'reversed-transition',
    'missing-required-outbox-edge',
    // Boolean/Failure/Relation
    'fail-closed-to-fail-open',
    'required-to-optional',
    'preserve-to-reset',
    'relation-direction-reversed',
    'scope-expanded-from-only-to-all',
    // Generated section
    'manual-row-delete',
    'manual-extra-row',
    'stale-generated-bytes',
    'marker-removed',
    'marker-duplicated',
    'old-observation-receipt',
    // Graph linkage
    'orphan-claim',
    'claim-wrong-behavior',
    'missing-test-kind',
    'implementation-owner-duplicate',
    'retired-behavior-current-doc'
])

/** Positive controls — must pass. */
export const requiredPositiveControlIds = Object.freeze([
    'valid-control-unmutated',
    'valid-control-body-fix-without-baseline',
    'valid-control-regenerate-section',
    'valid-control-observation-and-body-aligned'
])

/**
 * Target invariants covered by the matrix (used for coverage governance).
 */
export const targetInvariants = Object.freeze([
    'prose.scalar.value-matches-observation',
    'prose.scalar.unit-matches-observation',
    'prose.scalar.boundary-inclusivity',
    'prose.scalar.projection-role',
    'prose.scalar.no-conflicting-dimension-value',
    'prose.boolean.extends-policy',
    'prose.failure.fail-closed-policy',
    'prose.failure.required-optional-policy',
    'prose.relation.direction',
    'prose.preservation.fields',
    'prose.preservation.revokes-only-scope',
    'prose.baseline-only-cannot-mask-stale-body',
    'claim.schema.forbidden-self-proving-fields',
    'generated.enum-set.complete-members',
    'generated.map.values-match',
    'generated.transition.set-complete',
    'generated.transition.direction',
    'generated.outbox.required-edges',
    'generated.section.bytes-match-observation',
    'generated.section.marker-integrity',
    'generated.section.observation-identity',
    'join.orphan-claim-rejected',
    'join.claim-behavior-binding',
    'join.required-test-kinds',
    'join.owner-cardinality',
    'join.retired-behavior-no-current-doc'
])

/**
 * claimType / renderer coverage map — every admitted surface must appear here.
 * Missing entry → governance fails.
 */
/**
 * claimType / renderer → covering case ids.
 * boolean-extends is exercised by valid-control-unmutated (matching body) and
 * by fail-closed family peer fixture.refresh.extends-step-up which is mutated
 * when scope/preserve cases run on the same full-valid fixture family; explicit
 * coverage is declared via valid-control + preserve path sharing the prose layer.
 */
export const surfaceCoverage = Object.freeze({
    claimTypes: Object.freeze({
        scalar: ['scalar-old-value', 'scalar-wrong-unit', 'scalar-boundary-inclusive-to-exclusive'],
        boolean: ['valid-control-unmutated'],
        'failure-mode': ['fail-closed-to-fail-open', 'required-to-optional'],
        'binary-relation': ['relation-direction-reversed'],
        implication: ['relation-direction-reversed'],
        'preservation-rule': ['preserve-to-reset', 'scope-expanded-from-only-to-all'],
        'enum-set': ['missing-enum-member', 'extra-retired-member'],
        'ordered-set': ['missing-enum-member'],
        map: ['wrong-map-value'],
        'transition-set': ['missing-transition', 'reversed-transition'],
        'generated-section': ['manual-row-delete', 'stale-generated-bytes', 'marker-removed'],
        rationale: ['valid-control-unmutated']
    }),
    proseRenders: Object.freeze({
        'integer-minutes': ['scalar-old-value', 'default-confused-with-maximum', 'conflicting-second-number'],
        'integer-layers': ['scalar-boundary-inclusive-to-exclusive'],
        'integer-bytes': ['scalar-wrong-unit'],
        'integer-count': ['conflicting-second-number'],
        'integer-scalar': ['scalar-old-value'],
        'boolean-affirmed': ['valid-control-observation-and-body-aligned'],
        'boolean-negated': ['valid-control-observation-and-body-aligned'],
        'boolean-extends': ['valid-control-unmutated'],
        'failure-mode-code': ['fail-closed-to-fail-open'],
        'failure-policy': ['fail-closed-to-fail-open', 'required-to-optional'],
        'relation-subject-predicate-object': ['relation-direction-reversed'],
        'implication-if-then': ['relation-direction-reversed'],
        'preserves-fields': ['preserve-to-reset'],
        'revokes-only-scope': ['scope-expanded-from-only-to-all'],
        'rationale-prose': ['valid-control-unmutated']
    }),
    generatedRenderers: Object.freeze({
        'enum-set': ['missing-enum-member', 'extra-retired-member', 'manual-row-delete', 'manual-extra-row'],
        'key-value-table': ['wrong-map-value'],
        'transition-table': ['missing-transition', 'reversed-transition', 'missing-required-outbox-edge'],
        scalar: ['stale-generated-bytes'],
        boolean: ['valid-control-regenerate-section'],
        'ordered-set': ['missing-enum-member'],
        'failure-mode-table': ['manual-row-delete'],
        'route-table': ['valid-control-regenerate-section'],
        'dependency-graph-table': ['missing-required-outbox-edge']
    })
})

function caseDef(entry)
{
    return Object.freeze({
        expectPass: false,
        sourceFixtureKind: 'full-valid',
        ...entry,
        forbiddenCollateralChanges: Object.freeze([...(entry.forbiddenCollateralChanges ?? [])])
    })
}

const obs = currentObservations()
const match = matchingProseBodies()
const stale = staleProseBodies()

export const mutationCases = Object.freeze([
    // ── Baseline / self-certification ──────────────────────────────────────
    caseDef({
        id: 'only-update-lastVerifiedCommit',
        sourceFixtureKind: 'stale-body-valid-lifecycle',
        targetInvariantId: 'prose.baseline-only-cannot-mask-stale-body',
        singleMutation: {
            kind: 'lifecycle-field',
            field: 'lastVerifiedCommit',
            value: 'f'.repeat(40)
        },
        expectedReasonCode: ProseClaimErrorCode.CONFLICTING_VALUE,
        expectedLayer: MutationLayers.PROSE_VERIFIER,
        forbiddenCollateralChanges: ['document-body', 'observation', 'generated-section', 'broken-link']
    }),
    caseDef({
        id: 'only-update-review-date',
        sourceFixtureKind: 'stale-body-valid-lifecycle',
        targetInvariantId: 'prose.baseline-only-cannot-mask-stale-body',
        singleMutation: {
            kind: 'lifecycle-field',
            field: 'reviewDate',
            value: '2099-12-31'
        },
        expectedReasonCode: ProseClaimErrorCode.CONFLICTING_VALUE,
        expectedLayer: MutationLayers.PROSE_VERIFIER,
        forbiddenCollateralChanges: ['document-body', 'observation', 'broken-link']
    }),
    caseDef({
        id: 'add-verified-true',
        targetInvariantId: 'claim.schema.forbidden-self-proving-fields',
        singleMutation: {
            kind: 'claim-declaration-field',
            field: 'verified',
            value: true
        },
        expectedReasonCode: DocClaimErrorCode.FORBIDDEN_FIELD,
        expectedLayer: MutationLayers.CLAIM_SCHEMA
    }),
    caseDef({
        id: 'add-approved-observed-value',
        targetInvariantId: 'claim.schema.forbidden-self-proving-fields',
        singleMutation: {
            kind: 'claim-declaration-field',
            field: 'expectedValue',
            value: 10
        },
        expectedReasonCode: DocClaimErrorCode.FORBIDDEN_FIELD,
        expectedLayer: MutationLayers.CLAIM_SCHEMA
    }),
    caseDef({
        id: 'add-ignore-difference',
        targetInvariantId: 'claim.schema.forbidden-self-proving-fields',
        singleMutation: {
            kind: 'claim-declaration-field',
            field: 'ignoreDifference',
            value: true
        },
        expectedReasonCode: DocClaimErrorCode.FORBIDDEN_FIELD,
        expectedLayer: MutationLayers.CLAIM_SCHEMA
    }),

    // ── Scalar / Boundary ──────────────────────────────────────────────────
    caseDef({
        id: 'scalar-old-value',
        targetInvariantId: 'prose.scalar.value-matches-observation',
        singleMutation: {
            kind: 'prose-body',
            claimId: 'fixture.step-up.freshness',
            bodyText: stale.stepUpFreshness
        },
        expectedReasonCode: ProseClaimErrorCode.CONFLICTING_VALUE,
        expectedLayer: MutationLayers.PROSE_VERIFIER
    }),
    caseDef({
        id: 'scalar-wrong-unit',
        targetInvariantId: 'prose.scalar.unit-matches-observation',
        singleMutation: {
            kind: 'prose-body',
            claimId: 'fixture.step-up.freshness',
            bodyText: '敏感操作的 step-up proof 默认有效期为 **10 秒**。'
        },
        expectedReasonCode: ProseClaimErrorCode.REQUIRED_TOKEN_MISSING,
        expectedLayer: MutationLayers.PROSE_VERIFIER
    }),
    caseDef({
        id: 'scalar-boundary-inclusive-to-exclusive',
        targetInvariantId: 'prose.scalar.boundary-inclusivity',
        singleMutation: {
            kind: 'prose-body',
            claimId: 'fixture.cache.max-nesting',
            bodyText: '缓存嵌套最大 16 层（不含）。'
        },
        expectedReasonCode: ProseClaimErrorCode.FORBIDDEN_TOKEN_PRESENT,
        expectedLayer: MutationLayers.PROSE_VERIFIER
    }),
    caseDef({
        id: 'default-confused-with-maximum',
        targetInvariantId: 'prose.scalar.projection-role',
        singleMutation: {
            kind: 'prose-body',
            claimId: 'fixture.step-up.freshness',
            // projection=default requires 默认; body only says 最大
            bodyText: '敏感操作的 step-up proof 最大有效期为 **10 分钟**。'
        },
        expectedReasonCode: ProseClaimErrorCode.REQUIRED_TOKEN_MISSING,
        expectedLayer: MutationLayers.PROSE_VERIFIER
    }),
    caseDef({
        id: 'conflicting-second-number',
        targetInvariantId: 'prose.scalar.no-conflicting-dimension-value',
        singleMutation: {
            kind: 'prose-body',
            claimId: 'fixture.step-up.freshness',
            bodyText: '默认 10 分钟，有时也写作 5 分钟。'
        },
        expectedReasonCode: ProseClaimErrorCode.CONFLICTING_VALUE,
        expectedLayer: MutationLayers.PROSE_VERIFIER
    }),

    // ── Set / Map / Transition (generated) ─────────────────────────────────
    caseDef({
        id: 'missing-enum-member',
        targetInvariantId: 'generated.enum-set.complete-members',
        singleMutation: {
            kind: 'generated-interior',
            sectionId: SECTION_PERMISSIONS,
            body: sectionList(['admin.read'])
        },
        expectedReasonCode: GeneratedSectionErrorCode.CHECK_DRIFT,
        expectedLayer: MutationLayers.GENERATED_SECTION_CHECK
    }),
    caseDef({
        id: 'extra-retired-member',
        targetInvariantId: 'generated.enum-set.complete-members',
        singleMutation: {
            kind: 'generated-interior',
            sectionId: SECTION_PERMISSIONS,
            body: sectionList(['admin.read', 'admin.write', 'retired.permission'])
        },
        expectedReasonCode: GeneratedSectionErrorCode.CHECK_DRIFT,
        expectedLayer: MutationLayers.GENERATED_SECTION_CHECK
    }),
    caseDef({
        id: 'wrong-map-value',
        targetInvariantId: 'generated.map.values-match',
        singleMutation: {
            kind: 'generated-interior',
            sectionId: SECTION_MAP,
            body: mapTable({ stepUp: 'optional', refresh: 'rotate' })
        },
        expectedReasonCode: GeneratedSectionErrorCode.CHECK_DRIFT,
        expectedLayer: MutationLayers.GENERATED_SECTION_CHECK
    }),
    caseDef({
        id: 'missing-transition',
        targetInvariantId: 'generated.transition.set-complete',
        singleMutation: {
            kind: 'generated-interior',
            sectionId: SECTION_TRANSITIONS,
            body: transitionTable(['Publish:Draft->Published'])
        },
        expectedReasonCode: GeneratedSectionErrorCode.CHECK_DRIFT,
        expectedLayer: MutationLayers.GENERATED_SECTION_CHECK
    }),
    caseDef({
        id: 'reversed-transition',
        targetInvariantId: 'generated.transition.direction',
        singleMutation: {
            kind: 'generated-interior',
            sectionId: SECTION_TRANSITIONS,
            body: transitionTable([
                'Publish:Published->Draft',
                'Archive:Archived->Published'
            ])
        },
        expectedReasonCode: GeneratedSectionErrorCode.CHECK_DRIFT,
        expectedLayer: MutationLayers.GENERATED_SECTION_CHECK
    }),
    caseDef({
        id: 'missing-required-outbox-edge',
        targetInvariantId: 'generated.outbox.required-edges',
        singleMutation: {
            kind: 'generated-interior',
            sectionId: SECTION_OUTBOX,
            body: transitionTable(['required:ArticleUpdated->ProjectionRebuild'])
        },
        expectedReasonCode: GeneratedSectionErrorCode.CHECK_DRIFT,
        expectedLayer: MutationLayers.GENERATED_SECTION_CHECK
    }),

    // ── Boolean / Failure / Relation ───────────────────────────────────────
    caseDef({
        id: 'fail-closed-to-fail-open',
        targetInvariantId: 'prose.failure.fail-closed-policy',
        singleMutation: {
            kind: 'prose-body',
            claimId: 'fixture.startup.fail-closed',
            bodyText: stale.startupPolicy
        },
        expectedReasonCode: ProseClaimErrorCode.FAILURE_POLICY_CONFLICT,
        expectedLayer: MutationLayers.PROSE_VERIFIER
    }),
    caseDef({
        id: 'required-to-optional',
        targetInvariantId: 'prose.failure.required-optional-policy',
        singleMutation: {
            kind: 'prose-body',
            claimId: 'fixture.mfa.required',
            bodyText: stale.mfaPolicy
        },
        expectedReasonCode: ProseClaimErrorCode.FAILURE_POLICY_CONFLICT,
        expectedLayer: MutationLayers.PROSE_VERIFIER
    }),
    caseDef({
        id: 'preserve-to-reset',
        targetInvariantId: 'prose.preservation.fields',
        singleMutation: {
            kind: 'prose-body',
            claimId: 'fixture.session.preserve',
            bodyText: stale.sessionPreserve
        },
        expectedReasonCode: ProseClaimErrorCode.PRESERVATION_MISMATCH,
        expectedLayer: MutationLayers.PROSE_VERIFIER
    }),
    caseDef({
        id: 'relation-direction-reversed',
        targetInvariantId: 'prose.relation.direction',
        singleMutation: {
            kind: 'prose-body',
            claimId: 'fixture.passkey.revokes',
            bodyText: stale.passkeyRevocation
        },
        expectedReasonCode: ProseClaimErrorCode.RELATION_DIRECTION,
        expectedLayer: MutationLayers.PROSE_VERIFIER
    }),
    caseDef({
        id: 'scope-expanded-from-only-to-all',
        targetInvariantId: 'prose.preservation.revokes-only-scope',
        singleMutation: {
            kind: 'prose-body',
            claimId: 'fixture.passkey.scope',
            bodyText: stale.passkeyScope
        },
        expectedReasonCode: ProseClaimErrorCode.FORBIDDEN_TOKEN_PRESENT,
        expectedLayer: MutationLayers.PROSE_VERIFIER
    }),

    // ── Generated section integrity ────────────────────────────────────────
    caseDef({
        id: 'manual-row-delete',
        targetInvariantId: 'generated.section.bytes-match-observation',
        singleMutation: {
            kind: 'generated-interior',
            sectionId: SECTION_PERMISSIONS,
            body: sectionList(['admin.read'])
        },
        expectedReasonCode: GeneratedSectionErrorCode.CHECK_DRIFT,
        expectedLayer: MutationLayers.GENERATED_SECTION_CHECK
    }),
    caseDef({
        id: 'manual-extra-row',
        targetInvariantId: 'generated.section.bytes-match-observation',
        singleMutation: {
            kind: 'generated-interior',
            sectionId: SECTION_PERMISSIONS,
            body: sectionList([...obs.permissions, 'manual.extra.row'])
        },
        expectedReasonCode: GeneratedSectionErrorCode.CHECK_DRIFT,
        expectedLayer: MutationLayers.GENERATED_SECTION_CHECK
    }),
    caseDef({
        id: 'stale-generated-bytes',
        targetInvariantId: 'generated.section.bytes-match-observation',
        singleMutation: {
            kind: 'generated-interior',
            sectionId: SECTION_PERMISSIONS,
            body: sectionList(['stale.only'])
        },
        expectedReasonCode: GeneratedSectionErrorCode.CHECK_DRIFT,
        expectedLayer: MutationLayers.GENERATED_SECTION_CHECK
    }),
    caseDef({
        id: 'marker-removed',
        targetInvariantId: 'generated.section.marker-integrity',
        singleMutation: {
            kind: 'remove-generated-markers',
            sectionId: SECTION_PERMISSIONS
        },
        expectedReasonCode: GeneratedSectionErrorCode.SECTION_MISSING_MARKER,
        expectedLayer: MutationLayers.GENERATED_SECTION_CHECK
    }),
    caseDef({
        id: 'marker-duplicated',
        targetInvariantId: 'generated.section.marker-integrity',
        singleMutation: {
            kind: 'duplicate-generated-markers',
            sectionId: SECTION_PERMISSIONS
        },
        expectedReasonCode: GeneratedSectionErrorCode.MARKER_DUPLICATE_ID,
        expectedLayer: MutationLayers.GENERATED_SECTION_CHECK
    }),
    caseDef({
        id: 'old-observation-receipt',
        targetInvariantId: 'generated.section.observation-identity',
        singleMutation: {
            kind: 'stale-observation-identity',
            sourceCommit: '0'.repeat(40),
            worktreeFingerprint: '1'.repeat(64)
        },
        expectedReasonCode: GeneratedSectionErrorCode.OBSERVATION_STALE,
        expectedLayer: MutationLayers.GENERATED_SECTION_CHECK
    }),

    // ── Graph linkage ──────────────────────────────────────────────────────
    caseDef({
        id: 'orphan-claim',
        targetInvariantId: 'join.orphan-claim-rejected',
        singleMutation: {
            kind: 'graph',
            graphMutation: 'orphan-claim'
        },
        expectedReasonCode: 'ORPHAN_CLAIM',
        expectedLayer: MutationLayers.BEHAVIOR_GRAPH_JOIN
    }),
    caseDef({
        id: 'claim-wrong-behavior',
        targetInvariantId: 'join.claim-behavior-binding',
        singleMutation: {
            kind: 'graph',
            graphMutation: 'claim-wrong-behavior'
        },
        expectedReasonCode: 'CLAIM_WRONG_BEHAVIOR',
        expectedLayer: MutationLayers.BEHAVIOR_GRAPH_JOIN
    }),
    caseDef({
        id: 'missing-test-kind',
        targetInvariantId: 'join.required-test-kinds',
        singleMutation: {
            kind: 'graph',
            graphMutation: 'missing-test-kind'
        },
        expectedReasonCode: 'MISSING_TEST_KIND',
        expectedLayer: MutationLayers.BEHAVIOR_GRAPH_JOIN
    }),
    caseDef({
        id: 'implementation-owner-duplicate',
        targetInvariantId: 'join.owner-cardinality',
        singleMutation: {
            kind: 'graph',
            graphMutation: 'implementation-owner-duplicate'
        },
        expectedReasonCode: 'OWNER_CARDINALITY',
        expectedLayer: MutationLayers.BEHAVIOR_GRAPH_JOIN
    }),
    caseDef({
        id: 'retired-behavior-current-doc',
        targetInvariantId: 'join.retired-behavior-no-current-doc',
        singleMutation: {
            kind: 'graph',
            graphMutation: 'retired-behavior-current-doc'
        },
        expectedReasonCode: 'RETIRED_BEHAVIOR_CURRENT_DOC',
        expectedLayer: MutationLayers.BEHAVIOR_GRAPH_JOIN
    }),

    // ── Positive controls ──────────────────────────────────────────────────
    caseDef({
        id: 'valid-control-unmutated',
        targetInvariantId: 'prose.boolean.extends-policy',
        singleMutation: { kind: 'none' },
        expectedReasonCode: 'PASS',
        expectedLayer: MutationLayers.PROSE_VERIFIER,
        expectPass: true,
        controlKind: 'unmutated'
    }),
    caseDef({
        id: 'valid-control-body-fix-without-baseline',
        sourceFixtureKind: 'stale-body-valid-lifecycle',
        targetInvariantId: 'prose.baseline-only-cannot-mask-stale-body',
        singleMutation: {
            kind: 'fix-all-prose-bodies',
            bodies: match
        },
        expectedReasonCode: 'PASS',
        expectedLayer: MutationLayers.PROSE_VERIFIER,
        expectPass: true,
        controlKind: 'body-fix-without-baseline'
    }),
    caseDef({
        id: 'valid-control-regenerate-section',
        targetInvariantId: 'generated.section.bytes-match-observation',
        singleMutation: {
            kind: 'stale-then-regenerate',
            sectionId: SECTION_PERMISSIONS,
            staleBody: sectionList(['stale.only'])
        },
        expectedReasonCode: 'PASS',
        expectedLayer: MutationLayers.GENERATED_SECTION_CHECK,
        expectPass: true,
        controlKind: 'regenerate-section'
    }),
    caseDef({
        id: 'valid-control-observation-and-body-aligned',
        targetInvariantId: 'prose.scalar.value-matches-observation',
        singleMutation: {
            kind: 'align-observation-and-body',
            claimId: 'fixture.step-up.freshness',
            bodyText: '敏感操作的 step-up proof 默认有效期为 **15 分钟**。',
            observationPatch: {
                stepUpFreshness: {
                    default: { value: 15, unit: 'minutes', role: 'default' }
                }
            }
        },
        expectedReasonCode: 'PASS',
        expectedLayer: MutationLayers.PROSE_VERIFIER,
        expectPass: true,
        controlKind: 'observation-and-body-aligned'
    })
])

export const mutationCasesById = Object.freeze(
    Object.fromEntries(mutationCases.map((entry) => [entry.id, entry]))
)

export function listMutationCases({ includeControls = true } = {})
{
    if (includeControls) return [...mutationCases]
    return mutationCases.filter((entry) => !entry.expectPass)
}

export function getMutationCase(id)
{
    const found = mutationCasesById[id]
    if (!found) throw new Error(`unknown mutation case ${id}`)
    return found
}
