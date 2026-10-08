import path from 'node:path';

const { readOutcomeFailureTaxonomy } = await import(new URL('../outcomes/outcome-contract.mjs', import.meta.url));
const { validateReplayPlan } = await import(new URL('../../test/execution-replay-contract.mjs', import.meta.url));
const { buildExecutionReplayCommand } = await import(new URL('../../test/execution-replay-verifier.mjs', import.meta.url));
import { admitMaterial, checkGraphMaterial, checkProjectionDigest, currentReference, digestFact,
    exactFields, hardFailureRoots, replayConflict, requireFact, sameFact, sealProjection, stableIds } from './projection-contract.mjs';

const replayStates = new Set(['failed', 'timed-out', 'internal-error']);

/**
 * Build navigation DATA_ONLY material from explicit aggregate/terminal/replay refs.
 * No filesystem discovery, attempt execution, qualification or checkpoint writes.
 * Authentication of these materials belongs to the upstream verified aggregate.
 */
export function projectFailureNavigationMaterial(input, hostLimits, repositoryRoot)
{
    const material = admitMaterial(input, hostLimits);
    exactFields(material, ['context', 'graph', 'aggregateRef', 'terminals'], 'navigation input');
    const { context, graph } = material;
    exactFields(context, ['schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint'], 'navigation context');
    requireFact(/^[a-z0-9][a-z0-9-]*$/u.test(context.schedulerRunId)
        && /^[a-z0-9][a-z0-9-]*$/u.test(context.attemptId) && /^[a-f0-9]{40}$/u.test(context.sourceCommit), 'invalid run/source/attempt');
    digestFact(context.worktreeFingerprint, 'worktree fingerprint');
    requireFact(typeof repositoryRoot === 'string' && path.isAbsolute(repositoryRoot), 'explicit absolute repository root required');
    const byId = checkGraphMaterial(graph);
    currentReference(graph.graphRef, context, 'compiled graph');
    currentReference(material.aggregateRef, context, 'semantic aggregate');
    sameFact(stableIds(material.terminals.map((terminal) => terminal.producerId), 'terminal producers'),
        [...byId.keys()].sort(), 'complete terminal vector');
    const states = new Map(material.terminals.map((terminal) => [terminal.producerId, terminal.terminalState]));
    const taxonomy = readOutcomeFailureTaxonomy();
    const terminals = new Map(material.terminals.map((terminal) => [terminal.producerId, terminal]));
    const producers = [];
    for (const producerId of [...byId.keys()].sort())
    {
        const terminal = terminals.get(producerId);
        exactFields(terminal, ['producerId', 'terminalState', 'reasonCode', 'failures', 'primaryFailureRefs', 'blockedBy',
            'attemptReceiptRef', 'attemptNumber', 'allowedRetries', 'replayPlanRef', 'replayPlan',
            'executionEnvelopeDigest', 'logRefs', 'artifactRefs', 'evidenceRefs'], 'terminal material');
        const node = byId.get(producerId);
        requireFact(['success', 'failed', 'timed-out', 'internal-error', 'blocked', 'cancelled', 'not-selected', 'diagnostic']
            .includes(terminal.terminalState), 'unknown terminal state');
        requireFact((node.evidenceClass === 'diagnostic') === (terminal.terminalState === 'diagnostic'),
            'diagnostic disposition must remain separate');
        requireFact(terminal.reasonCode === null || /^[a-z][a-z0-9.-]*$/u.test(terminal.reasonCode), 'invalid structured reason code');
        requireFact(Array.isArray(terminal.failures), 'structured failures required');
        const failures = terminal.failures.map((failure) =>
        {
            exactFields(failure, ['kind', 'identity'], 'canonical failure');
            const rule = taxonomy.get(failure.kind);
            requireFact(rule && failure.identity?.producerId === producerId
                && rule.requiredIdentity.every((key) => Object.hasOwn(failure.identity, key)), 'canonical failure taxonomy/identity mismatch');
            exactFields(failure.identity, rule.requiredIdentity, 'canonical failure identity');
            for (const value of Object.values(failure.identity))
            {
                requireFact((typeof value === 'string' && /^[a-zA-Z0-9:._-]+$/u.test(value))
                    || (Number.isSafeInteger(value) && value > 0), 'failure identity must be a safe opaque ID');
            }
            return failure;
        });
        for (const field of ['primaryFailureRefs', 'logRefs', 'artifactRefs', 'evidenceRefs'])
        {
            requireFact(Array.isArray(terminal[field]), `${field} must be explicit references`);
            terminal[field].forEach((ref) => currentReference(ref, context, field));
            requireFact(new Set(terminal[field].map((ref) => ref.path)).size === terminal[field].length, `duplicate ${field}`);
        }
        const nonexecuted = ['blocked', 'not-selected'].includes(terminal.terminalState);
        const coordination = node.evidenceClass === 'coordination';
        if (nonexecuted || coordination)
        {
            requireFact(terminal.attemptReceiptRef === null && terminal.attemptNumber === 0
                && terminal.replayPlanRef === null && terminal.replayPlan === null, 'nonexecuted/coordination node cannot claim self attempt/replay');
        }
        else
        {
            currentReference(terminal.attemptReceiptRef, context, 'attempt receipt');
            requireFact(terminal.attemptNumber === 1, 'first attempt must be preserved');
        }
        requireFact(terminal.allowedRetries === 0, 'correctness projection cannot hide retry');
        const blockedBy = stableIds(terminal.blockedBy, 'blocked producers');
        if (terminal.terminalState === 'blocked')
        {
            sameFact(blockedBy, hardFailureRoots(producerId, byId, states), 'hard dependency blocked closure');
            requireFact(blockedBy.length > 0, 'blocked disposition lacks failed dependency');
        }
        else
        {
            requireFact(blockedBy.length === 0, 'nonblocked producer cannot carry blockedBy');
        }
        let focusedReplayCommand = null;
        if (replayStates.has(terminal.terminalState) && !coordination)
        {
            requireFact(failures.length > 0 && terminal.primaryFailureRefs.length > 0, 'failure must retain canonical primary evidence');
            currentReference(terminal.replayPlanRef, context, 'replay plan');
            const plan = validateReplayPlan(terminal.replayPlan);
            sameFact(plan.producer.id, producerId, 'replay producer');
            sameFact(plan.run.id, context.schedulerRunId, 'replay run');
            sameFact(plan.source, { commit: context.sourceCommit, worktreeFingerprint: context.worktreeFingerprint }, 'replay source');
            sameFact(plan.planDigest, terminal.replayPlanRef.objectDigest, 'sealed replay plan');
            digestFact(terminal.executionEnvelopeDigest, 'execution envelope');
            focusedReplayCommand = buildExecutionReplayCommand({ root: repositoryRoot,
                planPath: path.resolve(repositoryRoot, terminal.replayPlanRef.path), plan,
                schedulerShuffleSeed: plan.schedulerShuffleSeed, executionEnvelopeRef: terminal.executionEnvelopeDigest }).posix;
        }
        else
        {
            requireFact(terminal.replayPlanRef === null && terminal.replayPlan === null,
                'navigation only admits focused replay for original failures');
            requireFact(coordination || (failures.length === 0 && terminal.primaryFailureRefs.length === 0),
                'original failure cannot be overwritten by a nonfailed disposition');
        }
        producers.push({ producerId, logicalParentId: node.logicalParentId, terminalState: terminal.terminalState,
            evidenceClass: node.evidenceClass, reasonCode: terminal.reasonCode, failures,
            primaryFailureRefs: terminal.primaryFailureRefs, blockedBy,
            attemptReceiptRef: terminal.attemptReceiptRef, replayPlanRef: terminal.replayPlanRef,
            focusedReplayCommand, upstreamReplayRefs: blockedBy.map((id) => ({ producerId: id,
                replayPlanRef: terminals.get(id).replayPlanRef })), logRefs: terminal.logRefs,
            artifactRefs: terminal.artifactRefs, evidenceRefs: terminal.evidenceRefs,
            firstFailurePreserved: replayStates.has(terminal.terminalState) });
    }
    const groups = [];
    for (const producer of producers.filter((entry) => entry.focusedReplayCommand !== null))
    {
        let group = groups.find((ids) => ids.every((id) => !replayConflict(byId.get(id), byId.get(producer.producerId), byId)));
        if (!group)
        {
            group = [];
            groups.push(group);
        }
        group.push(producer.producerId);
    }
    return sealProjection({ schema: 'fsusblog.failure-navigation-material.v1', context,
        aggregateRef: material.aggregateRef, graphRef: graph.graphRef, dagDigest: graph.dagDigest,
        producers, recommendedIndependentReplayGroups: groups });
}

export function renderFailureNavigationMaterial(projection, hostLimits)
{
    const material = admitMaterial(projection, hostLimits);
    checkProjectionDigest(material);
    return material.producers.filter((producer) => producer.terminalState !== 'success').map((producer) =>
        `${producer.producerId}: ${producer.terminalState}${producer.reasonCode ? ` (${producer.reasonCode})` : ''}`
        + (producer.blockedBy.length ? ` blockedBy=${producer.blockedBy.join(',')}` : '')
        + (producer.focusedReplayCommand ? `\n  ${producer.focusedReplayCommand}` : '')).join('\n');
}

/** No candidate flags, callbacks or display digest can supply the missing verifier bridge. */
export function publishVerifiedFailureNavigation()
{
    throw new Error('verified aggregate/attempt authority bridge unavailable; DATA_ONLY navigation cannot be published as current-run evidence');
}
