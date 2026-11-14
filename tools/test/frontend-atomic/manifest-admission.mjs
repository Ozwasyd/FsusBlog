import { URL } from 'node:url';

import { projectFrontendManifestGroup } from './manifest-projection.mjs';

const { verifyCompiledAtomicProducerDag } = await import(new URL('../../test-matrix/atomic-producers/compiler.mjs', import.meta.url));
const { isAtomicExecutable, resolveAtomicReplayPlan } = await import(new URL('../../test-matrix/atomic-producers/contract.mjs', import.meta.url));
const { executeCompiledAtomicProducerDag } = await import(new URL('../../test-matrix/atomic-producers/execution.mjs', import.meta.url));
const { digestCanonical, validateExternalAuthorityReferences } = await import(new URL('../attempt-provenance.mjs', import.meta.url));

function requireSame(actual, expected, label)
{
    if (digestCanonical(actual) !== digestCanonical(expected))
    {
        throw new Error(`frontend atomic ${label} differs from canonical manifest`);
    }
}

/**
 * Bind a matrix-owner compiled group to its actual manifest before any attempt.
 * Authorities, test IDs, replay seeds and fixture proofs come from their existing
 * owners. This consumer creates no declarations, resources, replay or receipts.
 * A missing per-entry contract cannot be filled from group order or group grants.
 */
export function prepareFrontendManifestAdmission(compiled, options)
{
    const { matrix, authorities, groupId, context, producerContexts } = options;
    const verified = verifyCompiledAtomicProducerDag(compiled, matrix, authorities);
    const projection = projectFrontendManifestGroup(matrix, groupId);
    const children = verified.steps.filter(isAtomicExecutable);
    if (verified.steps.some((step) => step.logicalParentId !== groupId))
    {
        throw new Error('frontend atomic group cannot dispatch another logical parent');
    }
    requireSame(children.map((step) => step.id).sort(),
        projection.entries.map((entry) => entry.id).sort(), 'entry roster');
    for (const entry of projection.entries)
    {
        const step = children.find((candidate) => candidate.id === entry.id);
        const declaration = entry.manifestEntry;
        if ((declaration.localCommands?.length ?? 0) > 0)
        {
            throw new Error(`${entry.id} requires composite-entry disposition before atomic admission`);
        }
        if (declaration.applicability !== undefined)
        {
            throw new Error(`${entry.id} requires compiler-owned applicability admission`);
        }
        if (!declaration.resources || !Array.isArray(declaration.consumedInputs)
            || declaration.consumedInputs.length === 0)
        {
            throw new Error(`${entry.id} requires explicit entry resource and input declarations`);
        }
        requireSame(step.command, entry.command, `${entry.id} command`);
        requireSame([...step.dependsOn].sort(), [...entry.dependsOn].sort(), `${entry.id} hard dependencies`);
        requireSame([...step.settledDependsOn].sort(), [...entry.settledDependsOn].sort(), `${entry.id} settled dependencies`);
        for (const [field, value] of Object.entries(declaration.resources))
        {
            if (!Object.hasOwn(step.resources, field))
            {
                throw new Error(`${entry.id} compiled resource contract omits ${field}`);
            }
            requireSame(step.resources[field], value, `${entry.id} resources.${field}`);
        }
        const supplied = producerContexts?.[step.id];
        if (!supplied || !context)
        {
            throw new Error(`${entry.id} requires an externally held current-run producer context`);
        }
        const references = validateExternalAuthorityReferences(supplied.authorityReferences, supplied.verifyAuthority, {
            sourceCommit: context.sourceCommit,
            worktreeFingerprint: context.worktreeFingerprint,
            schedulerRunId: context.schedulerRunId,
            producerId: step.id
        });
        const replay = resolveAtomicReplayPlan(authorities.replayPlans, step.replayPlanRef);
        const reference = references.find((candidate) => candidate.kind === 'replay-plan');
        if (reference.artifactPath !== replay.artifactPath || reference.artifactDigest !== step.replayPlanRef.contentDigest)
        {
            throw new Error(`${entry.id} replay authority differs from its compiled source`);
        }
        if (replay.plan.source.commit !== context.sourceCommit
            || replay.plan.source.worktreeFingerprint !== context.worktreeFingerprint
            || replay.plan.run.id !== context.schedulerRunId
            || replay.plan.command.environmentDigest !== digestCanonical(supplied.env))
        {
            throw new Error(`${entry.id} replay source/run/environment differs from its current producer context`);
        }
        for (const [name, value] of Object.entries(declaration.environment ?? {}))
        {
            if (supplied.env[name] !== value)
            {
                throw new Error(`${entry.id} context omits canonical command environment: ${name}`);
            }
        }
    }
    return Object.freeze({
        groupId,
        sourceDigest: projection.sourceDigest,
        compiledDagDigest: verified.contentDigest,
        entryIds: Object.freeze(children.map((step) => step.id)),
        qualificationEligible: false
    });
}

/** Dispatch once through the canonical DAG/attempt owner; preserve its full vector and errors. */
export async function executeFrontendManifestAtomicGroup(compiled, options)
{
    prepareFrontendManifestAdmission(compiled, options);
    return executeCompiledAtomicProducerDag(compiled, options);
}
