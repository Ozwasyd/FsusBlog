import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import { canonicalJson, digestCanonical, sealContentDigest, sha256 } from './attempt-provenance.mjs';
import { projectBackendGovernanceOutcomes, projectBackendPerfOutcomes } from './backend-atomic-outcomes.mjs';
import { backendAtomicDigest, validateBackendAtomicPlan, verifyBackendAtomicSourceRefs } from './backend-atomic-producers.mjs';

const { compileAtomicProducerDag, verifyCompiledAtomicProducerDag } = await import(new URL('../test-matrix/atomic-producers/compiler.mjs', import.meta.url));
const { AtomicProducerExecutionError, executeCompiledAtomicProducerDag, verifyAtomicTerminalVector } = await import(new URL('../test-matrix/atomic-producers/execution.mjs', import.meta.url));
const { isAtomicExecutable, resolveAtomicReference } = await import(new URL('../test-matrix/atomic-producers/contract.mjs', import.meta.url));

function same(actual, expected, label)
{
    if (canonicalJson(actual) !== canonicalJson(expected))
    {
        throw new Error(`backend atomic ${label} mismatch`);
    }
}

function domainPlans(input)
{
    if (!Array.isArray(input.plans) || !input.plans.length)
    {
        throw new Error('backend atomic plans are required');
    }
    const plans = [...input.plans].sort((left, right) => left.lane.localeCompare(right.lane));
    same(Object.keys(input.expectedPlanDigests).sort(), plans.map((plan) => plan.lane).sort(), 'selected domain plan roster');
    for (const plan of plans)
    {
        validateBackendAtomicPlan(plan, input.expectedPlanDigests[plan.lane]);
        verifyBackendAtomicSourceRefs(plan, input.expectedPlanDigests[plan.lane], input.sourceRoot);
        same(plan.identity, plans[0].identity, 'shared execution identity');
    }
    if (plans.some((plan) => plan.lane === 'backend-perf') && !plans.some((plan) => plan.lane === 'backend-test-governance'))
    {
        throw new Error('performance bridge requires the same canonical governance slice');
    }
    return plans;
}

function verifyPhysicalBinding(step, declaration, authorities)
{
    same(digestCanonical(step.command), declaration.commandDigest, 'canonical command');
    same(step.attemptPolicyId, declaration.attemptPolicyId, 'zero-retry policy');
    same(step.replayPlanRef.contentDigest, declaration.replayPlanDigest, 'replay artifact bytes');
    const source = resolveAtomicReference(authorities.commandSources, step.commandSourceRef, 'command source');
    same(source.sourceRef, declaration.commandSourceRef, 'original command owner reference');
    const closure = resolveAtomicReference(authorities.inputClosures, source.inputClosureRef, 'input closure');
    same(closure.sourceRef, declaration.inputClosureRef, 'original input closure reference');
    const resources = resolveAtomicReference(authorities.resourceContracts, step.resourceContractRef, 'resource contract');
    same(resources.sourceRef, declaration.resourceContractRef, 'resource source reference');
    const fixture = resolveAtomicReference(authorities.fixtureProfiles, step.fixtureProfile, 'fixture profile');
    same(fixture.profileId, declaration.fixtureProfile, 'fixture identity');
}

/** Bind the owned domain constraints to the existing canonical compiler, never create topology. */
export function compileBackendAtomicBridge(input)
{
    const plans = domainPlans(input);
    const compiled = compileAtomicProducerDag(input.matrix, input.authorities);
    const allowed = new Set();
    for (const plan of plans)
    {
        for (const declaration of plan.declarations)
        {
            allowed.add(declaration.producerId);
            const step = compiled.steps.find((item) => item.id === declaration.producerId);
            if (!step)
            {
                throw new Error(`backend atomic compiled producer is missing: ${declaration.producerId}`);
            }
            same(step.logicalParentId, declaration.logicalParentId, 'logical parent');
            same(step.dependsOn, declaration.dependsOn, 'hard edges');
            same(step.settledDependsOn, declaration.settledDependsOn, 'settled edges');
            if (declaration.kind === 'settled-join')
            {
                same(step.kind, 'logical-projection', 'command-free parent projection');
                continue;
            }
            same(step.kind, 'atomic-producer', 'physical producer kind');
            verifyPhysicalBinding(step, declaration, input.authorities);
            const expectedClass = step.id === 'backend-perf-native-p99' ? 'runtime'
                : step.id === 'backend-perf-readiness' ? 'build' : 'static';
            same(step.executionClass, expectedClass, 'canonical execution class');
            if (step.id === 'backend-perf-native-p99')
            {
                if (!step.resources.exclusiveResources?.includes('benchmark-window') || !step.stateAccessRef)
                {
                    throw new Error('native measurement requires canonical benchmark-window and state access');
                }
                const state = resolveAtomicReference(input.authorities.stateAccess, step.stateAccessRef, 'state access');
                same(state.sourceRef, declaration.stateAccessRef, 'native state source reference');
            }
        }
        if (plan.releasePrerequisite)
        {
            const prerequisite = plan.releasePrerequisite;
            allowed.add(prerequisite.producerId);
            const step = compiled.steps.find((item) => item.id === prerequisite.producerId);
            if (!step || !['atomic-producer', 'hard-prerequisite'].includes(step.kind))
            {
                throw new Error('Release build producer is missing');
            }
            same(step.executionClass, 'build', 'Release build execution class');
            verifyPhysicalBinding(step, prerequisite, input.authorities);
            same(step.dependsOn, prerequisite.dependsOn, 'Release build hard edges');
            same(step.settledDependsOn, prerequisite.settledDependsOn, 'Release build settled edges');
            same(step.logicalParentId, prerequisite.logicalParentId, 'Release build parent');
            const projections = compiled.steps.filter((item) => item.logicalParentId === prerequisite.logicalParentId && item.kind === 'logical-projection');
            if (projections.length !== 1)
            {
                throw new Error('Release build requires its canonical parent projection');
            }
            same(projections[0].settledDependsOn, [prerequisite.producerId], 'Release build projection roster');
            allowed.add(projections[0].id);
        }
    }
    for (const step of compiled.steps)
    {
        if (step.kind === 'always-run-finalizer')
        {
            allowed.add(step.id);
        }
        else if (!allowed.has(step.id))
        {
            throw new Error(`backend atomic bridge cannot execute an unrelated producer: ${step.id}`);
        }
    }
    return sealContentDigest({
        schema: 'fsusblog.backend-atomic-compiler-binding.v1', qualificationEligible: false,
        domainPlanDigests: Object.fromEntries(plans.map((plan) => [plan.lane, plan.contentDigest])), compiled
    });
}

