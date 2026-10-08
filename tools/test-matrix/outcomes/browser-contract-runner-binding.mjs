import { candidate as createCandidate, exactIds } from './adapter-support.mjs';
import { adaptBrowserContractSemanticOutcome, browserContractOutcomeProducerId,
    readBrowserContractOutcomeArtifact } from './browser-contract-adapter.mjs';

const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
const { validateBrowserContractReceipt } = await import(new URL('../../release/browser-contract-receipt-contract.mjs', import.meta.url));
const { selectBrowserContractScenarios } = await import(new URL('../../../tests/browser-contract/contract-core.mjs', import.meta.url));
const { verifyBrowserContractRaw } = await import(new URL('../../test-evidence/browser-contract-observation-raw.mjs', import.meta.url));
const { observationUpstreamPath } = await import(new URL('../../fact-extractors/post-runtime/adapter.mjs', import.meta.url));
const { readReleaseReliabilityEvidenceBinding } = await import(new URL('../../test/release-reliability-evidence-binding.mjs', import.meta.url));

function requireCondition(condition, message)
{
    if (!condition)
    {
        throw new Error(`browser runner binding: ${message}`);
    }
}

function same(actual, expected, label)
{
    requireCondition(digestCanonical(actual) === digestCanonical(expected), `${label} mismatch`);
}

function exactKeys(value, fields, label)
{
    requireCondition(value && typeof value === 'object' && !Array.isArray(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort()),
    `${label} fields do not exactly match the contract`);
}

function readJson(root, reference)
{
    return JSON.parse(readBrowserContractOutcomeArtifact(root, reference).toString('utf8'));
}

/**
 * Reopen native Browser Contract terminal evidence with the original reader.
 * A successful source also requires an already-produced raw observation which
 * the original independent verifier reopens. No member outcome is inferred here.
 */
