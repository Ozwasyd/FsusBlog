import { createHash } from 'node:crypto';

export const ORACLE_FACTS_SCHEMA = 'fsusblog.test-oracle-facts.v1';
export const QUALITY_POLICY_SCHEMA = 'fsusblog.test-quality-policy.v1';
export const QUALITY_ARTIFACT_SCHEMA = 'fsusblog.test-quality.v2';
export const REPLACEMENT_TRANSACTION_SCHEMA = 'fsusblog.test-replacement-transaction.v1';

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const positionKeys = new Set(['line', 'column']);
const spanKeys = new Set(['start', 'end']);

export function canonicalStringify(value)
{
    if (value === null || typeof value !== 'object')
    {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map(canonicalStringify).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}
export function contentDigest(value, omittedKey = 'contentDigest')
{
    const unsigned = structuredClone(value);
    delete unsigned[omittedKey];
    return `sha256:${createHash('sha256').update(canonicalStringify(unsigned)).digest('hex')}`;
}

function fail(label, message)
{
    throw new Error(`${label}: ${message}`);
}

function closed(value, keys, label)
{
    if (value === null || typeof value !== 'object' || Array.isArray(value))
    {
        fail(label, 'must be an object');
    }
    for (const key of Object.keys(value))
    {
        if (!keys.has(key))
        {
            fail(label, `contains unknown field ${key}`);
        }
    }
}

function string(value, label, { nullable = false } = {})
{
    if (nullable && value === null)
    {
        return;
    }
    if (typeof value !== 'string' || value.trim() === '')
    {
        fail(label, 'must be a non-empty string');
    }
}

function stringArray(value, label)
{
    if (!Array.isArray(value))
    {
        fail(label, 'must be an array');
    }
    for (const [index, item] of value.entries())
    {
        string(item, `${label}[${index}]`);
    }
    if (new Set(value).size !== value.length)
    {
        fail(label, 'must not contain duplicates');
    }
}

function digest(value, label)
{
    if (!digestPattern.test(String(value ?? '')))
    {
        fail(label, 'must be a sha256 digest');
    }
}

function span(value, label)
{
    closed(value, spanKeys, label);
    for (const side of ['start', 'end'])
    {
        closed(value[side], positionKeys, `${label}.${side}`);
        for (const axis of ['line', 'column'])
        {
            if (!Number.isInteger(value[side][axis]) || value[side][axis] < 1)
            {
                fail(`${label}.${side}.${axis}`, 'must be a positive integer');
            }
        }
    }
}

const operandKeys = new Set(['kind', 'text', 'symbol', 'source']);
const assertionKeys = new Set([
    'apiId',
    'matcher',
    'operator',
    'actual',
    'expected',
    'message',
    'sourceSpan',
    'reachability',
    'helperChain'
]);
const callKeys = new Set(['methodName', 'containingType', 'assembly', 'assemblyKind', 'sourceSpan']);
const controlFlowKeys = new Set([
    'normalPathCount',
    'observedNormalPathCount',
    'allNormalPathsObserved',
    'earlyExits',
    'conditionalAssertions',
    'loopOrTableCoverage',
    'dynamicObligation'
]);
const caseKeys = new Set([
    'testId',
    'displayName',
    'ownerFile',
    'adapter',
    'identity',
    'sourceSpan',
    'status',
    'assertions',
    'explicitFailures',
    'expectedOutcomes',
    'observations',
    'calls',
    'testInvocations',
    'controlFlow',
    'diagnostics'
]);
const observationsKeys = new Set([
    'return',
    'state',
    'collaborator',
    'log',
    'filesystem',
    'network',
    'process',
    'evidence'
]);
const callsKeys = new Set(['production', 'testHelper', 'bcl', 'thirdParty']);
const rootOracleKeys = new Set([
    'schema',
    'analyzerVersion',
    'inventoryDigest',
    'adapterVersion',
    'sourceDigests',
    'cases',
    'diagnostics',
    'contentDigest'
]);

function validateOperand(value, label)
{
    if (value === null)
    {
        return;
    }
    closed(value, operandKeys, label);
    string(value.kind, `${label}.kind`);
    string(value.text, `${label}.text`);
    if (value.symbol !== undefined)
    {
        string(value.symbol, `${label}.symbol`);
    }
    if (value.source !== undefined)
    {
        string(value.source, `${label}.source`);
    }
}

function validateAssertion(value, label)
{
    closed(value, assertionKeys, label);
    string(value.apiId, `${label}.apiId`);
    string(value.matcher, `${label}.matcher`);
    string(value.operator, `${label}.operator`);
    validateOperand(value.actual, `${label}.actual`);
    validateOperand(value.expected, `${label}.expected`);
    if (value.message !== null)
    {
        string(value.message, `${label}.message`);
    }
    span(value.sourceSpan, `${label}.sourceSpan`);
    if (!new Set(['reachable', 'conditional', 'unreachable', 'unknown']).has(value.reachability))
    {
        fail(`${label}.reachability`, 'is not a closed reachability value');
    }
    stringArray(value.helperChain, `${label}.helperChain`);
}

function validateCall(value, label)
{
    closed(value, callKeys, label);
    string(value.methodName, `${label}.methodName`);
    string(value.containingType, `${label}.containingType`, { nullable: true });
    string(value.assembly, `${label}.assembly`, { nullable: true });
    string(value.assemblyKind, `${label}.assemblyKind`);
    if (value.sourceSpan !== null)
    {
        span(value.sourceSpan, `${label}.sourceSpan`);
    }
}

function validateCase(value, label)
{
    closed(value, caseKeys, label);
    for (const key of ['testId', 'displayName', 'ownerFile', 'adapter', 'identity', 'status'])
    {
        string(value[key], `${label}.${key}`);
    }
    span(value.sourceSpan, `${label}.sourceSpan`);
    if (!new Set(['resolved', 'unknown', 'dynamic-obligation']).has(value.status))
    {
        fail(`${label}.status`, 'is not a closed case status');
    }
    for (const [index, assertion] of value.assertions.entries())
    {
        validateAssertion(assertion, `${label}.assertions[${index}]`);
    }
    stringArray(value.explicitFailures, `${label}.explicitFailures`);
    stringArray(value.expectedOutcomes, `${label}.expectedOutcomes`);
    closed(value.observations, observationsKeys, `${label}.observations`);
    for (const key of observationsKeys)
    {
        stringArray(value.observations[key], `${label}.observations.${key}`);
    }
    closed(value.calls, callsKeys, `${label}.calls`);
    for (const key of callsKeys)
    {
        for (const [index, call] of value.calls[key].entries())
        {
            validateCall(call, `${label}.calls.${key}[${index}]`);
        }
    }
    stringArray(value.testInvocations, `${label}.testInvocations`);
    closed(value.controlFlow, controlFlowKeys, `${label}.controlFlow`);
    for (const key of ['normalPathCount', 'observedNormalPathCount'])
    {
        if (!Number.isInteger(value.controlFlow[key]) || value.controlFlow[key] < 0)
        {
            fail(`${label}.controlFlow.${key}`, 'must be a non-negative integer');
        }
    }
    if (value.controlFlow.allNormalPathsObserved !== null
        && typeof value.controlFlow.allNormalPathsObserved !== 'boolean')
    {
        fail(`${label}.controlFlow.allNormalPathsObserved`, 'must be boolean or null');
    }
    stringArray(value.controlFlow.earlyExits, `${label}.controlFlow.earlyExits`);
    stringArray(value.controlFlow.conditionalAssertions, `${label}.controlFlow.conditionalAssertions`);
    stringArray(value.controlFlow.loopOrTableCoverage, `${label}.controlFlow.loopOrTableCoverage`);
    if (value.controlFlow.dynamicObligation !== null)
    {
        string(value.controlFlow.dynamicObligation, `${label}.controlFlow.dynamicObligation`);
    }
    stringArray(value.diagnostics, `${label}.diagnostics`);
}

export function validateOracleFacts(value)
{
    closed(value, rootOracleKeys, 'oracle facts');
    if (value.schema !== ORACLE_FACTS_SCHEMA)
    {
        fail('oracle facts.schema', `must equal ${ORACLE_FACTS_SCHEMA}`);
    }
    string(value.analyzerVersion, 'oracle facts.analyzerVersion');
    digest(value.inventoryDigest, 'oracle facts.inventoryDigest');
    string(value.adapterVersion, 'oracle facts.adapterVersion');
    closed(value.sourceDigests, new Set(Object.keys(value.sourceDigests ?? {})), 'oracle facts.sourceDigests');
    for (const [source, sourceDigest] of Object.entries(value.sourceDigests))
    {
        string(source, 'oracle facts source path');
        digest(sourceDigest, `oracle facts.sourceDigests.${source}`);
    }
    if (!Array.isArray(value.cases))
    {
        fail('oracle facts.cases', 'must be an array');
    }
    const ids = new Set();
    for (const [index, testCase] of value.cases.entries())
    {
        validateCase(testCase, `oracle facts.cases[${index}]`);
        if (ids.has(testCase.testId))
        {
            fail('oracle facts.cases', `contains duplicate test ID ${testCase.testId}`);
        }
        ids.add(testCase.testId);
    }
    stringArray(value.diagnostics, 'oracle facts.diagnostics');
    digest(value.contentDigest, 'oracle facts.contentDigest');
    if (contentDigest(value) !== value.contentDigest)
    {
        fail('oracle facts.contentDigest', 'does not match the deterministic payload');
    }
    return value;
}

export function assertDigest(value, label)
{
    digest(value, label);
}
