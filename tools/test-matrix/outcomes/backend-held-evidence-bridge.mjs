import fs from 'node:fs';
import path from 'node:path';

import { exactIds } from './adapter-support.mjs';
import { backendCaseCatalogSchema, backendFrameworkReportSchema } from './backend-test-adapter.mjs';
import { readOutcomeFailureTaxonomy } from './outcome-contract.mjs';

const { digestCanonical, sealContentDigest, sha256 } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
const { validateReplayPlan } = await import(new URL('../../test/execution-replay-contract.mjs', import.meta.url));
const { readPrivateFile, writePrivateJson } = await import(new URL('../../test-fixtures/receipt/private-io.mjs', import.meta.url));

export const backendNativeAssertionObservationSchema = 'fsusblog.backend-native-assertion-observation.v1';

function requireCondition(condition, message)
{
    if (!condition)
    {
        throw new Error(`backend held bridge: ${message}`);
    }
}

function same(actual, expected, label)
{
    requireCondition(digestCanonical(actual) === digestCanonical(expected), `${label} mismatch`);
}

function verifySeal(document, field = 'contentDigest')
{
    const unsigned = { ...document };
    delete unsigned[field];
    same(document[field], digestCanonical(unsigned), `${field} seal`);
}

function unique(entries, field, label)
{
    requireCondition(Array.isArray(entries), `${label} must be an array`);
    exactIds(entries.map((entry) => entry[field]), label);
    return new Map(entries.map((entry) => [entry[field], entry]));
}

function fields(value, expected, label)
{
    requireCondition(value && typeof value === 'object' && !Array.isArray(value), `${label} object`);
    same(Object.keys(value).sort(), [...expected].sort(), `${label} fields`);
}

function verifyNativeAssertions(observation, binding, identity, refsById)
{
    fields(observation, ['schema', 'identity', 'testCaseUniqueId', 'cases', 'assertions',
        'coverageIds', 'artifactIds', 'stateIds'], 'native observation');
    requireCondition(['fact', 'parameterized'].includes(binding.caseBinding.kind)
        && binding.caseBinding.id === observation.testCaseUniqueId, 'native catalog case binding');
    same(exactIds(observation.cases.map((entry) => entry.caseId), 'native observed cases'),
        [binding.caseBinding.id], 'native assertion case membership');
    for (const observedCase of observation.cases)
    {
        fields(observedCase, ['caseId', 'inputDigest', 'shrinkSequenceIdentity', 'transitionIds'], 'native observed case');
        requireCondition(observedCase.inputDigest === null && observedCase.shrinkSequenceIdentity === null
            && Array.isArray(observedCase.transitionIds) && observedCase.transitionIds.length === 0,
        'native xUnit case cannot invent randomized telemetry');
    }
    for (const field of ['coverageIds', 'artifactIds', 'stateIds'])
    {
        same(exactIds(observation[field], `native ${field}`), exactIds(binding[field], `planned ${field}`),
            `native applicable ${field}`);
    }
    const assertionIds = exactIds(observation.assertions.map((entry) => entry.id), 'native assertions');
    requireCondition(assertionIds.length > 0 && assertionIds.every((id) => binding.assertionIds.includes(id)),
        'native extra/missing assertion identities');
    const taxonomy = readOutcomeFailureTaxonomy();
    for (const assertion of observation.assertions)
    {
        fields(assertion, ['id', 'caseId', 'status', 'failure'], 'native assertion');
        requireCondition(assertion.caseId === binding.caseBinding.id
            && ['passed', 'failed'].includes(assertion.status), 'native assertion identity/status');
        if (assertion.status === 'passed')
        {
            requireCondition(assertion.failure === null, 'native passing assertion carries failure');
            continue;
        }
        const failure = assertion.failure;
        fields(failure, ['class', 'kind', 'identity', 'diagnosticEvidenceId', 'semanticArtifactIds', 'stateIds'], 'native failure');
        requireCondition(failure.class === 'product' && failure.kind === 'product.assertion'
            && taxonomy.has(failure.kind), 'native assertion needs canonical product.assertion telemetry');
        same(failure.identity, { producerId: identity.producerId, testId: binding.testId,
            caseId: assertion.caseId, assertionId: assertion.id }, 'native failure identity');
        requireCondition(refsById.has(failure.diagnosticEvidenceId), 'native failure diagnostic material');
        for (const [failureField, bindingField] of [['semanticArtifactIds', 'artifactIds'], ['stateIds', 'stateIds']])
        {
            requireCondition(exactIds(failure[failureField], `native failure ${failureField}`)
                .every((id) => binding[bindingField].includes(id)), 'native failure inapplicable semantics');
        }
    }
    if (observation.assertions.every((assertion) => assertion.status === 'passed'))
    {
        same(assertionIds, exactIds(binding.assertionIds, 'planned assertion identities'), 'native passed assertion membership');
    }
}