export function readBrowserContractOutcomeRunnerBinding({
    repositoryRoot, runnerReference, expected, temporalAuthority,
    rawObservationReferences, releaseReliability
})
{
    exactKeys(expected, ['identity', 'attemptId', 'fixtureNamespace', 'browserPlanDigest',
        'browserActualDigest', 'fixtureCapabilities'], 'held runner expectation');
    requireCondition(expected.identity?.producerId === browserContractOutcomeProducerId, 'held outcome producer mismatch');
    const receipt = readJson(repositoryRoot, runnerReference);
    const errors = validateBrowserContractReceipt(receipt, {
        expectedCommit: expected.identity.sourceCommit,
        expectedFingerprint: expected.identity.worktreeFingerprint,
        expectedBuildReceiptDigest: expected.identity.buildIdentity,
        temporalAuthority,
        requireSuccess: false
    });
    requireCondition(errors.length === 0, `native receipt rejected: ${errors.join('; ')}`);
    requireCondition(receipt.finalization?.state === 'complete', 'native runner is not terminal');
    requireCondition(receipt.runIdentity?.commit === expected.identity.sourceCommit
        && receipt.runIdentity?.runId === expected.identity.schedulerRunId
        && receipt.runIdentity?.attemptId === expected.attemptId
        && receipt.fixtureNamespace === expected.fixtureNamespace, 'native source/run/attempt/fixture mismatch');
    same(receipt.fixture?.lifecycle?.identity, receipt.runIdentity, 'native fixture/run identity');
    same(receipt.fixture?.capabilities, expected.fixtureCapabilities, 'held fixture capabilities');
    requireCondition(receipt.attemptStatus === (receipt.status === 'success' ? 'clean-success' : 'failed-no-retry')
        && receipt.cleanFirstAttempt === (receipt.status === 'success')
        && receipt.qualificationEligible === (receipt.status === 'success'), 'native attempt terminal mismatch');
    const selected = selectBrowserContractScenarios(expected.fixtureCapabilities);
    const plannedScenarioIds = exactIds(selected.map((scenario) => scenario.id), 'native planned scenarios');
    same(exactIds(receipt.scenarios.map((scenario) => scenario.id), 'native terminal scenarios'),
        plannedScenarioIds, 'native selected scenario membership');
    const byId = new Map(selected.map((scenario) => [scenario.id, scenario]));
    for (const scenario of receipt.scenarios)
    {
        requireCondition(scenario.capability === byId.get(scenario.id).capability, 'native scenario capability mismatch');
    }
    const launched = receipt.topology.browserLaunchCount === 1;
    const browser = receipt.playwright?.browserIdentity;
    requireCondition((browser?.plan?.contentDigest ?? null) === expected.browserPlanDigest
        && (browser?.actual?.contentDigest ?? null) === expected.browserActualDigest, 'held browser runtime mismatch');
    requireCondition(!launched || expected.browserActualDigest !== null, 'launched browser lacks a held runtime digest');
    if (receipt.temporalBinding)
    {
        requireCondition(temporalAuthority !== null && temporalAuthority !== undefined, 'independent temporal authority is required');
        requireCondition(digestCanonical(receipt.temporalBinding.plan.temporalContext) === expected.identity.temporalContextDigest,
            'held temporal context mismatch');
    }
    requireCondition(receipt.status !== 'success' || receipt.temporalBinding, 'successful native runner lacks temporal observations');
    const inputAuthorityRefs = [{ kind: 'browser-contract-runner-receipt', ...runnerReference }];
    let rawObservation = null;
    if (receipt.status === 'success')
    {
        exactKeys(rawObservationReferences, ['candidatePlan', 'receipt'], 'held raw observation references');
        readJson(repositoryRoot, rawObservationReferences.candidatePlan);
        const heldRaw = readJson(repositoryRoot, rawObservationReferences.receipt);
        rawObservation = verifyBrowserContractRaw(rawObservationReferences.receipt.path,
            repositoryRoot, rawObservationReferences.candidatePlan.path);
        same(rawObservation, heldRaw, 'independent raw observation bytes');
        requireCondition(observationUpstreamPath(rawObservation, repositoryRoot) === runnerReference.path,
            'raw observation belongs to another runner receipt');
        inputAuthorityRefs.push({ kind: 'browser-contract-native-candidate-plan', ...rawObservationReferences.candidatePlan },
            { kind: 'browser-contract-runtime-observation', ...rawObservationReferences.receipt });
    }
    else
    {
        requireCondition(rawObservationReferences === null, 'failed native runner cannot consume a successful raw observation');
    }
    let reliabilityBinding = null;
    if (releaseReliability !== null)
    {
        exactKeys(releaseReliability, ['environment', 'identityReference'], 'held release reliability context');
        readJson(repositoryRoot, releaseReliability.identityReference);
        reliabilityBinding = readReleaseReliabilityEvidenceBinding({ repositoryRoot, environment: releaseReliability.environment });
        readJson(repositoryRoot, releaseReliability.identityReference);
        requireCondition(reliabilityBinding !== null, 'release reliability binding is missing');
        requireCondition(releaseReliability.environment.FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH
            === releaseReliability.identityReference.path, 'held reliability identity path mismatch');
        requireCondition(reliabilityBinding.sourceState.commit === expected.identity.sourceCommit
            && reliabilityBinding.sourceState.worktreeFingerprint === expected.identity.worktreeFingerprint
            && reliabilityBinding.buildContentDigest === expected.identity.buildIdentity
            && reliabilityBinding.runId === expected.identity.schedulerRunId, 'reliability source/build/run mismatch');
        inputAuthorityRefs.push({ kind: 'release-reliability-run-identity', ...releaseReliability.identityReference });
    }
    const terminals = [...receipt.scenarios].sort((left, right) => plannedScenarioIds.indexOf(left.id) - plannedScenarioIds.indexOf(right.id))
        .map((scenario) => ({ testId: `browser-contract:${scenario.id}`, scenarioId: scenario.id,
            status: scenario.status, classification: scenario.classification,
            executed: scenario.status !== 'pending' }));
    return { receipt, terminals, rawObservation, reliabilityBinding, inputAuthorityRefs };
}

