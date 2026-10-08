const { VitestTestRunner } = await import(new URL('../../src/frontend/node_modules/vitest/dist/runners.js', import.meta.url));
const { GLOBAL_EXPECT, getState } = await import(new URL('../../src/frontend/node_modules/@vitest/expect/dist/index.js', import.meta.url));

/** Observe the original runner state without replacing expect, matchers or hooks. */
export default class FrontendVitestOutcomeRunner extends VitestTestRunner
{
    onBeforeTryTask(task)
    {
        super.onBeforeTryTask(task);
        const previous = task.meta.fsusOutcomeObservation;
        task.meta.fsusOutcomeObservation = { tries: (previous?.tries ?? 0) + 1, assertionCalls: null };
    }

    onAfterRunTask(task)
    {
        const state = task.context._local ? task.context.expect.getState() : getState(globalThis[GLOBAL_EXPECT]);
        task.meta.fsusOutcomeObservation = { ...task.meta.fsusOutcomeObservation, assertionCalls: state.assertionCalls };
        return super.onAfterRunTask(task);
    }
}