/**
 * Join original native xUnit queue/slot events to independently retained assertion
 * observations. Native pass/fail events alone never manufacture an assertion ID.
 * This is a source observation projection; execution qualification stays external.
 */
export function buildBackendFrameworkObservationFromXunit({
    identity, plan, catalog, attempt, queueManifest, slotExecutions, assertionObservations,
    evidenceRefs, artifactSemanticDigests, stateSemanticDigests
})
{
    validateReplayPlan(plan);
    same(plan.source, { commit: identity.sourceCommit, worktreeFingerprint: identity.worktreeFingerprint }, 'plan source');
    requireCondition(plan.producer.id === identity.producerId && plan.run.id === identity.schedulerRunId
        && plan.planDigest === identity.replayPlanDigest, 'plan producer/run binding');
    requireCondition(catalog.schema === backendCaseCatalogSchema, 'case catalog schema');
    verifySeal(catalog);
    same(catalog.identity, identity, 'catalog identity');
    requireCondition(attempt.replayPlanDigest === plan.planDigest, 'attempt plan binding');
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'schedulerRunId', 'producerId',
        'executionEnvelopeDigest', 'temporalContextDigest'])
    {
        requireCondition(attempt[field] === identity[field], `attempt ${field} binding`);
    }
    verifySeal(attempt);
    requireCondition(queueManifest.schema === 'fsusblog.xunit-replay-queue-manifest.v1'
        && queueManifest.planDigest === plan.planDigest, 'native queue schema/plan');
    verifySeal(queueManifest);
    requireCondition(plan.frameworkModes.find((mode) => mode.name === 'inventory-digest')?.value
        === queueManifest.inventoryDigest, 'native queue inventory binding');
    same(queueManifest.slots.map((slot) => slot.id), plan.workers.ids, 'native worker roster');
    const catalogByTest = unique(catalog.tests, 'testId', 'catalog tests');
    const refsById = unique(evidenceRefs, 'id', 'raw evidence references');
    for (const reference of evidenceRefs)
    {
        requireCondition(attempt.artifactDigests[reference.path] === reference.digest, 'raw evidence outside retained attempt');
    }
    const planned = exactIds(plan.testEnumerationOrder, 'planned tests');
    same([...catalogByTest.keys()].sort(), planned, 'catalog/plan tests');
    const queued = queueManifest.slots.flatMap((slot) => slot.collections.flatMap((collection) => collection.tests));
    const queueByCase = unique(queued, 'testCaseUniqueId', 'native queued cases');
    same(exactIds(queued.map((test) => test.canonicalTestId), 'native queued tests'), planned, 'queue/plan tests');
    const observationsByNativeId = unique(assertionObservations.map((entry) => entry.document), 'testCaseUniqueId', 'native assertion observations');
    const assertionRefByNativeId = new Map(assertionObservations.map((entry) => [entry.document.testCaseUniqueId, entry.reference]));
    for (const { document, reference } of assertionObservations)
    {
        requireCondition(document.schema === backendNativeAssertionObservationSchema, 'assertion observation schema');
        same(document.identity, identity, 'assertion observation identity');
        same(refsById.get(reference.id), reference, 'assertion raw reference');
    }
    const executionBySlot = unique(slotExecutions, 'slotId', 'native slot executions');
    same([...executionBySlot.keys()].sort(), queueManifest.slots.map((slot) => slot.id).sort(), 'native slot roster');
    const tests = [];
    const usedNativeIds = new Set();
    for (const slot of queueManifest.slots)
    {
        const execution = executionBySlot.get(slot.id);
        const native = execution.receipt;
        requireCondition(native.schema === 'fsusblog.xunit-replay-slot-receipt.v1'
            && native.planDigest === plan.planDigest && native.slotId === slot.id
            && native.processId === execution.processId && Number.isSafeInteger(execution.processId)
            && execution.processId > 0, 'native slot process/plan identity');
        same(refsById.get(execution.reference.id), execution.reference, 'native slot raw reference');
        requireCondition(execution.signal === null && [0, 1].includes(execution.exitCode),
            'native crash has no retained partial event capability');
        const expectedCases = slot.collections.flatMap((collection) => collection.tests.map((test) => test.testCaseUniqueId));
        same(exactIds(native.outcomes.map((entry) => entry.testCaseUniqueId), 'native outcome cases'),
            exactIds(expectedCases, 'native slot cases'), 'native exact outcomes');
        const starts = unique(native.starts, 'testUniqueId', 'native starts');
        unique(native.outcomes, 'testUniqueId', 'native outcomes');
        const admittedCases = native.admissions.flatMap((entry) => entry.testCaseUniqueIds);
        same(exactIds(admittedCases, 'native admissions'), exactIds(expectedCases, 'native expected cases'), 'native admitted cases');
        const collections = new Map(slot.collections.map((collection) => [collection.testCollectionUniqueId,
            new Set(collection.tests.map((test) => test.testCaseUniqueId))]));
        for (const admission of native.admissions)
        {
            requireCondition(collections.has(admission.testCollectionUniqueId), 'foreign native admission collection');
            same(exactIds(admission.testCaseUniqueIds, 'admission cases'),
                [...collections.get(admission.testCollectionUniqueId)].sort(), 'native admission collection cases');
        }
        let failed = false;
        for (const outcome of native.outcomes)
        {
            requireCondition(['passed', 'failed', 'skipped'].includes(outcome.outcome), 'unknown or unproven native terminal');
            const queuedTest = queueByCase.get(outcome.testCaseUniqueId);
            const binding = catalogByTest.get(queuedTest.canonicalTestId);
            requireCondition(outcome.testCollectionUniqueId === queuedTest.testCollectionUniqueId
                && collections.get(outcome.testCollectionUniqueId)?.has(outcome.testCaseUniqueId), 'native collection/case binding');
            const start = starts.get(outcome.testUniqueId);
            requireCondition(start?.testCaseUniqueId === outcome.testCaseUniqueId
                && start.testCollectionUniqueId === outcome.testCollectionUniqueId, 'native start/result join');
            requireCondition(!usedNativeIds.has(outcome.testUniqueId), 'native test crosses slots');
            usedNativeIds.add(outcome.testUniqueId);
            const observation = observationsByNativeId.get(outcome.testCaseUniqueId);
            if (outcome.outcome === 'skipped')
            {
                requireCondition(observation === undefined, 'skipped native test executed assertions');
                tests.push({ testId: binding.testId, caseBinding: binding.caseBinding, status: 'skipped', cases: [], assertions: [],
                    coverageIds: binding.coverageIds, artifactIds: binding.artifactIds, stateIds: binding.stateIds,
                    evidenceId: execution.reference.id });
                continue;
            }
            requireCondition(observation?.testCaseUniqueId === outcome.testCaseUniqueId, 'missing/cross-case native assertion material');
            verifyNativeAssertions(observation, binding, identity, refsById);
            const assertionRef = assertionRefByNativeId.get(outcome.testCaseUniqueId);
            const assertionFailures = observation.assertions.filter((assertion) => assertion.status === 'failed');
            requireCondition(observation.assertions.every((assertion) => ['passed', 'failed'].includes(assertion.status)), 'unobserved native assertion');
            requireCondition((outcome.outcome === 'failed') === (assertionFailures.length > 0), 'native/assertion failure mismatch');
            failed ||= outcome.outcome === 'failed';
            const testObservation = { testId: binding.testId, caseBinding: binding.caseBinding, status: outcome.outcome,
                cases: observation.cases, assertions: observation.assertions.map((assertion) => ({
                    ...assertion, evidenceId: assertionRef.id
                })), coverageIds: observation.coverageIds, artifactIds: observation.artifactIds,
                stateIds: observation.stateIds, evidenceId: execution.reference.id };
            tests.push(testObservation);
        }
        requireCondition(starts.size === native.outcomes.length, 'orphan native start');
        requireCondition(execution.exitCode === (failed ? 1 : 0), 'native process result mismatch');
    }
    requireCondition([...observationsByNativeId.keys()].every((id) => tests.some((entry) => queueByCase.get(id)?.canonicalTestId === entry.testId && entry.status !== 'skipped')), 'orphan native assertion observation');
    for (const [field, semanticDigests] of [['artifactIds', artifactSemanticDigests], ['stateIds', stateSemanticDigests]])
    {
        const applicable = [...new Set(catalog.tests.flatMap((entry) => entry[field]))].sort();
        fields(semanticDigests, applicable, `native semantic ${field}`);
        requireCondition(Object.values(semanticDigests).every((value) => /^sha256:[0-9a-f]{64}$/u.test(value)),
            'native semantic digest format');
    }
    tests.sort((left, right) => Buffer.compare(Buffer.from(left.testId), Buffer.from(right.testId)));
    return sealContentDigest({ schema: backendFrameworkReportSchema, identity,
        attemptDigest: attempt.contentDigest, catalogDigest: catalog.contentDigest, frameworkStatus: 'completed',
        tests, evidenceRefs, artifactSemanticDigests, stateSemanticDigests, terminalFailure: null });
}

