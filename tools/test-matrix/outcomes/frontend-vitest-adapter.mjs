import { types } from 'node:util';

import { exactIds } from './adapter-support.mjs';
import { readOutcomeFailureTaxonomy, sealProducerSemanticOutcomeCandidate,
    validateProducerSemanticOutcomeCandidate } from './outcome-contract.mjs';

const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
const { canonicalTestId, validateReplayPlan } = await import(new URL('../../test/execution-replay-contract.mjs', import.meta.url));
const authorityId = 'tools/test-matrix/outcomes/frontend-vitest-adapter.mjs';
const statuses = ['passed', 'failed', 'skipped', 'blocked'];
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

export const frontendVitestOutcomeProducerId = 'frontend-vitest';
export const frontendVitestManifestSchema = 'fsusblog.frontend-vitest-outcome-manifest.v1';
export const frontendVitestEvidenceSchema = 'fsusblog.frontend-vitest-outcome-evidence.v1';

function requireValue(condition, label)
{
    if (!condition)
    {
        throw new Error(`frontend Vitest outcome: ${label}`);
    }
}

function exact(value, keys, label)
{
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} fields mismatch`);
}

function equal(actual, expected, label)
{
    requireValue(digestCanonical(actual) === digestCanonical(expected), `${label} mismatch`);
}

function digest(value, label)
{
    requireValue(typeof value === 'string' && digestPattern.test(value), `${label} must be SHA-256`);
}

// Validate descriptors before hashing external JSON; never invoke getters/toJSON.
function inspectJson(value, limits)
{
    exact(limits, ['maxDepth', 'maxNodes', 'maxStringBytes'], 'hostExpectedLimits');
    requireValue(Object.values(limits).every((item) => Number.isSafeInteger(item) && item > 0), 'invalid host budgets');
    let nodes = 0;
    let bytes = 0;
    const active = new WeakSet();
    function visit(item, depth)
    {
        nodes += 1;
        requireValue(nodes <= limits.maxNodes && depth <= limits.maxDepth, 'JSON expansion budget exceeded');
        if (typeof item === 'string')
        {
            bytes += Buffer.byteLength(item);
            requireValue(bytes <= limits.maxStringBytes, 'JSON byte budget exceeded');
            return;
        }
        if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)))
        {
            return;
        }
        requireValue(typeof item === 'object' && !types.isProxy(item) && !active.has(item), 'non-JSON or cyclic input');
        const array = Array.isArray(item);
        requireValue(Object.getPrototypeOf(item) === (array ? Array.prototype : Object.prototype), 'nonplain input');
        const descriptors = Object.getOwnPropertyDescriptors(item);
        const keys = Reflect.ownKeys(descriptors);
        requireValue(keys.every((key) => typeof key === 'string'), 'symbol input');
        if (array)
        {
            requireValue(keys.length === item.length + 1 && item.length <= limits.maxNodes
                && keys.filter((key) => key !== 'length').every((key) => /^(0|[1-9][0-9]*)$/u.test(key)
                    && Number(key) < item.length), 'sparse or expanded array');
        }
        active.add(item);
        for (const key of keys.filter((key) => !array || key !== 'length'))
        {
            const descriptor = descriptors[key];
            requireValue(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'accessor input');
            visit(key, depth + 1);
            visit(descriptor.value, depth + 1);
        }
        active.delete(item);
    }
    visit(value, 0);
}

function sealed(document, expectedDigest, label)
{
    digest(expectedDigest, `external ${label} digest`);
    const { contentDigest, ...unsigned } = document;
    equal(contentDigest, expectedDigest, `external ${label} digest`);
    equal(contentDigest, digestCanonical(unsigned), `${label} content digest`);
}

/**
 * Derive replay identities from source-owned declaration IDs and explicit semantic
 * case IDs. Display titles, native task IDs, line numbers and report order are not inputs.
 */
export function frontendVitestTestIdentity(suite, test)
{
    return canonicalTestId({ framework: 'vitest', source: suite.source,
        name: [suite.declarationId, test.declarationId],
        caseIdentity: test.caseId === null ? null : { kind: 'parameterized', id: test.caseId } });
}

/** Derive a suite ID from the same source-owned replay identity primitive. */
export function frontendVitestSuiteIdentity(suite)
{
    return canonicalTestId({ framework: 'vitest', source: suite.source, name: suite.declarationId });
}

function manifestMembership(manifest, replayPlan)
{
    const suites = new Map();
    const tests = new Map();
    const assertionIds = [];
    for (const suite of manifest.suites)
    {
        exact(suite, ['source', 'declarationId', 'tests'], 'manifest suite');
        const suiteId = frontendVitestSuiteIdentity(suite);
        requireValue(!suites.has(suiteId) && Array.isArray(suite.tests) && suite.tests.length > 0, 'duplicate or empty suite');
        const members = [];
        for (const test of suite.tests)
        {
            exact(test, ['declarationId', 'caseId', 'assertionIds'], 'manifest test');
            requireValue(test.caseId === null || (typeof test.caseId === 'string' && test.caseId.trim()), 'invalid parameterized identity');
            const testId = frontendVitestTestIdentity(suite, test);
            requireValue(!tests.has(testId), 'duplicate planned test');
            const assertions = exactIds(test.assertionIds, 'planned assertion IDs');
            requireValue(assertions.length > 0, 'planned assertions required');
            assertionIds.push(...assertions);
            tests.set(testId, { ...test, suiteId, assertionIds: assertions });
            members.push(testId);
        }
        suites.set(suiteId, members.sort());
    }
    exactIds(assertionIds, 'global planned assertion IDs');
    equal([...tests.keys()].sort(), [...replayPlan.testEnumerationOrder].sort(), 'replay/manifest planned membership');
    return { suites, tests };
}

function failureRecord(failure, testId, assertionId, context, artifacts)
{
    exact(failure, ['kind', 'identity', 'diagnosticRef', 'semanticArtifactIds'], 'failure');
    const rule = context.taxonomy.get(failure.kind);
    requireValue(rule !== undefined, 'unknown canonical failure kind');
    const identity = failure.identity;
    requireValue(identity.producerId === frontendVitestOutcomeProducerId
        && identity.testId === testId && identity.assertionId === assertionId, 'failure identity mismatch');
    const allowed = new Set(['producerId', 'testId', 'assertionId', ...rule.requiredIdentity]);
    requireValue(Object.keys(identity).every((key) => allowed.has(key))
        && rule.requiredIdentity.every((key) => Object.hasOwn(identity, key)), 'canonical failure identities incomplete');
    for (const key of rule.requiredIdentity)
    {
        const value = identity[key];
        if (key.endsWith('Digest'))
        {
            digest(value, `failure ${key}`);
        }
        else
        {
            requireValue(key === 'attemptNumber' ? Number.isSafeInteger(value) && value > 0
                : typeof value === 'string' && value.trim().length > 0, `invalid failure ${key}`);
        }
        if (Object.hasOwn(context.identity, key))
        {
            equal(value, context.identity[key], `failure ${key}`);
        }
        if (key === 'attemptNumber')
        {
            equal(value, context.attemptEligibility.attemptNumber, 'failure attemptNumber');
        }
    }
    exact(failure.diagnosticRef, ['path', 'digest'], 'raw diagnostic ref');
    requireValue(typeof failure.diagnosticRef.path === 'string' && failure.diagnosticRef.path.trim(), 'diagnostic path missing');
    digest(failure.diagnosticRef.digest, 'diagnostic digest');
    const refs = exactIds(failure.semanticArtifactIds, 'failure semantic artifact IDs');
    requireValue(refs.every((id) => artifacts.has(id)), 'failure artifact missing');
    context.diagnosticRefs.push({ kind: `raw-failure:${assertionId}`, ...failure.diagnosticRef });
    return { producerId: frontendVitestOutcomeProducerId, testId, assertionId,
        failureClass: failure.kind.split('.')[0], failureKind: failure.kind, identity,
        semanticArtifactIds: refs };
}

/**
 * Consume an original sealed replay plan, held command manifest, native Vitest JSON
 * report and independently bound runner evidence. expectedInputs MUST come from
 * the caller's held-input authority, never from these documents themselves.
 * Returns candidate-v1 only; registration, fingerprinting and qualification belong
 * to their existing owners. Missing native assertion/blocked evidence is an error.
 */
export function adaptFrontendVitestSemanticOutcome({
    identity, attemptEligibility, replayPlan, manifest, report, evidence, expectedInputs
})
{
    requireValue(expectedInputs && !types.isProxy(expectedInputs), 'independent expected inputs required');
    const limitsDescriptor = Object.getOwnPropertyDescriptor(expectedInputs, 'hostExpectedLimits');
    requireValue(limitsDescriptor && Object.hasOwn(limitsDescriptor, 'value'), 'independent host limits required');
    const limits = limitsDescriptor.value;
    requireValue(limits && !types.isProxy(limits) && Object.values(Object.getOwnPropertyDescriptors(limits))
        .every((item) => Object.hasOwn(item, 'value')), 'host limits must be data');
    inspectJson({ identity, attemptEligibility, replayPlan, manifest, report, evidence, expectedInputs }, limits);
    exact(expectedInputs, ['identity', 'attemptEligibility', 'replayPlanDigest', 'manifestDigest',
        'reportDigest', 'evidenceDigest', 'hostExpectedLimits'], 'expected inputs');
    equal(identity, expectedInputs.identity, 'held identity');
    equal(attemptEligibility, expectedInputs.attemptEligibility, 'held attempt');
    requireValue(identity.producerId === frontendVitestOutcomeProducerId, 'wrong producer');
    requireValue(attemptEligibility.attemptNumber === 1 && attemptEligibility.cleanFirstAttempt === true
        && attemptEligibility.firstFailure === false && attemptEligibility.qualificationEligible === true, 'unqualified attempt');
    validateReplayPlan(replayPlan);
    equal(replayPlan.planDigest, expectedInputs.replayPlanDigest, 'held replay plan');
    equal(identity.replayPlanDigest, replayPlan.planDigest, 'identity replay plan');
    equal(replayPlan.source, { commit: identity.sourceCommit, worktreeFingerprint: identity.worktreeFingerprint }, 'replay source');
    requireValue(replayPlan.producer.id === identity.producerId && replayPlan.producer.framework === 'vitest'
        && replayPlan.run.id === identity.schedulerRunId && replayPlan.run.mode === 'qualification', 'replay run/producer mismatch');
    exact(manifest, ['schema', 'identity', 'configId', 'projectId', 'policyDigests', 'suites',
        'coverageIds', 'artifactIds', 'contentDigest'], 'manifest');
    exact(evidence, ['schema', 'identity', 'configId', 'projectId', 'policyDigests', 'attemptEligibility',
        'manifestDigest', 'reportDigest', 'completion', 'suiteBindings', 'tests', 'coverageIds', 'artifacts', 'contentDigest'], 'evidence');
    requireValue(manifest.schema === frontendVitestManifestSchema && evidence.schema === frontendVitestEvidenceSchema, 'unsupported binding schema');
    sealed(manifest, expectedInputs.manifestDigest, 'manifest');
    sealed(evidence, expectedInputs.evidenceDigest, 'evidence');
    digest(expectedInputs.reportDigest, 'held report digest');
    equal(digestCanonical(report), expectedInputs.reportDigest, 'native report digest');
    equal(evidence.reportDigest, expectedInputs.reportDigest, 'runner report digest');
    equal(evidence.manifestDigest, manifest.contentDigest, 'runner manifest digest');
    for (const document of [manifest, evidence])
    {
        equal(document.identity, identity, 'bound identity');
    }
    equal(evidence.attemptEligibility, attemptEligibility, 'runner attempt');
    for (const field of ['configId', 'projectId', 'policyDigests'])
    {
        equal(evidence[field], manifest[field], `bound ${field}`);
    }
    requireValue([manifest.configId, manifest.projectId].every((id) => typeof id === 'string' && id.trim()), 'config/project identity missing');
    exactIds(Object.keys(manifest.policyDigests), 'policy IDs');
    requireValue(Object.keys(manifest.policyDigests).length > 0, 'policy identities required');
    Object.values(manifest.policyDigests).forEach((value) => digest(value, 'policy digest'));
    requireValue(Array.isArray(manifest.suites) && manifest.suites.length > 0, 'planned suites missing');
    const { suites, tests } = manifestMembership(manifest, replayPlan);
    const plannedArtifactIds = exactIds(manifest.artifactIds, 'planned artifacts');
    const artifacts = new Map();
    requireValue(Array.isArray(evidence.artifacts), 'artifact evidence missing');
    for (const artifact of evidence.artifacts)
    {
        exact(artifact, ['id', 'digest'], 'artifact');
        digest(artifact.digest, 'artifact digest');
        requireValue(!artifacts.has(artifact.id), 'duplicate artifact');
        artifacts.set(artifact.id, artifact.digest);
    }
    equal(exactIds([...artifacts.keys()], 'actual artifacts'), plannedArtifactIds, 'artifact membership');
    const coverageIds = exactIds(manifest.coverageIds, 'planned coverage IDs');
    equal(exactIds(evidence.coverageIds, 'actual coverage IDs'), coverageIds, 'coverage membership');
    requireValue(['complete', 'aborted'].includes(evidence.completion), 'unknown completion');
    requireValue(Array.isArray(evidence.tests), 'runner test evidence missing');
    equal(exactIds(evidence.tests.map((item) => item.testId), 'actual test IDs'), [...tests.keys()].sort(), 'actual test membership');
    requireValue(typeof report.success === 'boolean' && Array.isArray(report.testResults), 'native testResults/success missing');
    requireValue(Array.isArray(evidence.suiteBindings), 'native suite bindings missing');
    equal(exactIds(evidence.suiteBindings.map((binding) => binding.suiteId), 'actual suite IDs'), [...suites.keys()].sort(), 'actual suite membership');
    const suiteBindings = new Map();
    const boundFiles = new Set();
    for (const binding of evidence.suiteBindings)
    {
        exact(binding, ['suiteId', 'fileIndex'], 'native suite binding');
        requireValue(binding.fileIndex === null ? evidence.completion === 'aborted'
            : Number.isSafeInteger(binding.fileIndex) && binding.fileIndex >= 0 && binding.fileIndex < report.testResults.length,
        'missing or invalid native suite');
        suiteBindings.set(binding.suiteId, binding.fileIndex);
        if (binding.fileIndex !== null)
        {
            boundFiles.add(binding.fileIndex);
        }
    }
    requireValue(boundFiles.size === report.testResults.length, 'extra native suite');
    const native = new Map();
    report.testResults.forEach((file, fileIndex) =>
    {
        requireValue(Array.isArray(file.assertionResults), 'native assertionResults missing');
        file.assertionResults.forEach((assertion, assertionIndex) => native.set(`${fileIndex}:${assertionIndex}`, assertion));
    });
    const membership = { configId: manifest.configId, projectId: manifest.projectId, policyDigests: manifest.policyDigests,
        plannedSuiteIds: [...suites.keys()].sort(), suiteTestIds: Object.fromEntries([...suites].sort()),
        parameterizedTestIds: [...tests].filter(([, item]) => item.caseId !== null).map(([id]) => id).sort(),
        plannedTestIds: [...tests.keys()].sort(), executedTestIds: [], passedTestIds: [], failedTestIds: [],
        skippedTestIds: [], blockedTestIds: [], assertions: [], failures: [], coverageIds,
        artifactSemanticDigests: Object.fromEntries([...artifacts].sort()), stateSemanticDigests: {},
        scenarioIds: [], projectionReceipts: [], redactedSecrets: [] };
    const usedNative = new Set();
    const diagnosticRefs = [];
    const taxonomy = readOutcomeFailureTaxonomy();
    for (const event of evidence.tests)
    {
        exact(event, ['testId', 'status', 'executed', 'nativeRef', 'assertions'], 'runner test');
        requireValue(statuses.includes(event.status) && typeof event.executed === 'boolean', 'unknown test status/execution');
        requireValue(event.status === 'blocked' || event.executed === ['passed', 'failed'].includes(event.status), 'execution/status overlap');
        requireValue(event.status !== 'blocked' || evidence.completion === 'aborted', 'blocked needs abort evidence');
        if (event.nativeRef !== null)
        {
            exact(event.nativeRef, ['fileIndex', 'assertionIndex'], 'native ref');
            requireValue(Object.values(event.nativeRef).every((index) => Number.isSafeInteger(index) && index >= 0), 'invalid native ref');
            equal(event.nativeRef.fileIndex, suiteBindings.get(tests.get(event.testId).suiteId), 'test/suite native binding');
            const key = `${event.nativeRef.fileIndex}:${event.nativeRef.assertionIndex}`;
            const actual = native.get(key);
            requireValue(actual && !usedNative.has(key), 'missing or duplicate native result');
            const expectedStatus = { passed: ['passed'], failed: ['failed'], skipped: ['pending', 'skipped', 'todo'], blocked: ['pending', 'skipped', 'todo'] };
            requireValue(expectedStatus[event.status].includes(actual.status), 'native/runner status mismatch');
            usedNative.add(key);
        }
        else
        {
            requireValue(event.status === 'blocked', 'native result missing');
        }
        const plannedAssertions = tests.get(event.testId).assertionIds;
        requireValue(Array.isArray(event.assertions), 'assertion evidence missing');
        equal(exactIds(event.assertions.map((item) => item.id), 'actual assertion IDs'), plannedAssertions, 'assertion membership');
        let failedAssertions = 0;
        for (const assertion of event.assertions)
        {
            exact(assertion, ['id', 'status', 'failure'], 'assertion');
            requireValue(statuses.includes(assertion.status) && (event.status === 'failed'
                ? ['passed', 'failed'].includes(assertion.status) : assertion.status === event.status), 'assertion status mismatch');
            let failure = null;
            if (['failed', 'blocked', 'skipped'].includes(assertion.status))
            {
                const material = assertion.status === 'skipped' && assertion.failure === null
                    ? { kind: 'contract.missing-evidence', identity: { producerId: frontendVitestOutcomeProducerId,
                        testId: event.testId, assertionId: assertion.id, evidenceId: `skipped:${event.testId}` },
                    diagnosticRef: { path: 'held:vitest-report', digest: expectedInputs.reportDigest }, semanticArtifactIds: [] }
                    : assertion.failure;
                failure = failureRecord(material, event.testId, assertion.id,
                    { taxonomy, identity, attemptEligibility, diagnosticRefs }, artifacts);
                membership.failures.push(failure);
                failedAssertions += 1;
            }
            else
            {
                requireValue(assertion.failure === null, 'unexpected failure identity');
            }
            membership.assertions.push({ id: assertion.id, testId: event.testId, status: assertion.status,
                failureClass: failure?.failureClass ?? null, failureKind: failure?.failureKind ?? null,
                failureIdentity: failure?.identity ?? null });
        }
        requireValue(event.status !== 'failed' || failedAssertions > 0, 'failed test lacks failure identity');
        membership[`${event.status}TestIds`].push(event.testId);
        if (event.executed)
        {
            membership.executedTestIds.push(event.testId);
        }
    }
    requireValue(usedNative.size === native.size, 'extra native result');
    requireValue(evidence.completion !== 'aborted' || membership.blockedTestIds.length > 0, 'abort topology incomplete');
    requireValue(!(report.success === false || report.numRuntimeErrorTestSuites > 0 || report.unhandledErrors?.length > 0)
        || membership.failures.length > 0, 'native process failure lacks canonical evidence');
    for (const status of ['executed', ...statuses])
    {
        membership[`${status}TestIds`].sort();
    }
    for (const status of ['planned', 'executed', ...statuses])
    {
        membership[`${status}ParameterizedTestIds`] = membership[`${status}TestIds`]
            .filter((id) => tests.get(id).caseId !== null);
    }
    for (const status of ['executed', ...statuses])
    {
        membership[`${status}SuiteIds`] = [];
    }
    for (const [suiteId, members] of suites)
    {
        if (members.some((id) => membership.executedTestIds.includes(id)))
        {
            membership.executedSuiteIds.push(suiteId);
        }
        const status = ['failed', 'blocked', 'skipped'].find((state) =>
            members.some((id) => membership[`${state}TestIds`].includes(id))) ?? 'passed';
        membership[`${status}SuiteIds`].push(suiteId);
    }
    for (const status of ['executed', ...statuses])
    {
        membership[`${status}SuiteIds`].sort();
    }
    membership.assertions.sort((left, right) => left.id.localeCompare(right.id));
    membership.failures.sort((left, right) => left.assertionId.localeCompare(right.assertionId));
    const reasons = membership.failures.map((failure) => ({ kind: failure.failureKind,
        producerId: frontendVitestOutcomeProducerId, identity: failure.identity }));
    return sealProducerSemanticOutcomeCandidate({ producerId: frontendVitestOutcomeProducerId, producerAuthorityId: authorityId,
        identity, attemptEligibility,
        inputAuthorityRefs: [
            { kind: 'replay-plan', path: 'held:replay-plan', digest: replayPlan.planDigest },
            { kind: 'command-manifest', path: 'held:frontend-manifest', digest: manifest.contentDigest },
            { kind: 'native-report', path: 'held:vitest-report', digest: expectedInputs.reportDigest },
            { kind: 'runner-evidence', path: 'held:frontend-evidence', digest: evidence.contentDigest },
            ...diagnosticRefs.sort((left, right) => left.kind.localeCompare(right.kind))
        ], outcome: { status: reasons.length === 0 ? 'success' : 'failed', requiredMembershipVerified: reasons.length === 0,
            reasons, membership, semanticPayloadDigest: digestCanonical(membership) } });
}

/** Verify a transported candidate by replaying its exact independently held inputs. */
export function verifyFrontendVitestSemanticOutcomeCandidate(candidate, inputs)
{
    requireValue(inputs && typeof inputs === 'object' && !types.isProxy(inputs), 'independent inputs required');
    const expectedInputsDescriptor = Object.getOwnPropertyDescriptor(inputs, 'expectedInputs');
    requireValue(expectedInputsDescriptor && Object.hasOwn(expectedInputsDescriptor, 'value'), 'independent expected inputs must be data');
    const expectedInputs = expectedInputsDescriptor.value;
    requireValue(expectedInputs && !types.isProxy(expectedInputs), 'independent expected inputs required');
    const limitsDescriptor = Object.getOwnPropertyDescriptor(expectedInputs, 'hostExpectedLimits');
    requireValue(limitsDescriptor && Object.hasOwn(limitsDescriptor, 'value'), 'independent host limits required');
    const limits = limitsDescriptor.value;
    requireValue(limits && !types.isProxy(limits) && Object.values(Object.getOwnPropertyDescriptors(limits))
        .every((item) => Object.hasOwn(item, 'value')), 'host limits must be data');
    // Admit transported data with the held budgets before legacy reflection or hashing.
    inspectJson(inputs, limits);
    inspectJson(candidate, limits);
    validateProducerSemanticOutcomeCandidate(candidate, { expectedProducerId: frontendVitestOutcomeProducerId,
        expectedAuthorityId: authorityId });
    const expected = adaptFrontendVitestSemanticOutcome(inputs);
    equal(candidate, expected, 'candidate exact bound outcome');
    return candidate;
}
