import path from 'node:path';
import { URL } from 'node:url';

import { validateStaticAssertionMembership } from './assertion-membership.mjs';
import { staticAtomicDeclarations } from './declarations.mjs';
import { staticAtomicAuthorityVerifier } from './producer.mjs';

const { digestCanonical, sealContentDigest } = await import(new URL('../attempt-provenance.mjs', import.meta.url));
const { compileAtomicProducerDag, verifyCompiledAtomicProducerDag } = await import(new URL('../../test-matrix/atomic-producers/compiler.mjs', import.meta.url));
const { isAtomicExecutable, resolveAtomicReference, resolveAtomicReplayPlan } = await import(new URL('../../test-matrix/atomic-producers/contract.mjs', import.meta.url));
const { executeCompiledAtomicProducerDag } = await import(new URL('../../test-matrix/atomic-producers/execution.mjs', import.meta.url));

function same(left, right, label)
{
    if (digestCanonical(left) !== digestCanonical(right))
    {
        throw new Error(`static atomic compiler ${label} mismatch`);
    }
}

/** Bind domain source to an owner-supplied matrix attachment using the sole canonical compiler. */
export function bindStaticAtomicCompilation({ repositoryRoot, matrix, authorities, memberships, prerequisiteBindings })
{
    const declarations = staticAtomicDeclarations(repositoryRoot);
    const compiled = compileAtomicProducerDag(matrix, authorities);
    same(Object.keys(memberships ?? {}).sort(), declarations.producers.map(entry => entry.id).sort(), 'membership roster');
    same(Object.keys(prerequisiteBindings ?? {}).sort(), declarations.producers.map(entry => entry.id).sort(), 'prerequisite roster');
    const bindings = declarations.producers.map(producer =>
    {
        const step = compiled.steps.find(entry => entry.id === producer.id);
        if (!step || step.kind !== 'atomic-producer' || step.logicalParentId !== producer.lane
            || step.executionClass !== 'static')
        {
            throw new Error(`static atomic compiler producer identity mismatch: ${producer.id}`);
        }
        same(step.command, producer.command, 'unchanged checker command');
        same(step.resources, producer.resources, 'resource contract');
        if (producer.canonicalExecutionOwner && step.owner !== producer.canonicalExecutionOwner.split('/')[0])
        {
            throw new Error('static atomic compiler must retain the canonical security-matrices physical owner');
        }
        const replay = resolveAtomicReplayPlan(authorities.replayPlans, step.replayPlanRef);
        const membership = validateStaticAssertionMembership(producer, memberships[producer.id], replay.plan);
        const prerequisites = prerequisiteBindings[producer.id];
        same(Object.keys(prerequisites).sort(), [...producer.prerequisites].sort(), 'declared prerequisite capabilities');
        const hardDependencies = [];
        for (const [capability, material] of Object.entries(prerequisites))
        {
            if (material?.kind === 'held-input')
            {
                same(Object.keys(material).sort(), ['inputClosureRef', 'kind'], 'held prerequisite fields');
                same(material.inputClosureRef, step.inputClosureRef, `held prerequisite ${capability}`);
                resolveAtomicReference(authorities.inputClosures, material.inputClosureRef, 'input closure');
            }
            else if (material?.kind === 'hard-prerequisite')
            {
                same(Object.keys(material).sort(), ['kind', 'producerId'], 'hard prerequisite fields');
                const dependency = compiled.steps.find(entry => entry.id === material.producerId);
                if (!dependency || dependency.kind !== 'hard-prerequisite')
                {
                    throw new Error(`static atomic compiler missing hard prerequisite: ${capability}`);
                }
                hardDependencies.push(dependency.id);
            }
            else
            {
                throw new Error(`static atomic compiler unknown prerequisite disposition: ${capability}`);
            }
        }
        same(step.dependsOn, [...new Set(hardDependencies)].sort(), 'exact hard prerequisite edges');
        same(step.settledDependsOn, [], 'physical settled edges');
        return { producerId: producer.id, lane: producer.lane, commandSourceRef: step.commandSourceRef,
            inputClosureRef: step.inputClosureRef, replayPlanRef: step.replayPlanRef,
            dependsOn: step.dependsOn, prerequisites, membership };
    });
    const allTestIds = bindings.flatMap(entry => entry.membership.replayTestIds);
    if (new Set(allTestIds).size !== allTestIds.length)
    {
        throw new Error('static atomic compiler replay membership has duplicate physical execution ownership');
    }
    for (const summary of declarations.summaries)
    {
        const step = compiled.steps.find(entry => entry.id === summary.id);
        if (!step || step.kind !== 'logical-projection' || step.logicalParentId !== summary.lane)
        {
            throw new Error('static atomic compiler requires the original sole domain summary');
        }
        same(step.settledDependsOn, [...summary.settledDependsOn].sort(), 'complete settled child roster');
        same(compiled.steps.filter(entry => entry.logicalParentId === summary.lane)
            .map(entry => entry.id).sort(), [...summary.settledDependsOn, summary.id].sort(), 'sole domain projection');
    }
    return {
        compiled,
        binding: sealContentDigest({
            schema: 'fsusblog.static-atomic-compilation-binding.v1',
            declarationDigest: declarations.contentDigest,
            compiledDagDigest: compiled.contentDigest,
            matrixDigest: compiled.matrixDigest,
            authorityProjectionDigest: compiled.authorityProjectionDigest,
            membershipDigest: digestCanonical(memberships),
            prerequisiteBindingsDigest: digestCanonical(prerequisiteBindings),
            producerBindings: bindings,
            projectionIds: declarations.summaries.map(entry => entry.id).sort(),
            qualificationEligible: false
        })
    };
}

