import {
    createTemporalContract,
    fail,
    plainObject,
    requiredText
} from './temporal-context-contract.mjs';

const requiredFieldsByKind = Object.freeze({
    backend: Object.freeze(['businessEpochUtc', 'backendCulture', 'postgresTimezone']),
    node: Object.freeze(['businessEpochUtc', 'timezone', 'locale', 'nodeTimezone', 'monotonicClockSource']),
    postgres: Object.freeze(['businessEpochUtc', 'timezone']),
    browser: Object.freeze(['businessEpochUtc', 'browserBusinessEpochUtc', 'timezoneId',
        'locale', 'backendCulture', 'postgresTimezone', 'nodeTimezone'])
});

/** Validate complete source observations with the existing explicit policy/ledger authority. */
export function validateTemporalSourceObservation({ kind, context, observation }, authority)
{
    if (!Object.hasOwn(requiredFieldsByKind, kind))
    {
        fail('temporal.context-invalid', `unsupported temporal source observation kind: ${kind}`);
    }
    const contract = createTemporalContract(authority);
    const normalizedContext = contract.validateTemporalContext(context);
    if (!plainObject(observation))
    {
        fail('temporal.actual-context-missing', `${kind} temporal observation must be an object`);
    }
    // Adapt actual transport aliases only. Never fill an observation from the plan.
    const actual = { ...observation };
    for (const field of requiredFieldsByKind[kind])
    {
        requiredText(actual[field], field, 'temporal.actual-context-missing');
    }
    if (kind === 'browser')
    {
        bindObservedAlias(actual, 'timezoneId', 'timezone');
        bindObservedAlias(actual, 'locale', 'uiLocale');
        if (Object.hasOwn(actual, 'observationBoundary')
            && actual.observationBoundary !== 'browser-runtime')
        {
            fail('temporal.browser-context-mismatch', 'browser observation boundary is not browser-runtime');
        }
        actual.observationBoundary = 'browser-runtime';
    }
    else if (kind === 'postgres')
    {
        bindObservedAlias(actual, 'timezone', 'postgresTimezone');
    }
    return contract.validateTemporalObservations(normalizedContext, actual);
}

function bindObservedAlias(observation, sourceField, contractField)
{
    if (Object.hasOwn(observation, contractField)
        && observation[contractField] !== observation[sourceField])
    {
        fail('temporal.actual-context-mismatch',
            `${sourceField} conflicts with observed ${contractField}`);
    }
    observation[contractField] = observation[sourceField];
}
