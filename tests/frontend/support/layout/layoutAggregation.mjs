import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from '@fsusblog/layout-governance/schema-validator';

import {
    compositionDigest,
    compositionLedgerPath,
    compositionMatrixPath,
    createCompositionIdentity,
    validateCompositionContracts,
    verifyCompositionIdentity
} from './compositionContracts.mjs';

const schemaUrl = new URL('../../../../config/schemas/layout-aggregation-request.schema.json', import.meta.url);
const schemaBytes = readFileSync(schemaUrl);
const schema = JSON.parse(schemaBytes.toString('utf8'));
const verifierBytes = readFileSync(fileURLToPath(import.meta.url));
export const layoutAggregationMutationIds = Object.freeze([...schema.$defs.mutationResult.properties.id.enum]);
export const layoutAggregationCounterNames = Object.freeze([...schema.$defs.successCounters.required]);
const receiptKinds = Object.freeze([...schema.$defs.receiptReference.properties.kind.enum]);

export function layoutReceiptArtifactDigest(bytes)
{
    if (!Buffer.isBuffer(bytes))
    {
        fail('artifact-invalid', 'canonical receipt bytes required');
    }
    return createHash('sha256').update(bytes).digest('hex');
}

function fail(code, message)
{
    const error = new Error(`[layout-aggregation] ${message}`);
    error.code = `layout-aggregate-${code}`;
    throw error;
}

function currentVerifier()
{
    if (!readFileSync(schemaUrl).equals(schemaBytes)
        || !readFileSync(fileURLToPath(import.meta.url)).equals(verifierBytes))
    {
        fail('version-drift', 'loaded aggregation schema/verifier differs from current bytes');
    }
    return { schemaDigest: compositionDigest(schemaBytes.toString('utf8')), verifierDigest: compositionDigest(verifierBytes.toString('utf8')) };
}

function referencedValues(inputs, reference)
{
    const document = reference.source === compositionMatrixPath ? inputs.matrix : inputs.fixtureDocuments[reference.source];
    const value = reference.pointer.split('/').slice(1).reduce((entry, part) =>
        entry?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], document);
    if (!Array.isArray(value) || !value.length)
    {
        fail('dimension-missing', `${reference.source}${reference.pointer} is not a populated dimension`);
    }
    return value;
}

/**
 * Derive declared coverage demands, not browser scenes. Symbolic desktop/mobile,
 * high-contrast and zoom-* values remain literal with their source references.
 * Only #2099 can admit their mapping to actual runtime scenes and fixtures.
 */
export function createLayoutAggregationPlan(inputs)
{
    const contractResult = validateCompositionContracts(inputs);
    const requirements = [];
    for (const entry of inputs.matrix.archetypes)
    {
        for (const state of entry.compositionContract.requiredStateFixtures)
        {
            for (const dimensions of entry.compositionContract.requiredViewportThemeMatrix)
            {
                for (const viewport of referencedValues(inputs, dimensions.viewportsRef))
                {
                    for (const theme of referencedValues(inputs, dimensions.themesRef))
                    {
                        for (const media of referencedValues(inputs, dimensions.mediaRef))
                        {
                            for (const mode of ['local', 'published'])
                            {
                                const requirement = {
                                    archetype: `${entry.surface}/${entry.kind}`, critical: entry.critical,
                                    routePattern: entry.path, stateId: state.id, stateDimensionId: state.dimensionId,
                                    stateValue: state.value, fixtureRef: state.fixtureRef,
                                    dimensions, viewport, theme, media, mode
                                };
                                requirements.push({ ...requirement, requirementDigest: compositionDigest(requirement) });
                            }
                        }
                    }
                }
            }
        }
    }
    if (new Set(requirements.map((entry) => entry.requirementDigest)).size !== requirements.length)
    {
        fail('duplicate-requirement', 'canonical dimension references produce duplicate coverage demands');
    }
    const plan = {
        schema: 'fsusblog.layout-aggregation-plan.v1', ...currentVerifier(),
        matrixRef: compositionMatrixPath, matrixDigest: compositionDigest(inputs.matrix),
        ledgerRef: compositionLedgerPath, ledgerDigest: compositionDigest(inputs.ledger),
        command: 'check:views-constraints', requirements, receiptKinds,
        mutationIds: layoutAggregationMutationIds,
        pendingCapabilities: contractResult.pendingCapabilities,
        pendingStateBindings: contractResult.pendingStateBindings,
        runtimeSceneAdmission: 'pending-canonical-producer', qualificationEligible: false
    };
    return { ...plan, planDigest: compositionDigest(plan) };
}

/** Exact cardinality only; receipt references and matching digests are not producer authority. */
export function inspectLayoutReceiptCoverage(plan, references)
{
    const referenceErrors = validateJsonSchema(references, { type: 'array', items: schema.$defs.receiptReference });
    if (referenceErrors.length)
    {
        fail('receipt-reference-invalid', referenceErrors.join('; '));
    }
    const required = new Map(plan.requirements.map((entry) => [entry.requirementDigest, entry]));
    const seen = new Set();
    for (const reference of references)
    {
        const key = `${reference.requirementDigest}/${reference.kind}`;
        if (!required.has(reference.requirementDigest) || !receiptKinds.includes(reference.kind))
        {
            fail('unregistered-receipt', key);
        }
        if (seen.has(key))
        {
            fail('receipt-cardinality', `duplicate ${key}`);
        }
        seen.add(key);
    }
    const missing = plan.requirements.flatMap((requirement) => receiptKinds
        .filter((kind) => !seen.has(`${requirement.requirementDigest}/${kind}`))
        .map((kind) => ({ requirementDigest: requirement.requirementDigest, archetype: requirement.archetype, kind })));
    return {
        status: 'reference-cardinality-only', qualificationEligible: false, missing,
        missingReferences: missing.length,
        archetypesWithMissingReferences: new Set(missing.map((entry) => entry.archetype)).size
    };
}