export function verifyStaticAtomicCompilation(compilation, options)
{
    verifyCompiledAtomicProducerDag(compilation.compiled, options.matrix, options.authorities);
    const expected = bindStaticAtomicCompilation(options);
    same(compilation, expected, 'exact domain compilation');
    return expected;
}

/** Prepare private executable contexts without dispatching or invoking their authority callbacks. */
export function prepareStaticAtomicCompilation(compilation, options)
{
    const verified = verifyStaticAtomicCompilation(compilation, options);
    const declarations = staticAtomicDeclarations(options.repositoryRoot);
    const producerContexts = { ...options.producerContexts };
    for (const producer of declarations.producers)
    {
        const supplied = producerContexts[producer.id];
        if (!supplied || path.resolve(supplied.cwd) !== path.resolve(options.repositoryRoot, producer.cwd))
        {
            throw new Error(`static atomic compiler execution cwd mismatch: ${producer.id}`);
        }
        if (!supplied.env || typeof supplied.env !== 'object' || Array.isArray(supplied.env)
            || Object.values(supplied.env).some(value => typeof value !== 'string'))
        {
            throw new Error('static atomic compiler requires an explicit string-valued environment');
        }
        const bound = verified.binding.producerBindings.find(entry => entry.producerId === producer.id);
        const env = Object.freeze({ ...supplied.env });
        if (producer.id === 'security-network-baseline' && env.FSUSBLOG_SKIP_PRODUCTION_EXPOSURE_TOOL_TEST
            && env.FSUSBLOG_SKIP_PRODUCTION_EXPOSURE_TOOL_TEST !== '0')
        {
            throw new Error('static network baseline cannot skip its existing exposure tool tests');
        }
        producerContexts[producer.id] = { ...supplied, env, verifyAuthority: staticAtomicAuthorityVerifier({
            producer,
            verifyAuthority: supplied.verifyAuthority,
            binding: {
                declarationDigest: declarations.contentDigest,
                inputClosureDigest: bound.inputClosureRef.contentDigest,
                commandDigest: digestCanonical(producer.command),
                environmentDigest: digestCanonical(env),
                resourceContractDigest: digestCanonical(producer.resources),
                prerequisiteSetDigest: digestCanonical(producer.prerequisites),
                cwd: path.resolve(supplied.cwd)
            }
        }) };
    }
    const producerIds = verified.compiled.steps.filter(isAtomicExecutable).map(step => step.id).sort();
    return {
        compiled: verified.compiled,
        sourceBindingDigest: verified.binding.contentDigest,
        producerIds,
        producerContexts: Object.fromEntries(producerIds.map(id => [id, producerContexts[id]])),
        context: options.context,
        qualificationEligible: false
    };
}

/** Use the canonical executor once; its original error and full terminal vector are preserved. */
export async function executeStaticAtomicCompilation(compilation, options)
{
    const prepared = prepareStaticAtomicCompilation(compilation, options);
    return executeCompiledAtomicProducerDag(prepared.compiled, {
        matrix: options.matrix, authorities: options.authorities,
        context: prepared.context, capacity: options.capacity, producerContexts: prepared.producerContexts,
        finalizerOperations: options.finalizerOperations
    });
}
