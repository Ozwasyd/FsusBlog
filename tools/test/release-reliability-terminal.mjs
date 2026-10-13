export const canonicalTerminalScenarioIds = Object.freeze([
    'release-soak-min',
    'release-load-peak',
    'release-load-burst',
    'release-data-scale-m',
    'release-mutation-critical-slice',
    'release-memory-leak-budget',
    'release-open-handle-budget'
]);

export function scenarioTerminalEvent(result)
{
    if (!canonicalTerminalScenarioIds.includes(result?.scenarioId)
        || typeof result.producerSpawned !== 'boolean'
        || !['passed', 'failed', 'timed-out', 'cancelled', 'not-reached'].includes(result.status))
    {
        throw new Error('terminal event requires a canonical scenario and explicit producer state');
    }
    const spawned = result.producerSpawned;
    const evidence = result.authoritativeEvidence ?? null;
    if (!spawned && evidence)
    {
        throw new Error('unspawned producer cannot have authoritative evidence');
    }
    const failure = result.firstFailure;
    const measurement = result.lifecycle?.actions?.find(action => action.phase === 'measurement');
    let classification;
    if (result.status === 'not-reached')
    {
        if (spawned || evidence || result.lifecycle?.actions?.length)
        {
            throw new Error('not-reached scenario contains execution or authoritative evidence');
        }
        classification = 'not-reached';
    }
    else if (result.status === 'timed-out' || result.producer?.timedOut)
    {
        classification = 'infra-no-conclusion';
    }
    else if (result.status === 'cancelled' || result.cancellation || result.producer?.signal)
    {
        classification = 'cancelled';
    }
    else if (failure?.classification === 'infra.noisy-measurement-window'
        || measurement?.failureEvidence?.classification === 'infra-no-conclusion')
    {
        classification = 'infra-no-conclusion';
    }
    else if (!spawned)
    {
        classification = 'precondition-failure';
    }
    else if (result.status === 'passed' && result.evidenceClass === 'correctness'
        && result.qualificationEligible === true && evidence
        && result.cleanupFailures?.length === 0 && !failure)
    {
        classification = 'qualified-success';
    }
    else if (measurement?.failureEvidence?.classification === 'product-failure'
        && evidence?.path === measurement.failureEvidence.path
        && evidence?.digest === measurement.failureEvidence.bytesDigest
        && failure?.phase === 'measurement' && !measurement.timedOut
        && measurement.processTreeReceipt?.postObservation === 'zero-members')
    {
        classification = 'product-failure';
    }
    else
    {
        classification = 'infra-no-conclusion';
    }
    const successful = classification === 'qualified-success';
    const retainedEvidence = ['qualified-success', 'product-failure', 'infra-no-conclusion'].includes(classification)
        ? evidence : null;
    return {
        scenarioId: result.scenarioId,
        terminalClassification: classification,
        reachedPhase: classification === 'not-reached' ? 'not-reached'
            : failure?.phase ?? result.lifecycle?.actions?.filter(action => action.status !== 'not-run').at(-1)?.phase ?? 'admission',
        producerSpawned: spawned,
        exitCode: result.producer?.exitCode ?? null,
        signal: result.producer?.signal ?? null,
        authoritativeEvidence: retainedEvidence,
        firstBlockingReason: successful ? null : failure?.message ?? result.failure ?? 'execution is not qualification eligible',
        lifecycleReceipts: (result.lifecycle?.actions ?? []).flatMap(action =>
            [action.receipt, action.processTreeReceipt].filter(Boolean)),
        startedAt: classification === 'not-reached' ? null : result.startedAt,
        finishedAt: result.finishedAt
    };
}

export function createTerminalEvents(results)
{
    if (!Array.isArray(results) || results.length !== canonicalTerminalScenarioIds.length
        || new Set(results.map(result => result.scenarioId)).size !== results.length
        || results.some(result => !canonicalTerminalScenarioIds.includes(result.scenarioId)))
    {
        throw new Error('terminal timeline must contain exactly seven unique canonical scenarios');
    }
    return canonicalTerminalScenarioIds.map(id => scenarioTerminalEvent(results.find(result => result.scenarioId === id)));
}

export function verifyTerminalEvents(events, results)
{
    const expected = createTerminalEvents(results);
    if (JSON.stringify(events) !== JSON.stringify(expected))
    {
        throw new Error('terminal classifications, canonical order or producer/evidence attribution differ from sealed results');
    }
    return true;
}