/** Bind an independently held member report to reopened native runner evidence. */
export function adaptBrowserContractRunnerSemanticOutcome({ repositoryRoot, authority, runnerBinding })
{
    const source = readBrowserContractOutcomeRunnerBinding({ ...runnerBinding, repositoryRoot });
    same(authority.identity, runnerBinding.expected.identity, 'outcome/runner held identity');
    const reportRef = authority.inputAuthorityRefs.find((reference) => reference.kind === 'browser-contract-report');
    requireCondition(reportRef, 'independently held member report is required');
    const report = readJson(repositoryRoot, { path: reportRef.path, digest: reportRef.digest });
    same(report.diagnostics?.runnerReceipt, runnerBinding.runnerReference, 'member report/native source binding');
    const result = adaptBrowserContractSemanticOutcome({ repositoryRoot, authority });
    same(result.outcome.membership.plannedTestIds, source.terminals.map((terminal) => terminal.testId).sort(),
        'native/member planned test membership');
    const members = result.outcome.membership.members;
    for (const terminal of source.terminals)
    {
        const actual = members.filter((member) => member.testId === terminal.testId);
        requireCondition(terminal.executed || actual.every((member) => !member.executed), 'pending native scenario has fabricated executed assertions');
        requireCondition(terminal.status !== 'success' || actual.every((member) => ['passed', 'skipped'].includes(member.status)),
            'successful native scenario masks a member failure');
        requireCondition(terminal.status !== 'failure' || actual.some((member) => ['failed', 'blocked'].includes(member.status)),
            'failed native scenario was replaced by passing members');
    }
    if (source.receipt.status === 'failure')
    {
        requireCondition(result.outcome.status === 'failed', 'failed native runner was promoted to success');
    }
    for (const runtime of authority.runtimeIdentities)
    {
        if (source.receipt.topology.browserLaunchCount === 1)
        {
            requireCondition(runtime.browserId === source.receipt.playwright.browserIdentity.actual.browserName
                && runtime.runtimeDigest === runnerBinding.expected.browserActualDigest, 'member/native browser runtime mismatch');
        }
    }
    requireCondition(source.receipt.status !== 'failure'
        || authority.attemptEligibility.firstFailure === true
            && authority.attemptEligibility.cleanFirstAttempt === false
            && authority.attemptEligibility.qualificationEligible === false, 'failed native attempt provenance was erased');
    return createCandidate({ producerId: result.producerId, producerAuthorityId: result.producerAuthorityId,
        identity: result.identity, attemptEligibility: result.attemptEligibility,
        inputAuthorityRefs: [...result.inputAuthorityRefs, ...source.inputAuthorityRefs],
        membership: result.outcome.membership, reasons: result.outcome.reasons });
}

/**
 * Consume the canonical DATA_ONLY profile and original physical input custody.
 * The host must pin the expected candidate/source/context/mapping/attempt;
 * neither successful custody nor a catalog profile grants execution admission.
 */
export async function verifyBrowserContractOutcomeInputCustody(encodedCandidate, encodedExpected, custodyOptions)
{
    const { validateOutcomeAdapterCandidateData } = await import('./outcome-adapter-profile-contract.mjs');
    const { verifyOutcomeInputCustody } = await import('./outcome-input-custody.mjs');
    const profile = validateOutcomeAdapterCandidateData(encodedCandidate, encodedExpected, custodyOptions.maxBytes);
    requireCondition(profile.producerId === browserContractOutcomeProducerId, 'custody candidate is not Browser Contract');
    const custody = verifyOutcomeInputCustody(encodedCandidate, encodedExpected, custodyOptions);
    for (const binding of custodyOptions.bindings)
    {
        requireCondition(binding.inputReference.path === binding.payloadPath,
            'browser physical input path differs from custody mapping');
    }
    requireCondition(profile.candidateDigest === custody.candidateDigest, 'profile/custody candidate mismatch');
    return Object.freeze({ profile, custody, producerVerificationPending: true, qualificationEligible: false });
}

/** Preserve the native runner checks before composing the canonical owners. */
export async function adaptBrowserContractRunnerSemanticOutcomeWithCustody({
    repositoryRoot, authority, runnerBinding, encodedExpected, custodyOptions
})
{
    const candidate = adaptBrowserContractRunnerSemanticOutcome({ repositoryRoot, authority, runnerBinding });
    const verification = await verifyBrowserContractOutcomeInputCustody(JSON.stringify(candidate), encodedExpected,
        { ...custodyOptions, repositoryRoot });
    return { candidate, verification };
}
