/** Fixture orchestrator terminal states (issue #1709). One execution, one machine. */

export const FIXTURE_TERMINAL_STATES = Object.freeze([
    'planned',
    'preparing',
    'prepared',
    'verifying',
    'verified',
    'cleaning',
    'cleaned',
    'failed',
    'cleanup-failed'
]);

const transitions = Object.freeze({
    planned: Object.freeze(['preparing', 'failed']),
    preparing: Object.freeze(['prepared', 'cleaning', 'failed']),
    prepared: Object.freeze(['verifying', 'cleaning', 'failed']),
    verifying: Object.freeze(['verified', 'cleaning', 'failed']),
    verified: Object.freeze(['cleaning', 'failed']),
    cleaning: Object.freeze(['cleaned', 'cleanup-failed']),
    cleaned: Object.freeze([]),
    failed: Object.freeze(['cleaning']),
    'cleanup-failed': Object.freeze([])
});

export function createTerminalState(initial = 'planned')
{
    if (!FIXTURE_TERMINAL_STATES.includes(initial))
    {
        throw new Error(`unknown fixture terminal state: ${initial}`);
    }
    let state = initial;
    const history = [initial];
    return {
        get state()
        {
            return state;
        },
        get history()
        {
            return Object.freeze([...history]);
        },
        transition(next)
        {
            if (!FIXTURE_TERMINAL_STATES.includes(next))
            {
                throw new Error(`unknown fixture terminal state: ${next}`);
            }
            const allowed = transitions[state] ?? [];
            if (!allowed.includes(next))
            {
                throw new Error(`illegal fixture terminal transition ${state} -> ${next}`);
            }
            state = next;
            history.push(next);
            return state;
        },
        /** Fail-closed: never publish prepared/verified from a partial or failed path. */
        assertPublishable(kind)
        {
            if (kind === 'prepared' && state !== 'prepared' && state !== 'verifying' && state !== 'verified')
            {
                throw new Error(`partial result cannot be published as prepared (state=${state})`);
            }
            if (kind === 'verified' && state !== 'verified')
            {
                throw new Error(`partial result cannot be published as verified (state=${state})`);
            }
        }
    };
}

export function isTerminalFailure(state)
{
    return state === 'failed' || state === 'cleanup-failed';
}
