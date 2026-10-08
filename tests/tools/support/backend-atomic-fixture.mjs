import fs from 'node:fs';
import path from 'node:path';

const { digestCanonical, sha256 } = await import(new URL('../../../tools/test/attempt-provenance.mjs', import.meta.url));
const { runProducerAttempts } = await import(new URL('../../../tools/test/attempt-runner.mjs', import.meta.url));

export const fixtureIdentity = {
    sourceCommit: '1'.repeat(40),
    worktreeFingerprint: `sha256:${'2'.repeat(64)}`,
    schedulerRunId: 'backend-atomic-fixture',
    profile: 'DATA_ONLY-fixture'
};
const fixtureRoot = path.resolve(import.meta.dirname, '../../..');
export const fixtureCommand = [process.execPath, path.join(fixtureRoot, 'tests/tools/fixtures/attempt-runner-command.mjs'), 'success'];
const suite = 'tools/test/lanes/_suite-support.sh';

export function fixtureAuthorities(producerId)
{
    return ['execution-envelope', 'replay-plan', 'temporal-context'].map((kind) => ({
        kind,
        artifactPath: `${producerId}/${kind}.json`,
        artifactDigest: digestCanonical([producerId, kind, 'fixture']),
        verificationReceiptPath: `${producerId}/${kind}.verification.json`,
        verificationReceiptDigest: digestCanonical([producerId, kind, 'fixture-verification'])
    }));
}

// This verifier is deliberately a test double. Production must supply the
// existing independent external owner, never infer verification from a digest.
export function fixtureVerifyAuthority(reference)
{
    const producerId = reference.artifactPath.split('/')[0];
    const expected = fixtureAuthorities(producerId).find((item) => item.kind === reference.kind);
    return {
        verified: JSON.stringify(reference) === JSON.stringify(expected),
        authorityDigest: expected.artifactDigest,
        verificationReceiptDigest: expected.verificationReceiptDigest,
        identity: { ...fixtureIdentity, producerId }
    };
}

export function fixtureProducer(producerId, logicalParentId, sourcePath, symbol)
{
    const authorities = Object.fromEntries(fixtureAuthorities(producerId).map((ref) => [ref.kind, ref.artifactDigest]));
    const ref = { path: 'tests/matrix.yml', digest: sha256(fs.readFileSync(path.join(fixtureRoot, 'tests/matrix.yml'))) };
    return {
        producerId, kind: 'atomic-producer', logicalParentId,
        commandSourceRef: { path: sourcePath, digest: sha256(fs.existsSync(path.join(fixtureRoot, sourcePath)) ? fs.readFileSync(path.join(fixtureRoot, sourcePath)) : 'DATA_ONLY pending source'), symbol },
        commandDigest: digestCanonical(fixtureCommand), inputClosureRef: { ...ref },
        attemptPolicyId: 'correctness-first-attempt', executionClass: 'correctness', fixtureProfile: 'none',
        stateAccessRef: { ...ref }, resourceContractRef: { ...ref }, dependsOn: [], settledDependsOn: [],
        executionEnvelopeDigest: authorities['execution-envelope'], replayPlanDigest: authorities['replay-plan'], temporalContextDigest: authorities['temporal-context']
    };
}

export function fixtureInput(lane = 'backend-test-governance', readinessMode = null)
{
    const governance = lane === 'backend-test-governance';
    const declarations = governance ? [
        fixtureProducer('backend-source-file-size', lane, suite, 'RunBackendSourceFileSizeCheckOnce'),
        fixtureProducer('backend-test-governance', lane, suite, 'RunBackendTestGovernanceCheckOnce'),
        fixtureProducer('postgres-test-collections', lane, suite, 'RunPostgresTestCollectionsCheckOnce')
    ] : [
        fixtureProducer('backend-perf-governance', lane, 'tools/test/backend-atomic-outcomes.mjs', 'projectBackendGovernanceOutcomes'),
        fixtureProducer('backend-perf-native-p99', lane, suite, 'RunBackendPerfNativeP99Only'),
        fixtureProducer('backend-perf-readiness', lane, readinessMode === 'build' ? 'tools/test/ensure-benchmark-release-build.sh' : 'tools/test/verify-benchmark-build-ready.mjs', null)
    ];
    const releasePrerequisite = governance ? null : fixtureProducer('backend-release-test-build', 'backend-build', suite, 'EnsureBackendFilteredBuild');
    if (!governance)
    {
        declarations[0].settledDependsOn = ['backend-governance-summary'];
        declarations[1].executionClass = 'benchmark';
        declarations[1].dependsOn = [releasePrerequisite.producerId];
        declarations[1].settledDependsOn = ['backend-perf-governance', 'backend-perf-readiness'];
    }
    declarations.push({
        producerId: governance ? 'backend-governance-summary' : 'backend-perf-summary',
        kind: 'settled-join', logicalParentId: lane, dependsOn: [],
        settledDependsOn: declarations.map((entry) => entry.producerId).sort()
    });
    return { lane, identity: { ...fixtureIdentity }, readinessMode, buildConfiguration: governance ? null : 'Release', releasePrerequisite, declarations };
}

export function fixtureCommandFor(scenario)
{
    return [...fixtureCommand.slice(0, -1), scenario];
}

export function fixtureArtifactCommand(artifacts, exitCode = 0)
{
    const source = `const fs = require('node:fs');
const artifacts = ${JSON.stringify(artifacts)};
for (const [name, document] of Object.entries(artifacts)) fs.writeFileSync(process.env.FSUSBLOG_ATTEMPT_ARTIFACT_ROOT + '/' + name, JSON.stringify(document));
fs.writeFileSync(process.env.FSUSBLOG_ATTEMPT_RESULT_PATH, JSON.stringify({schema:'fsusblog.test-attempt-result.v1',failureClass:${exitCode ? "'product'" : 'null'},failureKind:${exitCode ? "'assertion-mismatch'" : 'null'},failedTestIds:[],executedTestIds:[],artifactPaths:Object.keys(artifacts)}));
process.exitCode = ${exitCode};`;
    return [process.execPath, '-e', source];
}

export async function fixtureAttempt(evidenceRoot, declaration, { scenario = 'success', command = null } = {})
{
    const result = await runProducerAttempts({
        evidenceRoot, producerId: declaration.producerId, retryPolicyId: 'correctness-first-attempt',
        ...fixtureIdentity, command: command ?? fixtureCommandFor(scenario),
        cwd: fixtureRoot, env: { PATH: process.env.PATH },
        authorityReferences: fixtureAuthorities(declaration.producerId), verifyAuthority: fixtureVerifyAuthority,
        expectedTestIds: ['fixture:attempt-runner'], timeoutMs: 5000
    });
    const receiptFile = path.join(result.producerRoot, 'attempt-1/receipt.json');
    return { producerId: declaration.producerId, attemptRef: {
        path: path.relative(evidenceRoot, receiptFile).replaceAll(path.sep, '/'), digest: sha256(fs.readFileSync(receiptFile))
    } };
}
