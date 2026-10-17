import {
    canonicalize,
    digestValue,
    isDigest,
    normalizeFingerprint
} from './browser-contract-receipt-contract.mjs';

export const correctnessProvisionalReceiptSchema = 'fsusblog.browserless-correctness-provisional.v1';

const identityFields = [
    'runId', 'targetTierId', 'targetAttemptId', 'sourceState', 'buildReceiptDigest',
    'createdFromCheckpointRevision'
];
const receiptFields = [
    'schema', 'status', 'qualificationEligible', ...identityFields,
    'dependencyClosureDigest', 'dependencyTerminalReceiptRefs', 'executedTierIds',
    'jobSummaryRefs', 'physicalExecutionRefs', 'contentDigest'
];
const referenceFields = ['ref', 'digest', 'runId', 'targetTierId', 'targetAttemptId'];
const provisionalStates = ['pending', 'admitted', 'running', 'finalizing'];

function fail(label, message)
{
    throw new Error(`correctness provisional ${label}: ${message}`);
}

function closedObject(value, fields, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort()))
    {
        fail(label, `requires exactly ${fields.join(', ')}`);
    }
}

function identity(value, label)
{
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)
        || value === '.' || value === '..' || /(?:^|[-_.])(?:issue|pr)[-_.]?\d+(?:$|[-_.])/iu.test(value))
    {
        fail(label, 'requires an explicit semantic identity');
    }
}

function digest(value, label)
{
    if (typeof value !== 'string' || !isDigest(value))
    {
        fail(label, 'requires a SHA-256 digest');
    }
}

function source(value, label)
{
    closedObject(value, ['commit', 'worktreeFingerprint'], label);
    if (typeof value.commit !== 'string' || typeof value.worktreeFingerprint !== 'string'
        || !/^[a-f0-9]{40}$/u.test(value.commit)
        || !/^[a-f0-9]{64}$/u.test(normalizeFingerprint(value.worktreeFingerprint)))
    {
        fail(label, 'requires exact commit and worktree identities');
    }
}

function equal(left, right, label)
{
    if (JSON.stringify(canonicalize(left)) !== JSON.stringify(canonicalize(right)))
    {
        fail(label, 'identity mismatch');
    }
}

function tierIds(values, label)
{
    if (!Array.isArray(values))
    {
        fail(label, 'requires an explicit array');
    }
    values.forEach((value) => identity(value, label));
    equal(values, [...new Set(values)].sort(), `${label} sorted unique roster`);
}

function reference(value, expected, label)
{
    closedObject(value, referenceFields, label);
    for (const field of ['runId', 'targetTierId', 'targetAttemptId'])
    {
        identity(value[field], `${label}.${field}`);
    }
    digest(value.digest, `${label}.digest`);
    // References are immutable content identities, never mutable paths or selectors.
    equal(value.ref, value.digest, `${label}.ref`);
    equal(value.runId, expected.runId, `${label}.runId`);
}

function references(values, expected, label)
{
    if (!Array.isArray(values))
    {
        fail(label, 'requires an explicit array');
    }
    for (const [index, value] of values.entries())
    {
        const referenceLabel = `${label}[${index}]`;
        reference(value, expected, referenceLabel);
        if (value.targetTierId !== expected.targetTierId
            && !Object.hasOwn(expected.dependencyAttemptIds, value.targetTierId))
        {
            fail(referenceLabel, 'requires a tier in the held tier roster');
        }
        const expectedAttemptId = value.targetTierId === expected.targetTierId
            ? expected.targetAttemptId
            : expected.dependencyAttemptIds[value.targetTierId];
        equal(value.targetAttemptId, expectedAttemptId, `${referenceLabel}.current attempt`);
    }
    const keys = values.map((value) => `${value.targetTierId}:${value.targetAttemptId}:${value.ref}`);
    equal(keys, [...new Set(keys)].sort(), `${label} sorted unique roster`);
}

function validateIdentity(value)
{
    for (const field of ['runId', 'targetTierId', 'targetAttemptId'])
    {
        identity(value[field], field);
    }
    equal(value.targetTierId, 'production-correctness', 'targetTierId');
    source(value.sourceState, 'sourceState');
    digest(value.buildReceiptDigest, 'buildReceiptDigest');
    if (!Number.isSafeInteger(value.createdFromCheckpointRevision) || value.createdFromCheckpointRevision < 1)
    {
        fail('createdFromCheckpointRevision', 'requires a committed checkpoint revision');
    }
}

