import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { verifyPublicRuntimeDeclarations } from './declarations.mjs';
import { publicRuntimeSettledResetContract } from './settled-reset-adapter.mjs';

const { canonicalJson, digestCanonical, sealContentDigest } = await import(new URL('../attempt-provenance.mjs', import.meta.url));
const { compileAtomicProducerDag, verifyCompiledAtomicProducerDag } = await import(new URL('../../test-matrix/atomic-producers/compiler.mjs', import.meta.url));
const { resolveAtomicReference, resolveAtomicReplayPlan } = await import(new URL('../../test-matrix/atomic-producers/contract.mjs', import.meta.url));

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const bindingKeys = ['owner', 'commandSourceRef', 'fixtureProfile', 'stateAccessRef', 'resourceContractRef',
    'serviceDependencies', 'artifacts', 'evidence', 'replayOwner', 'replayPlanRef'];

function requireEqual(actual, expected, label)
{
    if (canonicalJson(actual) !== canonicalJson(expected))
    {
        throw new Error(`public runtime ${label} mismatch`);
    }
}

function sortedUnique(values, label)
{
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value))
    {
        throw new Error(`public runtime ${label} must be explicit strings`);
    }
    requireEqual(values, [...new Set(values)].sort(), `${label} sorted unique roster`);
    return values;
}

/** Preserve the existing client/measurement argv; host and reset sources remain owner-supplied. */
export function publicRuntimeProducerCommand(node, { root = defaultRoot, nodeExecutable = 'node' } = {})
{
    if (node.execution?.owner === 'RunInClient')
    {
        return node.execution.command[0] === 'node'
            ? [nodeExecutable, ...node.execution.command.slice(1)] : [...node.execution.command];
    }
    if (node.execution?.owner === 'RunInClientMeasurement')
    {
        return [nodeExecutable, path.join(root, 'tools/test/performance-admission.mjs'),
            '--window-id', node.id, '--evidence', path.join(root, node.execution.noiseEvidencePath), '--',
            '/usr/bin/env', '-C', path.join(root, 'src/frontend'), ...node.execution.command];
    }
    return null;
}

function bindExecutable(node, attachment, authorities, options)
{
    const binding = attachment.producers[node.id];
    if (!binding || Object.keys(binding).sort().join(',') !== [...bindingKeys].sort().join(','))
    {
        throw new Error(`public runtime requires closed owner binding: ${node.id}`);
    }
    const state = resolveAtomicReference(authorities.stateAccess, binding.stateAccessRef, 'state access');
    if (state.producerId !== node.id || state.unknownAccess !== false)
    {
        throw new Error(`public runtime child state remains unverified: ${node.id}`);
    }
    const predecessors = sortedUnique(state.requiredPredecessors, `${node.id} state predecessors`);
    const source = resolveAtomicReference(authorities.commandSources, binding.commandSourceRef, 'command source');
    const command = publicRuntimeProducerCommand(node, options);
    if (command !== null)
    {
        requireEqual(source.command, command, `${node.id} original command`);
    }
    else
    {
        // Exact host/reset dispatch is not reconstructed from a phase CLI. Its
        // owner binds the original scenario or independent postcondition contract.
        const execution = node.execution ?? publicRuntimeSettledResetContract();
        requireEqual(source.publicRuntimeExecution, {
            producerId: node.id,
            declarationDigest: attachment.declarationDigest,
            execution
        }, `${node.id} owner execution contract`);
    }
    return {
        kind: node.kind === 'verified-postcondition-barrier' ? 'hard-prerequisite' : 'atomic-producer',
        producerId: node.id,
        logicalParentId: attachment.logicalParentId,
        projectionOwner: attachment.projectionOwner,
        executionClass: 'runtime',
        evidenceClass: 'correctness',
        attemptPolicyId: 'correctness-first-attempt',
        dependsOn: [...new Set([...node.dependsOn, ...predecessors])].sort(),
        settledDependsOn: [...node.settledDependsOn].sort(),
        ...structuredClone(binding)
    };
}

/** Return domain attachment material for the matrix owner; never create a second matrix. */
export function publicRuntimeAtomicNodes({ declarations, attachment, authorities }, options = {})
{
    verifyPublicRuntimeDeclarations(declarations, options);
    if (!attachment || Object.keys(attachment).sort().join(',')
        !== 'declarationDigest,logicalParentId,producers,projectionOwner')
    {
        throw new Error('public runtime requires an explicit closed matrix-owner attachment');
    }
    requireEqual(attachment.declarationDigest, declarations.contentDigest, 'attachment declaration');
    const children = declarations.nodes.filter((node) => node.kind !== 'settled-projection');
    requireEqual(Object.keys(attachment.producers).sort(), children.map((node) => node.id).sort(), 'child owner roster');
    const executable = children.map((node) => bindExecutable(node, attachment, authorities, options));
    const summary = declarations.nodes.find((node) => node.kind === 'settled-projection');
    return {
        nodes: [...executable, {
            kind: 'logical-projection',
            producerId: summary.id,
            logicalParentId: attachment.logicalParentId,
            owner: attachment.projectionOwner,
            projectionOwner: attachment.projectionOwner,
            dependsOn: [],
            settledDependsOn: executable.map((node) => node.producerId).sort()
        }],
        parent: {
            id: attachment.logicalParentId,
            executionMode: 'projection',
            commandKind: 'projection',
            executionOwner: attachment.projectionOwner,
            projectFrom: executable.map((node) => node.producerId).sort()
        }
    };
}