/**
 * Read through the existing bounded private-file primitive, checking every path's
 * containment before allocation. Expected references originate with the owning
 * caller and are copied once; the verifier never learns expectations from requests.
 */
export function createBackendHeldEvidenceBridge({
    evidenceRoot, expectedIdentity, inputAuthorityRefs, queueManifestReference, slotExecutionReferences,
    assertionObservationReferences, artifactSemanticReferences, stateSemanticReferences,
    verificationReceiptPath, maximumBytes
})
{
    requireCondition(Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= 16 * 1024 * 1024,
        'explicit finite held byte limit is required');
    const root = path.resolve(evidenceRoot);
    requireCondition(fs.realpathSync(root) === root && fs.lstatSync(root).isDirectory(), 'held root must be canonical');
    const identity = JSON.parse(JSON.stringify(expectedIdentity));
    const expectedInputs = JSON.parse(JSON.stringify(inputAuthorityRefs));
    const rawExpected = JSON.parse(JSON.stringify({ queueManifestReference, slotExecutionReferences,
        assertionObservationReferences, artifactSemanticReferences, stateSemanticReferences }));
    function contained(relative)
    {
        requireCondition(typeof relative === 'string' && relative.length > 0 && !relative.includes('\\')
            && !relative.includes(':') && !path.isAbsolute(relative)
            && relative.split('/').every((part) => part && part !== '.' && part !== '..'), 'held path must be contained');
        const absolute = path.join(root, relative);
        const parent = path.dirname(absolute);
        requireCondition(fs.realpathSync(parent) === parent, 'held parent path alias');
        return absolute;
    }
    function readBytes(relative, expectedDigest)
    {
        const bytes = readPrivateFile(contained(relative), { maximumBytes, label: 'backend held evidence' }).bytes;
        requireCondition(expectedDigest === undefined || sha256(bytes) === expectedDigest, 'held raw bytes digest mismatch');
        return bytes;
    }
    function readRaw(reference)
    {
        return JSON.parse(readBytes(reference.path, reference.digest).toString('utf8'));
    }
    function reopen()
    {
        const documents = {};
        unique(expectedInputs, 'kind', 'held input kinds');
        for (const reference of expectedInputs)
        {
            const document = JSON.parse(readBytes(reference.path).toString('utf8'));
            verifySeal(document, reference.kind === 'replay-plan' ? 'planDigest' : 'contentDigest');
            same(reference.digest, document[reference.kind === 'replay-plan' ? 'planDigest' : 'contentDigest'], 'held input digest');
            documents[reference.kind] = document;
        }
        const required = ['replay-plan', 'backend-catalog', 'backend-report', 'attempt', 'aggregate-attempt'];
        requireCondition(required.every((kind) => documents[kind] !== undefined)
            && expectedInputs.every((reference) => [...required, 'evidence-projection'].includes(reference.kind)), 'held input roster');
        const queueManifest = readRaw(rawExpected.queueManifestReference);
        const slotExecutions = rawExpected.slotExecutionReferences.map((execution) => ({ ...execution,
            receipt: readRaw(execution.reference) }));
        const assertionObservations = rawExpected.assertionObservationReferences.map((reference) => ({
            reference, document: readRaw(reference)
        }));
        function semanticMap(references)
        {
            unique(references, 'id', 'semantic references');
            return Object.fromEntries(references.map((reference) =>
            {
                const bytes = readBytes(reference.path, reference.digest);
                const semantic = JSON.parse(bytes.toString('utf8'));
                same(reference.semanticDigest, digestCanonical(semantic), 'semantic observation digest');
                return [reference.id, reference.semanticDigest];
            }));
        }
        const rawReferences = [rawExpected.queueManifestReference,
            ...rawExpected.slotExecutionReferences.map((execution) => execution.reference),
            ...rawExpected.assertionObservationReferences,
            ...rawExpected.artifactSemanticReferences.map(({ id, path, digest }) => ({ id, path, digest })),
            ...rawExpected.stateSemanticReferences.map(({ id, path, digest }) => ({ id, path, digest }))];
        const expectedReport = buildBackendFrameworkObservationFromXunit({ identity,
            plan: documents['replay-plan'], catalog: documents['backend-catalog'], attempt: documents.attempt,
            queueManifest, slotExecutions, assertionObservations, evidenceRefs: rawReferences,
            artifactSemanticDigests: semanticMap(rawExpected.artifactSemanticReferences),
            stateSemanticDigests: semanticMap(rawExpected.stateSemanticReferences) });
        same(documents['backend-report'], expectedReport, 'report/native held material');
        return { documents, rawReferences };
    }
    return {
        verifyArtifact(relative, expectedDigest)
        {
            try
            {
                readBytes(relative, expectedDigest);
                return true;
            }
            catch
            {
                return false;
            }
        },
        verifyBackendEvidence(request)
        {
            same(request.identity, identity, 'independent expected identity');
            same(request.inputAuthorityRefs, expectedInputs, 'independent expected input references');
            const { rawReferences } = reopen();
            const receipt = sealContentDigest({ schema: 'fsusblog.backend-held-evidence-verification.v1',
                scope: 'native-observation-binding', qualificationGranted: false, identity,
                inputAuthorityRefs: expectedInputs, rawReferences });
            const output = contained(verificationReceiptPath);
            if (fs.existsSync(output))
            {
                same(JSON.parse(readBytes(verificationReceiptPath).toString('utf8')), receipt, 'existing verification receipt');
            }
            else
            {
                writePrivateJson(output, receipt, { overwrite: false, label: 'backend held verification' });
            }
            return { verified: true, identity, inputAuthorityRefs: expectedInputs,
                verificationReceipt: { path: verificationReceiptPath, digest: receipt.contentDigest } };
        }
    };
}
