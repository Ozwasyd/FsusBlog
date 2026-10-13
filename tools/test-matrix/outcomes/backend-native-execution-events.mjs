/**
 * Preserve actual reporter callbacks and the existing parent's process result.
 * This diagnostic projection grants no semantic or attempt qualification.
 */
export function buildBackendNativeExecutionEvents({ plan, manifest, results, inputReferences, executionReferences })
{
    const workers = results.map((result) =>
    {
        const tests = result.slot.collections.flatMap((collection) => collection.tests);
        const canonicalByCase = new Map(tests.map((test) => [test.testCaseUniqueId, test.canonicalTestId]));
        const reference = (event) => ({ ...result.journal.reference, sequence: event.sequence });
        const events = result.journal.events.map((event) => ({
            reference: reference(event), native: event,
            canonicalTestId: canonicalByCase.get(event.payload.testCaseUniqueId) ?? null
        }));
        const starts = events.filter((event) => event.native.kind === 'test-started');
        const outcomes = events.filter((event) => event.native.kind === 'test-outcome');
        const failures = events.filter((event) => event.native.kind === 'test-failure');
        const testKey = (event) => JSON.stringify([event.native.payload.testUniqueId, event.native.payload.testCaseUniqueId]);
        const completedTests = new Set(outcomes.map(testKey));
        const first = outcomes.find((event) => event.native.payload.outcome === 'failed');
        const structuredFailure = first ? failures.find((event) =>
            event.native.payload.testUniqueId === first.native.payload.testUniqueId
            && event.native.payload.testCaseUniqueId === first.native.payload.testCaseUniqueId) : null;
        const observedCases = new Set([...starts, ...outcomes].map((event) => event.native.payload.testCaseUniqueId));
        return {
            slotId: result.slot.id, processId: result.pid,
            attemptContext: result.processResult.attemptContext,
            terminal: { exitCode: result.code, signal: result.signal, finishedAt: result.processResult.finishedAt },
            processReference: result.processReference, queueReference: result.processResult.queueReference,
            journal: result.processResult.journal, finalReceiptReference: result.processResult.finalReceiptReference,
            events,
            firstFailure: first ? { outcomeReference: first.reference, canonicalTestId: first.canonicalTestId,
                testUniqueId: first.native.payload.testUniqueId, testCaseUniqueId: first.native.payload.testCaseUniqueId,
                structuredFailureReference: structuredFailure?.reference ?? null,
                structuredFailure: structuredFailure?.native.payload ?? null } : null,
            incompleteStarts: starts.filter((start) => !completedTests.has(testKey(start))),
            queuedCasesWithoutCallbacks: tests.filter((test) => !observedCases.has(test.testCaseUniqueId))
                .map((test) => ({ testCaseUniqueId: test.testCaseUniqueId, canonicalTestId: test.canonicalTestId }))
        };
    });
    return {
        schema: 'fsusblog.backend-native-execution-events.v1', qualificationEligible: false,
        planDigest: plan.planDigest, source: plan.source, producer: plan.producer, run: plan.run,
        queueManifestDigest: manifest.contentDigest, inputReferences, executionReferences, workers
    };
}