/** Invoke the actual canonical compiler on the exact owner-supplied matrix/projections. */
export function compilePublicRuntimeProducerDag(inputs, options = {})
{
    const { nodes, parent } = publicRuntimeAtomicNodes(inputs, options);
    const { matrix, authorities, declarations } = inputs;
    for (const node of nodes)
    {
        const matches = matrix?.atomicProducerDeclarations?.nodes?.filter((candidate) => candidate.producerId === node.producerId) ?? [];
        if (matches.length !== 1)
        {
            throw new Error(`public runtime matrix lacks exact-one owned child: ${node.producerId}`);
        }
        requireEqual(matches[0], node, `${node.producerId} matrix attachment`);
    }
    const actualParent = matrix.tiers.filter((tier) => tier.id === parent.id);
    if (actualParent.length !== 1)
    {
        throw new Error('public runtime matrix parent must be exact-one');
    }
    for (const [field, value] of Object.entries(parent))
    {
        requireEqual(actualParent[0][field], value, `matrix parent ${field}`);
    }
    const compiled = compileAtomicProducerDag(matrix, authorities);
    const requirements = declarations.nodes.flatMap((node) => node.requiredAuthorities.map((kind) => ({ producerId: node.id, kind })));
    return sealContentDigest({
        schema: 'fsusblog.public-runtime-compiled-binding.v1',
        qualificationEligible: false,
        declarationDigest: declarations.contentDigest,
        compiled,
        runtimeRequirements: requirements,
        runtimeAuthorityStatus: 'unverified',
        settledResetContract: declarations.tier === 'load' ? publicRuntimeSettledResetContract() : null
    });
}

/**
 * Prepare the exact contexts used by executeCompiledAtomicProducerDag/runProducerAttempts.
 * Runtime authority remains unverified; the integration owner must admit these
 * requirements and install reset postflight before calling the canonical executor.
 */
export function preparePublicRuntimeAttemptContexts(binding, inputs, { context, identity, producerContexts, timeoutProfiles }, options = {})
{
    const expected = compilePublicRuntimeProducerDag(inputs, options);
    requireEqual(binding, expected, 'compiled binding');
    verifyCompiledAtomicProducerDag(binding.compiled, inputs.matrix, inputs.authorities);
    requireEqual(context.schedulerRunId, identity.runId, 'attempt run');
    requireEqual(context.sourceCommit, identity.sourceCommit, 'attempt source');
    requireEqual(context.worktreeFingerprint, identity.sourceFingerprint, 'attempt worktree');
    const root = path.resolve(options.root ?? defaultRoot);
    for (const node of inputs.declarations.nodes.filter((candidate) => candidate.kind !== 'settled-projection'))
    {
        const supplied = producerContexts[node.id];
        if (!supplied || typeof supplied.verifyAuthority !== 'function')
        {
            throw new Error(`public runtime missing canonical attempt context: ${node.id}`);
        }
        requireEqual(path.resolve(supplied.cwd), path.join(root, 'src/frontend'), `${node.id} cwd`);
        const execution = node.execution ?? { target: 'backend-and-preview', timeoutProfile: 'load' };
        const target = execution.target;
        const baseUrl = target === 'preview' ? identity.previewUrl : identity.backendUrl;
        requireEqual(supplied.env.FSUSBLOG_BASE_URL, baseUrl, `${node.id} backend/preview target`);
        if (target === 'backend-and-preview')
        {
            requireEqual(supplied.env.FSUSBLOG_PUBLIC_BASE_URL, identity.previewUrl, `${node.id} public target`);
        }
        else if (inputs.declarations.tier === 'release-public')
        {
            requireEqual(supplied.env.FSUSBLOG_PUBLIC_BASE_URL, baseUrl, `${node.id} public target`);
        }
        const timeout = timeoutProfiles[execution.timeoutProfile];
        if (!Number.isSafeInteger(timeout) || timeout <= 0)
        {
            throw new Error(`public runtime missing original timeout profile: ${node.id}`);
        }
        requireEqual(supplied.env.FSUSBLOG_HTTP_TIMEOUT_MS, String(timeout), `${node.id} HTTP timeout`);
        for (const [key, value] of Object.entries(execution.environment ?? {}))
        {
            requireEqual(supplied.env[key], value, `${node.id} environment ${key}`);
        }
        const compiledStep = binding.compiled.steps.find((step) => step.id === node.id);
        const replay = resolveAtomicReplayPlan(inputs.authorities.replayPlans, compiledStep.replayPlanRef).plan;
        requireEqual(replay.command.environmentDigest, digestCanonical(supplied.env), `${node.id} replay environment`);
        requireEqual(replay.source, { commit: context.sourceCommit, worktreeFingerprint: context.worktreeFingerprint }, `${node.id} replay source`);
        requireEqual(replay.run.id, context.schedulerRunId, `${node.id} replay run`);
    }
    return {
        compiled: binding.compiled,
        executionOptions: { matrix: inputs.matrix, authorities: inputs.authorities, context, producerContexts },
        runtimeRequirements: structuredClone(binding.runtimeRequirements),
        runtimeAuthorityStatus: 'unverified',
        qualificationEligible: false
    };
}
