const { VitestTestRunner } = await import(new URL('../../src/frontend/node_modules/vitest/dist/runners.js', import.meta.url));
const { GLOBAL_EXPECT, getState } = await import(new URL('../../src/frontend/node_modules/@vitest/expect/dist/index.js', import.meta.url));

/** Observe the original runner state without replacing expect, matchers or hooks. */
export default class FrontendVitestOutcomeRunner extends VitestTestRunner
{
    onBeforeTryTask(task, options)
    {
        super.onBeforeTryTask(task, options);
        const previous = task.meta.fsusOutcomeObservation;
        task.meta.fsusOutcomeObservation = { tries: (previous?.tries ?? 0) + 1, assertionCalls: null,
            executions: previous?.executions ?? [] };
        task.meta.fsusOutcomeObservation.executions.push({ retry: options.retry, repeat: options.repeats,
            errorCountBeforeTry: task.result.errors?.length ?? 0, callback: null, terminal: null });
    }

    snapshot(task)
    {
        const state = task.context._local ? task.context.expect.getState() : getState(globalThis[GLOBAL_EXPECT]);
        const result = task.result;
        return JSON.parse(JSON.stringify({ assertionCalls: state.assertionCalls,
            result: { state: result.state, errors: result.errors ?? [], pending: result.pending === true,
                note: result.note ?? null },
            nativeCounters: { retryCount: result.retryCount ?? null, repeatCount: result.repeatCount ?? null } }));
    }

    onTaskFinished(task)
    {
        // Vitest calls this after the callback's success, failure or ctx.skip,
        // before cleanup assertions and before a retry can rewrite its result.
        const observation = task.meta.fsusOutcomeObservation;
        if (!observation?.executions.length)
        {
            return super.onTaskFinished?.(task);
        }
        observation.executions.at(-1).callback = this.snapshot(task);
        observation.assertionCalls = observation.executions.at(-1).callback.assertionCalls;
        return super.onTaskFinished?.(task);
    }

    onAfterRetryTask(task, options)
    {
        // This hook also runs for dynamic skips, whose final task result is
        // subsequently replaced by Vitest without calling onAfterRunTask.
        const observation = task.meta.fsusOutcomeObservation;
        if (!observation?.executions.length)
        {
            return super.onAfterRetryTask?.(task, options);
        }
        observation.executions.at(-1).terminal = this.snapshot(task);
        return super.onAfterRetryTask?.(task, options);
    }

    onAfterRunTask(task)
    {
        const state = task.context._local ? task.context.expect.getState() : getState(globalThis[GLOBAL_EXPECT]);
        task.meta.fsusOutcomeObservation = { ...task.meta.fsusOutcomeObservation, assertionCalls: state.assertionCalls };
        return super.onAfterRunTask(task);
    }
}
