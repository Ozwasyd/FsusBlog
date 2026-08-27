import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultRegistryPath = path.join(repositoryRoot, 'config/testing/retry-policy-registry.json');
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const producerIdPattern = /^[a-z][a-z0-9-]*$/u;

export const retryPolicyRegistrySchema = 'fsusblog.retry-policy-registry.v1';
export const attemptReceiptSchema = 'fsusblog.test-attempt-receipt.v1';
export const aggregateAttemptReceiptSchema = 'fsusblog.test-attempt-aggregate-receipt.v1';
export const attemptStatuses = Object.freeze([
    'cancelled',
    'clean-success',
    'failed-no-retry'
]);
export const aggregateStatuses = Object.freeze([
    'cancelled',
    'clean-success',
    'diagnostic-failed-after-retry',
    'diagnostic-recovered-after-allowed-infra-retry',
    'failed-no-retry',
    'recovered-infra-success',
    'unstable-attempt-topology'
]);
export const authorityKinds = Object.freeze([
    'execution-envelope',
    'replay-plan',
    'temporal-context'
]);

const forbiddenStatusAliases = new Set([
    'flaky-pass',
    'ok-after-retry',
    'passed-after-retry',
    'success'
]);

export class AttemptContractError extends Error
{
    constructor(reasonCode, message, details = {})
    {
        super(`${reasonCode}: ${message}`);
        this.name = 'AttemptContractError';
        this.reasonCode = reasonCode;
        this.details = details;
    }
}

function fail(reasonCode, message, details = {})
{
    throw new AttemptContractError(reasonCode, message, details);
}

function plainObject(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, label, reasonCode)
{
    if (!plainObject(value))
    {
        fail(reasonCode, `${label} must be an object`);
    }
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
    if (unknown.length > 0)
    {
        fail(reasonCode, `${label} contains unknown fields: ${unknown.join(', ')}`, { unknown });
    }
}

function requiredText(value, label, reasonCode = 'attempt.contract-invalid')
{
    if (typeof value !== 'string' || !value.trim())
    {
        fail(reasonCode, `${label} is required`);
    }
    return value.trim();
}

function validateDigest(value, label, reasonCode = 'attempt.contract-invalid')
{
    const normalized = requiredText(value, label, reasonCode);
    if (!digestPattern.test(normalized))
    {
        fail(reasonCode, `${label} must be a SHA-256 digest`);
    }
    return normalized;
}

function validateProducerId(value, label = 'producerId')
{
    const normalized = requiredText(value, label);
    if (!producerIdPattern.test(normalized))
    {
        fail('attempt.contract-invalid', `${label} must be a semantic producer ID`);
    }
    return normalized;
}

function validateCommit(value, label = 'sourceCommit')
{
    const normalized = requiredText(value, label);
    if (!/^[0-9a-f]{40}$/u.test(normalized))
    {
        fail('attempt.contract-invalid', `${label} must be a full lowercase commit`);
    }
    return normalized;
}

function sortedUniqueStrings(values, label)
{
    if (!Array.isArray(values))
    {
        fail('attempt.contract-invalid', `${label} must be an array`);
    }
    const normalized = values.map((value, index) => requiredText(value, `${label}[${index}]`));
    const expected = [...new Set(normalized)].sort();
    if (JSON.stringify(normalized) !== JSON.stringify(expected))
    {
        fail('attempt.contract-invalid', `${label} must be sorted and unique`);
    }
    return normalized;
}

function validateTimestamp(value, label)
{
    const normalized = requiredText(value, label);
    if (!Number.isFinite(Date.parse(normalized)) || !normalized.endsWith('Z'))
    {
        fail('attempt.contract-invalid', `${label} must be an RFC3339 UTC timestamp`);
    }
    return normalized;
}

function validateStatus(value, allowed, label)
{
    const normalized = requiredText(value, label);
    if (forbiddenStatusAliases.has(normalized))
    {
        fail('attempt.status-alias-forbidden', `${label} uses forbidden status alias ${normalized}`);
    }
    if (!allowed.includes(normalized))
    {
        fail('attempt.status-unknown', `${label} is not a closed status: ${normalized}`);
    }
    return normalized;
}