function exactAttemptReference(reference, root)
{
    const realRoot = fs.realpathSync(root);
    const absolute = path.resolve(reference.path);
    if (!absolute.startsWith(`${realRoot}${path.sep}`) || fs.realpathSync(absolute) !== absolute || !fs.lstatSync(absolute).isFile())
    {
        throw new Error('canonical atomic attempt reference escapes or aliases its evidence root');
    }
    const bytes = fs.readFileSync(absolute);
    same(JSON.parse(bytes).contentDigest, reference.contentDigest, 'terminal attempt content digest');
    return { path: path.relative(realRoot, absolute).replaceAll(path.sep, '/'), digest: sha256(bytes) };
}

export class BackendAtomicExecutionError extends Error
{
    constructor(result, cause)
    {
        super('backend atomic execution did not produce a clean verified complete projection', { cause });
        this.name = 'BackendAtomicExecutionError';
        this.result = result;
    }
}

/** Validate the original pre-execution bindings without invoking private authority callbacks. */
export function prepareBackendAtomicBridge(binding, input, options)
{
    const selected = compileBackendAtomicBridge(input);
    backendAtomicDigest(options.expectedBindingDigest, 'selected compiler binding');
    same(binding, selected, 'compiler binding');
    same(binding.contentDigest, options.expectedBindingDigest, 'selected compiler digest');
    verifyCompiledAtomicProducerDag(binding.compiled, input.matrix, input.authorities);
    const plans = domainPlans(input);
    const identity = plans[0].identity;
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'schedulerRunId'])
    {
        same(options.context[field], identity[field], `execution ${field}`);
    }
    same(options.profile, identity.profile, 'execution profile');
    if (typeof options.verifyAuthority !== 'function')
    {
        throw new Error('backend independent receipt verifier is required');
    }
    for (const plan of plans)
    {
        for (const declaration of [...plan.declarations.filter((entry) => entry.kind === 'atomic-producer'), ...(plan.releasePrerequisite ? [plan.releasePrerequisite] : [])])
        {
            const supplied = options.producerContexts?.[declaration.producerId];
            if (!supplied)
            {
                throw new Error(`missing backend producer context: ${declaration.producerId}`);
            }
            for (const [kind, field] of [['execution-envelope', 'executionEnvelopeDigest'], ['replay-plan', 'replayPlanDigest'], ['temporal-context', 'temporalContextDigest']])
            {
                const references = supplied.authorityReferences?.filter((item) => item.kind === kind) ?? [];
                if (references.length !== 1)
                {
                    throw new Error(`backend ${kind} requires exact-one reference`);
                }
                same(references[0].artifactDigest, declaration[field], `${declaration.producerId} ${kind}`);
            }
            if (plan.lane === 'backend-perf')
            {
                same(supplied.env.FSUSBLOG_BACKEND_TEST_CONFIGURATION, 'Release', 'sealed Release environment');
                same(supplied.env.FSUSBLOG_BACKEND_PERF_READINESS_MODE, plan.readinessMode, 'sealed readiness environment');
            }
        }
    }
    const producerIds = binding.compiled.steps.filter(isAtomicExecutable).map((step) => step.id).sort();
    return {
        compiled: binding.compiled,
        sourceBindingDigest: binding.contentDigest,
        producerIds,
        producerContexts: Object.fromEntries(producerIds.map((id) => [id, options.producerContexts[id]])),
        context: options.context,
        qualificationEligible: false
    };
}