/** Shared closure verification for provisional construction and later terminal sealing. */
export function verifyCorrectnessDependencyClosure(context)
{
    validateIdentity(context);
    tierIds(context.requiredDependencyTierIds, 'requiredDependencyTierIds');
    if (context.requiredDependencyTierIds.length === 0
        || context.requiredDependencyTierIds.includes(context.targetTierId))
    {
        fail('requiredDependencyTierIds', 'requires the non-empty aggregate dependency closure');
    }
    closedObject(context.dependencyAttemptIds, context.requiredDependencyTierIds, 'dependencyAttemptIds');
    Object.values(context.dependencyAttemptIds).forEach((value) => identity(value, 'dependencyAttemptIds'));
    closedObject(context.dependencyReceiptSchemas, context.requiredDependencyTierIds, 'dependencyReceiptSchemas');
    if (!Array.isArray(context.dependencyTerminalReceipts))
    {
        fail('dependencyTerminalReceipts', 'requires explicit loaded terminal receipts');
    }
    const refs = context.dependencyTerminalReceipts.map((entry, index) =>
    {
        const label = `dependencyTerminalReceipts[${index}]`;
        closedObject(entry, ['reference', 'receipt'], label);
        reference(entry.reference, context, `${label}.reference`);
        const value = entry.receipt;
        if (!value || typeof value.schema !== 'string' || !value.schema
            || value.status !== 'success' || value.contentDigest !== digestValue(value))
        {
            fail(label, 'requires a content-validated terminal success receipt');
        }
        equal(value.schema, context.dependencyReceiptSchemas[entry.reference.targetTierId], `${label}.schema`);
        equal(entry.reference.digest, value.contentDigest, `${label}.digest`);
        for (const field of ['runId', 'targetTierId', 'targetAttemptId'])
        {
            equal(entry.reference[field], value[field], `${label}.${field}`);
        }
        equal(value.targetAttemptId, context.dependencyAttemptIds[value.targetTierId], `${label}.current attempt`);
        equal(value.sourceState, context.sourceState, `${label}.sourceState`);
        equal(value.buildReceiptDigest, context.buildReceiptDigest, `${label}.buildReceiptDigest`);
        return structuredClone(entry.reference);
    });
    references(refs, context, 'dependencyTerminalReceiptRefs');
    equal(refs.map((value) => value.targetTierId), context.requiredDependencyTierIds, 'dependency closure roster');
    return {
        dependencyTerminalReceiptRefs: refs,
        dependencyClosureDigest: digestValue({
            runId: context.runId,
            targetTierId: context.targetTierId,
            sourceState: context.sourceState,
            buildReceiptDigest: context.buildReceiptDigest,
            dependencyTerminalReceiptRefs: refs
        })
    };
}

/** Pure builder: callers supply exact loaded documents; it never discovers or reads evidence. */
export function createCorrectnessProvisionalReceipt(context)
{
    closedObject(context, [
        ...identityFields, 'aggregateStatus', 'requiredDependencyTierIds', 'dependencyAttemptIds',
        'dependencyReceiptSchemas', 'dependencyTerminalReceipts',
        'executedTierIds', 'jobSummaryRefs', 'physicalExecutionRefs'
    ], 'builder input');
    if (!provisionalStates.includes(context.aggregateStatus))
    {
        fail('aggregateStatus', 'requires pending, admitted, running or finalizing');
    }
    const closure = verifyCorrectnessDependencyClosure(context);
    const value = {
        schema: correctnessProvisionalReceiptSchema,
        status: 'provisional',
        qualificationEligible: false,
        ...Object.fromEntries(identityFields.map((field) => [field, structuredClone(context[field])])),
        ...closure,
        executedTierIds: structuredClone(context.executedTierIds),
        jobSummaryRefs: structuredClone(context.jobSummaryRefs),
        physicalExecutionRefs: structuredClone(context.physicalExecutionRefs),
        contentDigest: null
    };
    value.contentDigest = digestValue(value);
    validateCorrectnessProvisionalReceipt(value, context);
    return value;
}

/** Context is mandatory so a correctly rehashed receipt cannot cross run/attempt/closure boundaries. */
export function validateCorrectnessProvisionalReceipt(value, context)
{
    closedObject(value, receiptFields, 'receipt');
    validateIdentity(value);
    equal(value.schema, correctnessProvisionalReceiptSchema, 'schema');
    equal(value.status, 'provisional', 'status');
    equal(value.qualificationEligible, false, 'qualificationEligible');
    for (const field of identityFields)
    {
        equal(value[field], context?.[field], field);
    }
    const closure = verifyCorrectnessDependencyClosure(context);
    equal(value.dependencyTerminalReceiptRefs, closure.dependencyTerminalReceiptRefs, 'dependencyTerminalReceiptRefs');
    equal(value.dependencyClosureDigest, closure.dependencyClosureDigest, 'dependencyClosureDigest');
    tierIds(value.executedTierIds, 'executedTierIds');
    equal(value.executedTierIds, [...context.requiredDependencyTierIds, context.targetTierId].sort(), 'executedTierIds');
    references(value.jobSummaryRefs, context, 'jobSummaryRefs');
    references(value.physicalExecutionRefs, context, 'physicalExecutionRefs');
    for (const field of ['jobSummaryRefs', 'physicalExecutionRefs'])
    {
        equal(value[field], context[field], field);
    }
    digest(value.contentDigest, 'contentDigest');
    equal(value.contentDigest, digestValue(value), 'contentDigest');
    return value;
}