export function canonicalJson(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (plainObject(value))
    {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function sha256(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function digestCanonical(value)
{
    return sha256(canonicalJson(value));
}

export function sealContentDigest(value)
{
    const unsigned = { ...value };
    delete unsigned.contentDigest;
    return Object.freeze({ ...unsigned, contentDigest: digestCanonical(unsigned) });
}

function exactEnumSet(values, expected, label)
{
    const normalized = sortedUniqueStrings(values, label);
    const canonicalExpected = [...expected].sort();
    if (JSON.stringify(normalized) !== JSON.stringify(canonicalExpected))
    {
        fail('retry.registry-invalid', `${label} must exactly equal the closed registry enum`);
    }
}

export function validateRetryPolicyRegistry(document)
{
    exactKeys(document, [
        'schema',
        'policyVersion',
        'statuses',
        'classifications',
        'actions',
        'defaultDisposition',
        'policies',
        'producerBindingSources'
    ], 'retry policy registry', 'retry.registry-invalid');
    if (document.schema !== retryPolicyRegistrySchema)
    {
        fail('retry.registry-invalid', `registry schema must be ${retryPolicyRegistrySchema}`);
    }
    requiredText(document.policyVersion, 'policyVersion', 'retry.registry-invalid');
    exactEnumSet(document.statuses, aggregateStatuses, 'statuses');
    exactEnumSet(document.classifications, ['correctness', 'diagnostic', 'restore-transfer'], 'classifications');
    exactEnumSet(document.actions, ['diagnostic-only', 'instrument', 'remove', 'restore-only'], 'actions');
    exactKeys(document.defaultDisposition, ['allowedRetries', 'qualificationEligible', 'retryOn'], 'defaultDisposition', 'retry.registry-invalid');
    if (document.defaultDisposition.allowedRetries !== 0
        || document.defaultDisposition.qualificationEligible !== false
        || !Array.isArray(document.defaultDisposition.retryOn)
        || document.defaultDisposition.retryOn.length !== 0)
    {
        fail('retry.registry-invalid', 'unknown producers must be non-retryable and unqualified');
    }
    if (!Array.isArray(document.policies) || document.policies.length === 0)
    {
        fail('retry.registry-invalid', 'policies must be a non-empty array');
    }
    const policies = new Map();
    for (const policy of document.policies)
    {
        exactKeys(policy, [
            'id',
            'classification',
            'allowedRetries',
            'retryOn',
            'firstFailureBlocksQualification',
            'successClassification',
            'recoveredClassification',
            'qualificationSemantics',
            'owner'
        ], 'retry policy', 'retry.registry-invalid');
        const id = validateProducerId(policy.id, 'policy.id');
        if (policies.has(id))
        {
            fail('retry.registry-invalid', `duplicate policy ID: ${id}`);
        }
        if (!document.classifications.includes(policy.classification))
        {
            fail('retry.registry-invalid', `${id} has unknown classification`);
        }
        if (!Number.isInteger(policy.allowedRetries) || policy.allowedRetries < 0 || policy.allowedRetries > 1)
        {
            fail('retry.registry-invalid', `${id}.allowedRetries must be 0 or 1`);
        }
        const retryOn = sortedUniqueStrings(policy.retryOn, `${id}.retryOn`);
        if (policy.classification === 'correctness' && (policy.allowedRetries !== 0 || retryOn.length !== 0))
        {
            fail('retry.correctness-retry-forbidden', `${id} correctness policy must not retry`);
        }
        if (policy.classification === 'diagnostic'
            && (policy.allowedRetries !== 1 || retryOn.length !== 1 || retryOn[0] !== 'browser-process-crash'))
        {
            fail('retry.diagnostic-policy-invalid', `${id} diagnostic retry must be the exact browser-process-crash kind`);
        }
        if (policy.classification === 'restore-transfer'
            && (policy.allowedRetries !== 1 || retryOn.length === 0))
        {
            fail('retry.restore-policy-invalid', `${id} restore policy must name exact structured infra kinds`);
        }
        if (policy.firstFailureBlocksQualification !== true || policy.successClassification !== 'clean-success')
        {
            fail('retry.registry-invalid', `${id} must preserve first-failure qualification semantics`);
        }
        if (policy.classification === 'correctness' && policy.recoveredClassification !== null)
        {
            fail('retry.correctness-retry-forbidden', `${id} correctness policy cannot define recovered success`);
        }
        if (policy.classification === 'diagnostic'
            && policy.recoveredClassification !== 'diagnostic-recovered-after-allowed-infra-retry')
        {
            fail('retry.diagnostic-policy-invalid', `${id} has invalid recovered status`);
        }
        if (policy.classification === 'restore-transfer'
            && policy.recoveredClassification !== 'recovered-infra-success')
        {
            fail('retry.restore-policy-invalid', `${id} recovered transfer must not be clean`);
        }
        requiredText(policy.qualificationSemantics, `${id}.qualificationSemantics`, 'retry.registry-invalid');
        requiredText(policy.owner, `${id}.owner`, 'retry.registry-invalid');
        policies.set(id, Object.freeze({ ...policy, retryOn: Object.freeze(retryOn) }));
    }
    const sources = sortedUniqueStrings(document.producerBindingSources, 'producerBindingSources');
    return Object.freeze({
        ...document,
        policies,
        producerBindingSources: Object.freeze(sources)
    });
}

export function readRetryPolicyRegistry(file = defaultRegistryPath)
{
    return validateRetryPolicyRegistry(JSON.parse(readFileSync(file, 'utf8')));
}

export function retryPolicyById(policyId, registry = readRetryPolicyRegistry())
{
    const normalized = validateProducerId(policyId, 'retryPolicyId');
    const policy = registry.policies.get(normalized);
    if (!policy)
    {
        fail('retry.policy-unknown', `unknown retry policy: ${normalized}`);
    }
    return policy;
}

function normalizeAuthorityReference(reference)
{
    exactKeys(reference, [
        'kind',
        'artifactPath',
        'artifactDigest',
        'verificationReceiptPath',
        'verificationReceiptDigest'
    ], 'authority reference', 'attempt.external-authority-unverified');
    if (!authorityKinds.includes(reference.kind))
    {
        fail('attempt.external-authority-unverified', `unknown authority kind: ${reference.kind}`);
    }
    return Object.freeze({
        kind: reference.kind,
        artifactPath: requiredText(reference.artifactPath, `${reference.kind}.artifactPath`, 'attempt.external-authority-unverified'),
        artifactDigest: validateDigest(reference.artifactDigest, `${reference.kind}.artifactDigest`, 'attempt.external-authority-unverified'),
        verificationReceiptPath: requiredText(reference.verificationReceiptPath, `${reference.kind}.verificationReceiptPath`, 'attempt.external-authority-unverified'),
        verificationReceiptDigest: validateDigest(reference.verificationReceiptDigest, `${reference.kind}.verificationReceiptDigest`, 'attempt.external-authority-unverified')
    });
}

export function validateExternalAuthorityReferences(references, verifyAuthority, expectedIdentity = null)
{
    if (!Array.isArray(references) || references.length !== authorityKinds.length)
    {
        fail('attempt.external-authority-unverified', 'exactly three external authority references are required');
    }
    if (typeof verifyAuthority !== 'function')
    {
        fail('attempt.external-authority-unverified', 'an external authority verifier is required');
    }
    const normalized = references.map(normalizeAuthorityReference)
        .sort((left, right) => left.kind.localeCompare(right.kind));
    if (JSON.stringify(normalized.map((item) => item.kind)) !== JSON.stringify([...authorityKinds].sort()))
    {
        fail('attempt.external-authority-unverified', 'authority references must include each exact authority kind once');
    }
    for (const reference of normalized)
    {
        const verification = verifyAuthority(reference);
        if (!plainObject(verification)
            || verification.verified !== true
            || verification.authorityDigest !== reference.artifactDigest
            || verification.verificationReceiptDigest !== reference.verificationReceiptDigest)
        {
            fail('attempt.external-authority-unverified', `${reference.kind} was not verified by its external owner`);
        }
        if (expectedIdentity !== null)
        {
            for (const [field, expected] of Object.entries(expectedIdentity))
            {
                if (verification.identity?.[field] !== expected)
                {
                    fail('attempt.external-authority-cross-identity', `${reference.kind} crosses ${field}`);
                }
            }
        }
    }
    return Object.freeze(normalized);
}

const attemptReceiptFields = Object.freeze([
    'schema',
    'producerId',
    'attemptNumber',
    'maxAttempts',
    'sourceCommit',
    'worktreeFingerprint',
    'schedulerRunId',
    'command',
    'commandDigest',
    'executionEnvelopeDigest',
    'replayPlanDigest',
    'temporalContextDigest',
    'authorityReferences',
    'startedAt',
    'finishedAt',
    'durationMs',
    'exitCode',
    'signal',
    'failureClass',
    'failureKind',
    'failedTestIds',
    'executedTestIds',
    'stdoutPath',
    'stderrPath',
    'artifactPaths',
    'artifactDigests',
    'firstFailure',
    'retryDecision',
    'retryPolicyId',
    'status',
    'contentDigest'
]);

export function validateAttemptReceipt(receipt, {
    registry = readRetryPolicyRegistry(),
    verifyAuthority,
    verifyArtifact = null
} = {})
{
    exactKeys(receipt, attemptReceiptFields, 'attempt receipt', 'attempt.contract-invalid');
    if (receipt.schema !== attemptReceiptSchema)
    {
        fail('attempt.contract-invalid', `attempt schema must be ${attemptReceiptSchema}`);
    }
    const producerId = validateProducerId(receipt.producerId);
    const policy = retryPolicyById(receipt.retryPolicyId, registry);
    if (!Number.isInteger(receipt.attemptNumber) || receipt.attemptNumber < 1)
    {
        fail('attempt.order-invalid', 'attemptNumber must start at one');
    }
    if (receipt.maxAttempts !== policy.allowedRetries + 1 || receipt.attemptNumber > receipt.maxAttempts)
    {
        fail('attempt.policy-limit-exceeded', 'attempt count exceeds the exact policy limit');
    }
    validateCommit(receipt.sourceCommit);
    validateDigest(receipt.worktreeFingerprint, 'worktreeFingerprint');
    requiredText(receipt.schedulerRunId, 'schedulerRunId');
    if (!Array.isArray(receipt.command) || receipt.command.length === 0
        || receipt.command.some((item) => typeof item !== 'string'))
    {
        fail('attempt.contract-invalid', 'command must be a non-empty string array');
    }
    if (validateDigest(receipt.commandDigest, 'commandDigest') !== digestCanonical(receipt.command))
    {
        fail('attempt.content-tamper', 'command digest mismatch');
    }
    const authorities = validateExternalAuthorityReferences(receipt.authorityReferences, verifyAuthority, {
        sourceCommit: receipt.sourceCommit,
        worktreeFingerprint: receipt.worktreeFingerprint,
        schedulerRunId: receipt.schedulerRunId,
        producerId: receipt.producerId
    });
    const authorityByKind = new Map(authorities.map((reference) => [reference.kind, reference]));
    for (const [kind, field] of [
        ['execution-envelope', 'executionEnvelopeDigest'],
        ['replay-plan', 'replayPlanDigest'],
        ['temporal-context', 'temporalContextDigest']
    ])
    {
        if (validateDigest(receipt[field], field) !== authorityByKind.get(kind).artifactDigest)
        {
            fail('attempt.external-authority-unverified', `${field} does not match the verified external authority`);
        }
    }
    const started = validateTimestamp(receipt.startedAt, 'startedAt');
    const finished = validateTimestamp(receipt.finishedAt, 'finishedAt');
    if (!Number.isInteger(receipt.durationMs) || receipt.durationMs < 0 || Date.parse(finished) < Date.parse(started))
    {
        fail('attempt.contract-invalid', 'attempt duration/timestamps are invalid');
    }
    if (receipt.exitCode !== null && !Number.isInteger(receipt.exitCode))
    {
        fail('attempt.contract-invalid', 'exitCode must be an integer or null');
    }
    if (receipt.signal !== null && (typeof receipt.signal !== 'string' || !receipt.signal))
    {
        fail('attempt.contract-invalid', 'signal must be a non-empty string or null');
    }
    const status = validateStatus(receipt.status, attemptStatuses, 'status');
    if (status === 'clean-success')
    {
        if (receipt.exitCode !== 0 || receipt.signal !== null || receipt.failureClass !== null
            || receipt.failureKind !== null || receipt.failedTestIds.length !== 0)
        {
            fail('attempt.clean-status-invalid', 'clean success must have an exact clean process outcome');
        }
    }
    else if (receipt.failureClass === null || receipt.failureKind === null)
    {
        fail('attempt.failure-detail-missing', 'terminal failure/cancellation requires structured failure identity');
    }
    sortedUniqueStrings(receipt.failedTestIds, 'failedTestIds');
    sortedUniqueStrings(receipt.executedTestIds, 'executedTestIds');
    const artifactPaths = sortedUniqueStrings(receipt.artifactPaths, 'artifactPaths');
    requiredText(receipt.stdoutPath, 'stdoutPath');
    requiredText(receipt.stderrPath, 'stderrPath');
    if (!plainObject(receipt.artifactDigests)
        || JSON.stringify(Object.keys(receipt.artifactDigests).sort()) !== JSON.stringify(artifactPaths))
    {
        fail('attempt.artifact-reference-invalid', 'artifact digest table must exactly cover artifact paths');
    }
    for (const artifactPath of artifactPaths)
    {
        validateDigest(receipt.artifactDigests[artifactPath], `artifactDigests.${artifactPath}`);
        if (typeof verifyArtifact === 'function'
            && verifyArtifact(artifactPath, receipt.artifactDigests[artifactPath], receipt) !== true)
        {
            fail('attempt.artifact-tamper', `artifact is missing or changed: ${artifactPath}`);
        }
    }
    if (!artifactPaths.includes(receipt.stdoutPath) || !artifactPaths.includes(receipt.stderrPath))
    {
        fail('attempt.log-reference-missing', 'stdout and stderr must be retained as digested artifacts');
    }
    if (typeof receipt.firstFailure !== 'boolean')
    {
        fail('attempt.contract-invalid', 'firstFailure must be boolean');
    }
    if (receipt.attemptNumber === 1 && status !== 'clean-success' && receipt.firstFailure !== true)
    {
        fail('attempt.first-failure-overwritten', 'the first terminal failure must remain marked firstFailure');
    }
    if (status === 'clean-success' && receipt.firstFailure === true)
    {
        fail('attempt.first-failure-overwritten', 'a clean attempt cannot be marked firstFailure');
    }
    if (!['not-applicable', 'policy-authorized', 'policy-denied', 'policy-exhausted'].includes(receipt.retryDecision))
    {
        fail('attempt.contract-invalid', 'retryDecision is not a closed value');
    }
    const unsigned = { ...receipt };
    delete unsigned.contentDigest;
    if (validateDigest(receipt.contentDigest, 'contentDigest') !== digestCanonical(unsigned))
    {
        fail('attempt.content-tamper', 'attempt content digest mismatch');
    }
    return Object.freeze({ ...receipt, producerId, status, policy });
}

const aggregateFields = Object.freeze([
    'schema',
    'producerId',
    'schedulerRunId',
    'sourceCommit',
    'worktreeFingerprint',
    'retryPolicyId',
    'attempts',
    'firstAttemptStatus',
    'finalAttemptStatus',
    'finalClassification',
    'cleanFirstAttempt',
    'qualificationEligible',
    'contentDigest'
]);

function compareAttemptTopology(attempts)
{
    const authorityFields = [
        'executionEnvelopeDigest',
        'replayPlanDigest',
        'temporalContextDigest'
    ];
    if (!attempts.slice(1).every((attempt) => authorityFields.every((field) => (
        attempt[field] === attempts[0][field]
    ))))
    {
        return false;
    }
    const failed = attempts.filter((attempt) => attempt.status !== 'clean-success');
    if (failed.length < 2)
    {
        return true;
    }
    const fields = [
        'failedTestIds',
        'executedTestIds',
        'failureClass',
        'failureKind'
    ];
    const artifactClasses = (attempt) => [...new Set(attempt.artifactPaths.map((item) => (
        path.extname(item) || '<none>'
    )))].sort();
    const baseline = failed[0];
    return failed.slice(1).every((attempt) => fields.every((field) => (
        canonicalJson(attempt[field]) === canonicalJson(baseline[field])
    )) && canonicalJson(artifactClasses(attempt)) === canonicalJson(artifactClasses(baseline)));
}

export function classifyAggregate(policy, attempts)
{
    const first = attempts[0];
    const final = attempts.at(-1);
    if (!compareAttemptTopology(attempts))
    {
        return 'unstable-attempt-topology';
    }
    if (final.status === 'cancelled')
    {
        return 'cancelled';
    }
    if (attempts.length === 1)
    {
        return final.status;
    }
    if (final.status !== 'clean-success')
    {
        return policy.classification === 'diagnostic'
            ? 'diagnostic-failed-after-retry'
            : 'failed-no-retry';
    }
    if (first.status === 'clean-success')
    {
        fail('attempt.order-invalid', 'a second attempt cannot follow clean success');
    }
    return policy.recoveredClassification;
}

export function validateAggregateAttemptReceipt(receipt, {
    registry = readRetryPolicyRegistry(),
    loadAttempt,
    verifyAuthority,
    verifyArtifact = null
} = {})
{
    exactKeys(receipt, aggregateFields, 'aggregate attempt receipt', 'attempt.aggregate-invalid');
    if (receipt.schema !== aggregateAttemptReceiptSchema)
    {
        fail('attempt.aggregate-invalid', `aggregate schema must be ${aggregateAttemptReceiptSchema}`);
    }
    const producerId = validateProducerId(receipt.producerId);
    const policy = retryPolicyById(receipt.retryPolicyId, registry);
    requiredText(receipt.schedulerRunId, 'schedulerRunId');
    validateCommit(receipt.sourceCommit);
    validateDigest(receipt.worktreeFingerprint, 'worktreeFingerprint');
    if (!Array.isArray(receipt.attempts) || receipt.attempts.length === 0
        || receipt.attempts.length > policy.allowedRetries + 1)
    {
        fail('attempt.policy-limit-exceeded', 'aggregate attempts violate policy limits');
    }
    if (typeof loadAttempt !== 'function')
    {
        fail('attempt.aggregate-invalid', 'aggregate verification requires an attempt loader');
    }
    const attempts = receipt.attempts.map((reference, index) =>
    {
        exactKeys(reference, ['attemptNumber', 'path', 'digest'], `attempts[${index}]`, 'attempt.aggregate-invalid');
        if (reference.attemptNumber !== index + 1)
        {
            fail('attempt.order-invalid', 'attempt references must be complete and ordered from one');
        }
        requiredText(reference.path, `attempts[${index}].path`);
        validateDigest(reference.digest, `attempts[${index}].digest`);
        const attempt = validateAttemptReceipt(loadAttempt(reference), {
            registry,
            verifyAuthority,
            verifyArtifact
        });
        if (attempt.contentDigest !== reference.digest || attempt.attemptNumber !== reference.attemptNumber)
        {
            fail('attempt.content-tamper', 'attempt reference digest/number mismatch');
        }
        for (const [field, expected] of [
            ['producerId', producerId],
            ['schedulerRunId', receipt.schedulerRunId],
            ['sourceCommit', receipt.sourceCommit],
            ['worktreeFingerprint', receipt.worktreeFingerprint],
            ['retryPolicyId', receipt.retryPolicyId]
        ])
        {
            if (attempt[field] !== expected)
            {
                fail('attempt.cross-identity', `attempt crosses aggregate ${field}`);
            }
        }
        return attempt;
    });
    const firstStatus = validateStatus(receipt.firstAttemptStatus, attemptStatuses, 'firstAttemptStatus');
    const finalStatus = validateStatus(receipt.finalAttemptStatus, attemptStatuses, 'finalAttemptStatus');
    const finalClassification = validateStatus(receipt.finalClassification, aggregateStatuses, 'finalClassification');
    if (firstStatus !== attempts[0].status || finalStatus !== attempts.at(-1).status)
    {
        fail('attempt.first-failure-overwritten', 'aggregate status does not preserve first/final attempt');
    }
    const expectedClassification = classifyAggregate(policy, attempts);
    if (finalClassification !== expectedClassification)
    {
        fail('attempt.aggregate-invalid', `aggregate classification must be ${expectedClassification}`);
    }
    const cleanFirstAttempt = attempts.length === 1 && attempts[0].status === 'clean-success';
    const qualificationEligible = policy.classification === 'correctness' && cleanFirstAttempt;
    if (receipt.cleanFirstAttempt !== cleanFirstAttempt
        || receipt.qualificationEligible !== qualificationEligible)
    {
        fail('attempt.qualification-invalid', 'cleanFirstAttempt/qualificationEligible are inconsistent');
    }
    const unsigned = { ...receipt };
    delete unsigned.contentDigest;
    if (validateDigest(receipt.contentDigest, 'contentDigest') !== digestCanonical(unsigned))
    {
        fail('attempt.content-tamper', 'aggregate content digest mismatch');
    }
    return Object.freeze({ ...receipt, attempts: Object.freeze(attempts), policy });
}

export function verifyFileDigest(root, relativePath, expectedDigest)
{
    const normalizedRoot = realpathSync(root);
    const candidate = path.resolve(normalizedRoot, relativePath);
    const actual = realpathSync(candidate);
    if (!actual.startsWith(`${normalizedRoot}${path.sep}`))
    {
        fail('attempt.artifact-reference-invalid', `${relativePath} escapes its evidence root`);
    }
    const stat = lstatSync(actual);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        fail('attempt.artifact-reference-invalid', `${relativePath} must be a regular file`);
    }
    return sha256(readFileSync(actual)) === expectedDigest;
}