/** Run the exact compiled graph once through the original executor and retain every terminal. */
export async function executeBackendAtomicBridge(binding, input, options)
{
    prepareBackendAtomicBridge(binding, input, options);
    let vector;
    let cause;
    try
    {
        vector = await executeCompiledAtomicProducerDag(binding.compiled, { ...options, matrix: input.matrix, authorities: input.authorities });
    }
    catch (error)
    {
        if (!(error instanceof AtomicProducerExecutionError))
        {
            throw error;
        }
        vector = error.terminalVector;
        cause = error;
    }
    const result = projectBackendAtomicExecution(vector, binding, input, options);
    if (result.exitCode !== 0)
    {
        throw new BackendAtomicExecutionError(result, cause);
    }
    return result;
}

function projectBackendAtomicExecution(vector, binding, input, options)
{
    const projections = [];
    const projectionFailures = [];
    const plans = domainPlans(input);
    const governancePlan = plans.find((plan) => plan.lane === 'backend-test-governance');
    const observationsFor = (plan) => plan.declarations.filter((entry) => entry.kind === 'atomic-producer').map((entry) =>
    {
        const terminal = vector.receipts.find((receipt) => receipt.producerId === entry.producerId);
        if (!terminal?.attemptRef)
        {
            if (entry.producerId === 'backend-perf-native-p99' && terminal?.terminalState === 'blocked')
            {
                return { producerId: entry.producerId, blockedBy: terminal.blockedBy };
            }
            throw new Error(`canonical ${entry.producerId} has ${terminal?.terminalState ?? 'missing'} terminal without a verified attempt`);
        }
        return { producerId: entry.producerId, attemptRef: exactAttemptReference(terminal.attemptRef, options.context.evidenceRoot) };
    });
    let governance;
    for (const plan of [...plans].sort((left, right) => Number(right.lane === 'backend-test-governance') - Number(left.lane === 'backend-test-governance')))
    {
        try
        {
            const common = { plan, expectedPlanDigest: input.expectedPlanDigests[plan.lane], observations: observationsFor(plan),
                evidenceRoot: options.context.evidenceRoot, sourceRoot: input.sourceRoot, verifyAuthority: options.verifyAuthority };
            if (plan.lane === 'backend-test-governance')
            {
                governance = { plan, expectedPlanDigest: common.expectedPlanDigest, observations: common.observations };
                projections.push(projectBackendGovernanceOutcomes(common));
            }
            else
            {
                if (!governance || !governancePlan)
                {
                    throw new Error('verified canonical governance projection is unavailable');
                }
                const terminal = vector.receipts.find((receipt) => receipt.producerId === plan.releasePrerequisite.producerId);
                if (!terminal?.attemptRef)
                {
                    throw new Error('canonical Release build has no verified attempt receipt');
                }
                projections.push(projectBackendPerfOutcomes({ ...common, governance,
                    releaseAttemptRef: exactAttemptReference(terminal.attemptRef, options.context.evidenceRoot) }));
            }
        }
        catch (error)
        {
            projectionFailures.push({ lane: plan.lane, reason: error.message });
        }
    }
    const vectorFile = path.join(options.context.evidenceRoot, options.context.schedulerRunId, 'atomic-dag', binding.compiled.contentDigest.slice(7), 'terminal-vector.json');
    if (fs.realpathSync(vectorFile) !== path.resolve(vectorFile) || !fs.lstatSync(vectorFile).isFile())
    {
        throw new Error('canonical terminal vector must be an unaliased regular file');
    }
    const vectorBytes = fs.readFileSync(vectorFile);
    verifyAtomicTerminalVector(vector, JSON.parse(vectorBytes));
    return sealContentDigest({
        schema: 'fsusblog.backend-atomic-execution.v1', qualificationEligible: false,
        compilerBindingDigest: binding.contentDigest, compiledDagDigest: binding.compiled.contentDigest,
        terminalVectorRef: { path: path.relative(options.context.evidenceRoot, vectorFile).replaceAll(path.sep, '/'), digest: sha256(vectorBytes) },
        terminalVector: vector, projections, projectionFailures,
        exitCode: vector.status === 'success' && !projectionFailures.length && projections.every((projection) => projection.exitCode === 0) ? 0 : 1
    });
}

/** Recompute only from immutable canonical vector/attempt/log bytes; never execute or repair. */
export function verifyBackendAtomicExecution(result, expectedDigest, binding, input, options)
{
    backendAtomicDigest(expectedDigest, 'selected execution result digest');
    same(result.contentDigest, expectedDigest, 'selected execution result');
    const selected = compileBackendAtomicBridge(input);
    same(binding, selected, 'readback compiler binding');
    same(binding.contentDigest, options.expectedBindingDigest, 'readback selected compiler digest');
    const replayed = projectBackendAtomicExecution(result.terminalVector, binding, input, options);
    same(result, replayed, 'immutable execution readback');
    return replayed;
}