/** A diagnostic preflight, never a full/focused verification receipt. No caller adapters. */
export function inspectLayoutAggregation(request, context)
{
    const errors = validateJsonSchema(request, schema);
    if (errors.length)
    {
        fail('request-invalid', errors.join('; '));
    }
    const plan = createLayoutAggregationPlan(context.inputs);
    if (request.planDigest !== plan.planDigest)
    {
        fail('plan-drift', 'stale matrix, ledger, fixtures, schema or verifier');
    }
    for (const key of ['sourceCommit', 'worktreeFingerprint', 'runId', 'attemptId'])
    {
        if (!context.currentBinding?.[key] || request[key] !== context.currentBinding[key])
        {
            fail('binding-drift', `missing or stale ${key}`);
        }
    }
    const currentIdentities = {};
    for (const mode of ['local', 'published'])
    {
        const currentSource = context.currentSources?.[mode];
        if (!currentSource || currentSource.sourceCommit !== request.sourceCommit)
        {
            fail('mode-unavailable', `actual current ${mode} baseline/source required; no fallback`);
        }
        try
        {
            currentIdentities[mode] = createCompositionIdentity(context.inputs, currentSource);
            if (currentIdentities[mode].fsusUIMode !== mode)
            {
                fail('mode-unavailable', `${mode} baseline/source mode mismatch`);
            }
            verifyCompositionIdentity(request.compositionIdentities[mode], currentIdentities[mode]);
        }
        catch (error)
        {
            if (error.code === 'layout-aggregate-mode-unavailable')
            {
                throw error;
            }
            fail('identity-drift', error.message);
        }
    }
    for (const key of Object.keys(currentIdentities.local).filter((field) => !['fsusUIMode', 'fsusUIBaselineIdentityDigest', 'identityDigest'].includes(field)))
    {
        if (currentIdentities.local[key] !== currentIdentities.published[key])
        {
            fail('mode-parity-drift', `local/published ${key} differs`);
        }
    }
    const coverage = inspectLayoutReceiptCoverage(plan, request.receipts);
    const artifacts = context.artifacts ?? {};
    const usedArtifacts = new Set();
    for (const reference of request.receipts)
    {
        const bytes = artifacts[reference.contentDigest];
        if (!Buffer.isBuffer(bytes) || layoutReceiptArtifactDigest(bytes) !== reference.contentDigest)
        {
            fail('artifact-missing', `receipt bytes missing or tampered: ${reference.contentDigest}`);
        }
        usedArtifacts.add(reference.contentDigest);
    }
    if (Object.keys(artifacts).some((digest) => !usedArtifacts.has(digest)))
    {
        fail('artifact-cardinality', 'unconsumed artifact bytes');
    }
    const mutations = new Set();
    for (const result of request.mutationResults)
    {
        if (mutations.has(result.id))
        {
            fail('mutation-cardinality', `duplicate ${result.id}`);
        }
        mutations.add(result.id);
        if ((result.status === 'not-executed') !== (result.evidenceDigests.length === 0))
        {
            fail('mutation-evidence-missing', `${result.id}: observation status requires exact evidence`);
        }
    }
    const counters = Object.fromEntries(layoutAggregationCounterNames.map((name) => [name, null]));
    counters.invalidCompositionContracts = 0;
    return {
        schema: 'fsusblog.layout-aggregation-diagnostic.v1', status: 'not-executed',
        qualificationEligible: false, planDigest: plan.planDigest,
        binding: context.currentBinding, lane: request.lane,
        counters, referenceCoverage: coverage,
        missingMutationResults: layoutAggregationMutationIds.filter((id) => !mutations.has(id)),
        // Even claimed kills need canonical producer verification; never count them as qualified.
        unverifiedMutationResults: request.mutationResults.map(({ id, status }) => ({ id, status })),
        missingProducerCapabilities: [2098, 2099, 2100, 2101],
        pendingStateBindings: plan.pendingStateBindings,
        pendingCapabilities: plan.pendingCapabilities
    };
}

/** Reserved canonical full gate. Remains fail closed until real producer handoffs exist. */
export function requireFullLayoutAggregate(request, context)
{
    const diagnostic = inspectLayoutAggregation(request, context);
    if (request.lane !== 'full' || request.execution !== 'completed')
    {
        fail('lane-downgrade', 'focused/static-only/not-executed cannot qualify full acceptance');
    }
    if (diagnostic.referenceCoverage.missing.length || diagnostic.missingMutationResults.length)
    {
        fail('coverage-incomplete', 'full canonical coverage and mutation observations required');
    }
    fail('producer-adapter-unavailable', 'canonical scene admission/static/DOM/geometry/visual/mutation verifiers are unavailable; no full receipt issued');
}
