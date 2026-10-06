const { qualificationTemporalContext, defaultTimeoutPolicyDigest } = await import(new URL('../../../tools/test/temporal-context.mjs', import.meta.url));
const { bindCorrectnessProducerTemporalArtifacts } = await import(new URL('../../../tools/test/temporal-producer-bindings.mjs', import.meta.url));

// Synthetic unit-test observations only; this helper never qualifies a live browser run.
export function createBrowserTemporalFixture({ sourceState, runId, locale = 'zh-CN' })
{
    const context = qualificationTemporalContext({
        sourceCommit: sourceState.commit,
        sourceFingerprint: `sha256:${sourceState.worktreeFingerprint.replace(/^sha256:/u, '')}`,
        producerId: 'comment-moderation',
        schedulerRunId: runId,
        businessEpochUtc: '2026-08-30T00:00:00.000Z',
        locale,
        uiLocale: locale,
        timeoutPolicyDigest: defaultTimeoutPolicyDigest()
    });
    const temporal = bindCorrectnessProducerTemporalArtifacts({
        producerId: context.producerId,
        contextInput: context,
        observations: {
            businessEpochUtc: context.businessEpochUtc,
            browserBusinessEpochUtc: context.businessEpochUtc,
            timezone: 'UTC',
            locale,
            uiLocale: locale,
            backendCulture: 'Invariant',
            postgresTimezone: 'UTC',
            nodeTimezone: 'UTC',
            observationBoundary: 'browser-runtime',
            monotonicClockSource: 'performance-now'
        },
        outcome: { fixture: 'browser-temporal-unit-test' },
        generatedAt: '2026-08-30T00:00:01.000Z'
    });
    return {
        plan: temporal.plan,
        actual: temporal.actual,
        receipt: temporal.receipt,
        bindingDigest: temporal.bindingDigest
    };
}
