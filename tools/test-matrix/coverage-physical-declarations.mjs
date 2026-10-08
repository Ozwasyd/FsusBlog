import { isDeepStrictEqual } from 'node:util';

import { compilePhysicalProducerFilesystemPlan } from './physical-producer-filesystem.mjs';

const { compileCoverageProducerDag } = await import(new URL('../coverage/atomic-coverage-compiler-bridge.mjs', import.meta.url));
const { digestCanonical, sealContentDigest } = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));
const { resolveAtomicReplayPlan } = await import(new URL('./atomic-producers/contract.mjs', import.meta.url));

export const coveragePhysicalAccessDeclarationSchema = 'fsusblog.coverage-physical-access-declaration.v1';

function equal(actual, expected, label)
{
    if (!isDeepStrictEqual(actual, expected))
    {
        throw new Error(`coverage physical declaration ${label} mismatch`);
    }
}

function exactKeys(value, keys, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error(`coverage physical declaration requires ${label}`);
    }
    equal(Object.keys(value).sort(), [...keys].sort(), `${label} fields`);
}

/**
 * Project the actual coverage compiler attachment, not a second producer list.
 * Terminal schemas name the original atomic execution DATA_ONLY evidence; they
 * do not mint a receipt, supply an attempt ID or replace correctness sealing.
 * This subchain fragment must join the canonical all-producer catalog before
 * GC/local/CI/resume planning can claim complete physical ownership.
 */
export function compileCoveragePhysicalTerminalDeclarations(coverageInput)
{
    const compiled = compileCoverageProducerDag(coverageInput);
    const { plan } = coverageInput;
    const requestedIds = [...plan.producers, ...plan.projections].map((item) => item.id).sort();
    const members = compiled.steps.filter((step) => requestedIds.includes(step.id));
    equal(members.map((step) => step.id).sort(), requestedIds, 'coverage member roster');
    const physicalOwners = members.map((step) => ({
        producerId: step.id,
        ownerKind: step.kind === 'atomic-producer' ? 'executable' : 'projection',
        spawnEligibility: step.kind === 'atomic-producer'
    }));
    const terminalDeclarations = members.map((step) =>
    {
        const producer = plan.producers.find((item) => item.id === step.id);
        const common = {
            producerId: step.id,
            kind: step.kind,
            logicalParentId: step.logicalParentId,
            owner: step.owner,
            projectionOwner: step.projectionOwner,
            dependsOn: [...step.dependsOn],
            settledDependsOn: [...step.settledDependsOn],
            spawnEligibility: producer !== undefined,
            receiptSchema: 'fsusblog.atomic-producer-terminal-receipt.v1',
            vectorSchema: 'fsusblog.atomic-producer-terminal-vector.v1',
            requiresCurrentAttempt: producer !== undefined,
            qualificationEligible: false
        };
        if (!producer)
        {
            return common;
        }
        const replay = resolveAtomicReplayPlan(coverageInput.authorities.replayPlans, step.replayPlanRef).plan;
        equal({ runId: replay.run.id, sourceCommit: replay.source.commit,
            sourceFingerprint: replay.source.worktreeFingerprint }, plan.identity, 'compiled replay run/source');
        return {
            ...common,
            commandSourceRef: structuredClone(step.commandSourceRef),
            inputClosureRef: structuredClone(step.inputClosureRef),
            replayPlanRef: structuredClone(step.replayPlanRef),
            resourceContractRef: structuredClone(step.resourceContractRef),
            fixtureProfile: structuredClone(step.fixtureProfile),
            stateAccessRef: structuredClone(step.stateAccessRef),
            serviceDependencies: [...step.serviceDependencies],
            attemptPolicyId: step.attemptPolicyId,
            artifactIds: [...step.artifacts],
            evidenceIds: [...step.evidence],
            outputBindings: producer.outputs.map((output) => ({
                artifactId: `${producer.id}-${output.role}`, ...structuredClone(output)
            }))
        };
    });
    return sealContentDigest({
        schema: 'fsusblog.coverage-physical-terminal-declarations.v1',
        scope: 'coverage-subchain',
        completeProductionCatalog: false,
        qualificationEligible: false,
        executionEligible: false,
        identity: structuredClone(plan.identity),
        coveragePlanDigest: plan.contentDigest,
        compiledDagDigest: compiled.contentDigest,
        matrixDigest: compiled.matrixDigest,
        physicalOwners,
        terminalDeclarations
    });
}

/**
 * Consume explicit coverage-owner access facts and its independent verifier.
 * No read/write/create/delete mode is inferred from IDs, argv or output paths.
 * ownerAccess binds every physical input closure plus the exact declarations;
 * verifyAccessOwner must verify that complete current-owner packet externally.
 * The resulting filesystem plan remains a coverage-only, nonexecuting fragment.
 */
export function compileCoveragePhysicalAccessDeclarations({ coverageInput, ownerAccess, verifyAccessOwner, roots, context })
{
    const declarations = compileCoveragePhysicalTerminalDeclarations(coverageInput);
    exactKeys(ownerAccess, ['schema', 'identity', 'terminalDeclarationsDigest', 'producerClosureRefs',
        'catalog', 'unknownAccess', 'ownerRef', 'contentDigest'], 'coverage owner access packet');
    equal(ownerAccess.schema, coveragePhysicalAccessDeclarationSchema, 'access schema');
    const { contentDigest, ...body } = ownerAccess;
    equal(contentDigest, digestCanonical(body), 'access packet digest');
    equal(ownerAccess.identity, declarations.identity, 'owner run/source identity');
    equal(ownerAccess.terminalDeclarationsDigest, declarations.contentDigest, 'terminal declarations digest');
    equal(ownerAccess.unknownAccess, false, 'known complete access');
    exactKeys(ownerAccess.ownerRef, ['id', 'contentDigest'], 'coverage access owner reference');
    if (typeof ownerAccess.ownerRef.id !== 'string' || !ownerAccess.ownerRef.id
        || !/^sha256:[a-f0-9]{64}$/u.test(ownerAccess.ownerRef.contentDigest))
    {
        throw new Error('coverage physical declaration requires an explicit access owner reference');
    }
    equal(ownerAccess.producerClosureRefs, Object.fromEntries(declarations.terminalDeclarations
        .filter((item) => item.spawnEligibility).map((item) => [item.producerId, item.inputClosureRef])), 'producer input closures');
    if (typeof verifyAccessOwner !== 'function')
    {
        throw new Error('coverage physical declaration access owner verifier unavailable');
    }
    const expected = { status: 'verified', ownerRef: ownerAccess.ownerRef, declarationDigest: contentDigest,
        identity: declarations.identity, unknownAccess: false };
    equal(verifyAccessOwner(structuredClone(ownerAccess), structuredClone(expected)), expected, 'access owner verification');
    equal(context?.runId, declarations.identity.runId, 'filesystem run');
    equal(context?.sourceState, { commit: declarations.identity.sourceCommit,
        worktreeFingerprint: declarations.identity.sourceFingerprint }, 'filesystem source');
    const filesystemPlan = compilePhysicalProducerFilesystemPlan({
        catalog: ownerAccess.catalog,
        physicalOwners: declarations.physicalOwners,
        roots,
        context
    });
    return sealContentDigest({
        schema: 'fsusblog.coverage-physical-access-fragment.v1',
        scope: declarations.scope,
        completeProductionCatalog: false,
        qualificationEligible: false,
        executionEligible: false,
        terminalDeclarationsDigest: declarations.contentDigest,
        ownerAccessDigest: contentDigest,
        ownerRef: structuredClone(ownerAccess.ownerRef),
        filesystemPlan
    });
}
