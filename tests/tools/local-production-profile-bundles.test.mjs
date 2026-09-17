import assert from 'node:assert/strict';
import 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await import( pathToFileURL(path.join(root, 'tools/test/run-mixed-performance-window.mjs')).href );
const { cleanLocalProductionOutputs } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/fresh-production.mjs')).href
);
await import(pathToFileURL(path.join(root, 'tools/test-matrix/local-profile.mjs')).href);
const { parseMatrix } = await import(pathToFileURL(path.join(root, 'tools/test-matrix/parse-matrix.mjs')).href);
await import(pathToFileURL(path.join(root, 'tools/run-test-matrix.mjs')).href);
await import( pathToFileURL(path.join(root, 'tools/test-matrix/behavior-doc-static-admission-contract.mjs')).href );
await import( pathToFileURL(path.join(root, 'tools/testing/fixture-catalog.mjs')).href );
await import( pathToFileURL(path.join(root, 'tools/test-matrix/production-fresh-exclusive-lease.mjs')).href );
await import( pathToFileURL(path.join(root, 'tools/test-matrix/production-capacity-reservation.mjs')).href );

function cacheTransactionOwner(repositoryRoot)
{
    return {
        leaseId: 'lease-local-profile-test',
        ownerToken: 'token-local-profile-test',
        canonicalRepositoryRoot: fs.realpathSync(repositoryRoot),
        profile: 'production-fresh',
        candidateIdentityDigest: `sha256:${'a'.repeat(64)}`,
        pid: process.pid,
        processStartIdentity: 'local-profile-test',
        executableDigest: `sha256:${'b'.repeat(64)}`,
        commandDigest: `sha256:${'c'.repeat(64)}`,
        processGroupOrJobIdentity: { kind: 'unix-process-group', processGroupId: process.pid }
    };
}


const localBundleRunner = fs.readFileSync(path.join(root, 'tools/test/bundles/run-bundle.mjs'), 'utf8');
const localBundleSteps = fs.readFileSync(path.join(root, 'tools/test/bundles/bundle-steps.mjs'), 'utf8');
const backendShardRunner = fs.readFileSync(path.join(root, 'tools/test/run-backend-production-shards.mjs'), 'utf8');
const matrixRunner = fs.readFileSync(path.join(root, 'tools/run-test-matrix.mjs'), 'utf8');
const backendBundleRunner = localBundleRunner.slice(
    localBundleRunner.indexOf('async function runBackendTests()'),
    localBundleRunner.indexOf('\nfunction listFiles(')
);
const frontendBundleRunner = localBundleRunner.slice(
    localBundleRunner.indexOf('async function runFrontendTests()'),
    localBundleRunner.indexOf('\nasync function run()')
);



test('backend bundle exposes run-bound readiness and exact-union contracts', () =>
{
    assert.match(backendBundleRunner, /commandStep\('dotnet-restore',[\s\S]*?dotnet restore tests\/FsusBlog\.ProductionBackend\.slnx/u);
    assert.equal([...localBundleRunner.matchAll(/\bdotnet restore\b/gu)].length, 1);
    assert.match(backendBundleRunner, /commandStep\('backend-server-build',[\s\S]*?dotnet build src\/backend\/FsusBlog\.Server\.csproj -c Release[^\n]*--no-restore/u);
    assert.match(localBundleRunner, /const liveGrant = schedulerResourceGrant\(\)[\s\S]*?inheritedCpuBudget: liveGrant\?\.cpuUnits \?\? process\.env\.FSUSBLOG_BUNDLE_CPU_BUDGET,[\s\S]*?inheritedMemoryGiB: liveGrant\?\.memoryGiB \?\? process\.env\.FSUSBLOG_BUNDLE_MEMORY_GIB,[\s\S]*?cpuWeight: bundle\.cpuWeight/u);
    assert.match(backendBundleRunner, /dotnet build src\/backend\/FsusBlog\.Server\.csproj[^\n]*\/m:"\$FSUSBLOG_STEP_CPU_BUDGET"/u);
    assert.match(backendBundleRunner, /await executeStep\(backendBuildStep\)[\s\S]*?publishBackendBuildReady\(\)[\s\S]*?commandStep\('backend-tests-build'[\s\S]*?--no-restore[\s\S]*?commandStep\('backend-benchmark-build'[\s\S]*?--no-restore[\s\S]*?await executeBundleStepDag/u);
    assert.match(backendBundleRunner, /commandStep\('backend-tests-build',[\s\S]*?--no-restore --no-dependencies --no-incremental/u);
    assert.match(backendBundleRunner, /commandStep\('backend-benchmark-build',[\s\S]*?--no-restore --no-dependencies/u);
    assert.match(backendBundleRunner, /await executeStep\(testsBuildStep\)[\s\S]*?await executeStep\(benchmarkBuildStep\)[\s\S]*?const testStep/u);
    assert.match(backendBundleRunner, /commandStep\('backend-tests-build',[\s\S]*?afterSuccess: publishBackendTestsReady/u);
    assert.match(backendBundleRunner, /const testStep = commandStep\('dotnet-production-union',[\s\S]*?afterSuccess: publishBackendTestsReady/u);
    assert.match(localBundleRunner, /if \(typeof step\.afterSuccess === 'function'\)\s*\{\s*await step\.afterSuccess\(result\);\s*\}[\s\S]*?stepExecutionResults\.set\(step\.id/u);
    assert.match(backendBundleRunner, /commandStep\('backend-benchmark-build'[\s\S]*?afterSuccess: publishBenchmarkBuildReady/u);
    assert.match(backendBundleRunner, /FSUSBLOG_BACKEND_CPU_BUDGET="\$FSUSBLOG_STEP_CPU_BUDGET" node tools\/test\/run-backend-production-shards\.mjs/u);
    assert.match(backendBundleRunner, /const testStep = commandStep\('dotnet-production-union',[\s\S]*?minCpuUnits: 2,[\s\S]*?minMemoryGiB: backendTopologyDefaults\.memoryGiBPerTesthost \* 2/u);
    assert.doesNotMatch(backendBundleRunner, /FSUSBLOG_BACKEND_PRODUCTION_SHARDS=\d|FSUSBLOG_BACKEND_SHARD_PROCESSORS=\d/u);
    assert.match(backendShardRunner, /Category!=Integration&Category!=Performance/u);
    assert.match(backendShardRunner, /'--ListTests'/u);
    assert.match(backendShardRunner, /validateExactProductionUnion\(testNames, recordsByShard,[\s\S]*?authoritativeRecords/u);
    assert.match(backendShardRunner, /executionMode: 'expandable-exact-partitions'/u);
    assert.doesNotMatch(backendShardRunner, /const postludeResult|governance-postlude\.trx/u);
    assert.match(backendBundleRunner, /await executeWave\(\[[\s\S]*?commandStep\('services'[\s\S]*?commandStep\('dotnet-restore'/u);
    assert.match(backendBundleRunner, /await executeBundleStepDag\(\[[\s\S]*?testStep,[\s\S]*?commandStep\('perception-matrix'/u);
    assert.match(backendBundleRunner, /commandStep\('perception-matrix',[\s\S]*?dependsOn: \['dotnet-production-union'\]/u);
    assert.match(backendBundleRunner, /commandStep\('perception-evidence-finalize',[\s\S]*?dependsOn: \['perception-matrix'\]/u);
    assert.match(backendBundleRunner, /commandStep\('backend-coverage-summary',[\s\S]*?dependsOn: \['dotnet-production-union'\]/u);
    assert.match(backendBundleRunner, /const distributedContractClasses = \[[\s\S]*?'DistributedContractFastTests'[\s\S]*?'ArticleMutationOutboxFailurePropagationTests'[\s\S]*?\]/u);
    assert.match(backendBundleRunner, /tierId === 'distributed-contract-fast'[\s\S]*?distributedContractClasses\.some/u);
    assert.doesNotMatch(backendBundleRunner, /commandStep\('benchmark-readiness-build'/u);
    assert.match(localBundleRunner, /benchmark-build-ready\.v1[\s\S]*?schedulerRunId: runId[\s\S]*?artifact\.digests[\s\S]*?artifactRef/u);
    const benchmarkReadyVerifier = fs.readFileSync(path.join(root, 'tools/test/verify-benchmark-build-ready.mjs'), 'utf8');
    assert.match(benchmarkReadyVerifier, /FSUSBLOG_TEST_RUN_ID[\s\S]*?benchmark-build-ready\.json[\s\S]*?digestDeclaredOutputs/u);
    assert.doesNotMatch(backendBundleRunner, /await executeStep\(commandStep\('perception-matrix'/u);
    assert.match(backendBundleRunner, /commandStep\('perception-evidence-finalize',[\s\S]*?FSUSBLOG_PERCEPTION_RUNTIME_EVIDENCE_FILE[\s\S]*?FSUSBLOG_PERCEPTION_RELEASE_EVIDENCE_FILE[\s\S]*?FSUSBLOG_PERCEPTION_MATRIX_SUMMARY_FILE/u);
    assert.match(localBundleRunner, /readPerceptionUnionProjection[\s\S]*?schedulerRunId\(\)[\s\S]*?testDll[\s\S]*?unionSummary[\s\S]*?expectedTrxDigests[\s\S]*?outcome !== 'Passed'/u);
    assert.match(backendBundleRunner, /writeIntegrityProofProducer\(/u);
    assert.match(backendBundleRunner, /projectEvidence\(/u);
    assert.match(backendBundleRunner, /integrity-proof-verification\.json/u);
    assert.match(backendBundleRunner, /commandStep\('backend-benchmark-build'/u);
    assert.match(frontendBundleRunner, /node tools\/test\/run-frontend-vitest-rolling-shards\.mjs/u);
    assert.match(frontendBundleRunner, /vitest-production-projects'[\s\S]*?dependsOn: \['frontend-early-test-capacity-ready'\],[\s\S]*?cpuWeight: 2,[\s\S]*?memoryWeight: 1\.5,[\s\S]*?minCpuUnits: resolvedFrontendVitestAdmissionFloor\(\)/u);
    assert.doesNotMatch(frontendBundleRunner, /FSUSBLOG_VITEST_TARGET_WORKERS/u);
    assert.match(localBundleRunner, /resolveFrontendVitestAdmissionFloor\(\{ cpuCount, eventualFrontendCapacity \}\)/u);
    assert.match(localBundleRunner, /function resolvedFrontendEarlyTestCpuTarget\(\)\s*\{[\s\S]*?currentCpuUnits >= 3 \? currentCpuUnits - 1 : currentCpuUnits/u);
    assert.match(frontendBundleRunner, /frontend-early-test-capacity-ready'[\s\S]*?coordinationOnly: true/u);
    assert.doesNotMatch(frontendBundleRunner, /commandStep\('frontend-test-capacity-ready'/u);
    assert.match(frontendBundleRunner, /static-governance-concurrent'[\s\S]*?repository-governance-authority\.mjs run application-static-governance'[\s\S]*?resources: \{ cpuWeight: 1, memoryWeight: 0\.5, minCpuUnits: 1 \}/u);
    assert.doesNotMatch(frontendBundleRunner, /static-governance-node-contracts'/u);
    assert.match(frontendBundleRunner, /static-governance-post-vitest'[\s\S]*?repository-governance-authority\.mjs ensure test-asset-governance'[\s\S]*?dependsOn: \['vitest-settled'\]/u);
    assert.match(frontendBundleRunner, /static-governance-concurrent'[\s\S]{0,240}?dependsOn: \['frontend-build-ready'\]/u);
    assert.match(frontendBundleRunner, /commandStep\('frontend-build-ready',[\s\S]*?resources: \{ coordinationOnly: true \}/u);
    assert.match(frontendBundleRunner, /commandStep\('privacy-zk-contract-prebuild', 'tools\/test\/lanes\/privacy-zk-comment-matrix\.sh contract-prebuild', \[\],[\s\S]*?dependsOn: \['privacy-zk-canonical-receipts'\]/u);
    assert.match(frontendBundleRunner, /commandStep\('privacy-zk-contract', 'tools\/test\/lanes\/privacy-zk-comment-matrix\.sh contract-postbuild', \[\],[\s\S]*?dependsOn: \['frontend-build-ready', 'privacy-zk-contract-prebuild'\]/u);
    assert.match(localBundleRunner, /waitForBackendProductionSummaryReady[\s\S]*?backend-production-shards\.v2[\s\S]*?exactOnce[\s\S]*?allPassed[\s\S]*?validateShardSummaryArtifacts/u);
    assert.doesNotMatch(frontendBundleRunner, /privacy-zk-comment-matrix\.sh project-functional/u);
    assert.doesNotMatch(frontendBundleRunner, /privacy-zk-comment-matrix\.sh benchmark/u);
    assert.match(frontendBundleRunner, /vitest-production-perf-isolated'[\s\S]*?dependsOn: \['frontend-build-ready', 'vitest-settled'\]/u);
    assert.doesNotMatch(frontendBundleRunner, /waitForSiblingBundleSummaries\(\['build-static'\]\)[\s\S]*?vitest-production-perf-isolated/u);
    assert.match(frontendBundleRunner, /frontendPerfAdmissionEvidence = \{[\s\S]*?markerWaitDurationMs[\s\S]*?functional-budget-smoke-contention-aware[\s\S]*?waitsForBuildStaticSummary: false/u);
    assert.doesNotMatch(frontendBundleRunner, /waitForSiblingBundleSummaries\(\[[^\]]*backend-tests/u);
    assert.doesNotMatch(localBundleSteps, /resources:\s*\{[^\n}]*(?:cpuUnits|memoryGiB):/u);
    assert.doesNotMatch(localBundleRunner, /resources:\s*\{[^\n}]*(?:cpuUnits|memoryGiB):/u);
    assert.doesNotMatch(localBundleSteps, /referenceBundleResources|eight-core reference/u);
    assert.match(localBundleSteps, /step\('mixed-performance-window'[\s\S]*?backend-benchmark-regression/u);
    assert.doesNotMatch(localBundleSteps, /step\('backend-benchmark'/u);
    assert.match(localBundleSteps, /step\('runtime-integration'[\s\S]*?dependsOn: \['security-runtime-core'\]/u);
});

test('cold frontend static phases move to frontend-tests while build-static remains build focused', () =>
{
    const buildSteps = localBundleRunner.slice(
        localBundleRunner.indexOf('function buildStaticSteps()'),
        localBundleRunner.indexOf('\nfunction trxAttribute')
    );
    assert.doesNotMatch(buildSteps, /frontend-static-(?:blocking-prebuild|concurrent|postbuild|isolated|final|governance)/u);
    assert.match(buildSteps, /frontend-build[\s\S]*?exclusiveResources: \['build-output'\]/u);
    assert.match(buildSteps, /'production-build-artifacts'[\s\S]*?artifacts: \[[\s\S]*?releaseEvidenceFile\('production-build-cache\.json'\)[\s\S]*?releaseEvidenceFile\('production-build-cache', 'domains'\)/u);
    assert.match(frontendBundleRunner, /await executeStep\(staticStageStep\('blocking-prebuild',[\s\S]*?executeBundleStepDag/u);
    assert.match(frontendBundleRunner, /const frontendSteps = \[[\s\S]*?staticStageStep\('concurrent'[\s\S]*?executeBundleStepDag\(\s*frontendSteps/u);
    assert.match(frontendBundleRunner, /staticStageStep\('postbuild',[\s\S]*?dependsOn: \['frontend-build-ready'\]/u);
    assert.match(frontendBundleRunner, /staticStageStep\('isolated',[\s\S]*?dependsOn: \['vitest-settled'\]/u);
    assert.match(frontendBundleRunner, /commandStep\('frontend-static-final-ready',[\s\S]*?runAfterSettled: true,[\s\S]*?coordinationOnly: true/u);
    assert.match(frontendBundleRunner, /staticStageStep\('final',[\s\S]*?dependsOn: \['frontend-static-final-ready'\]/u);
    assert.match(localBundleRunner, /frontend-build-ready\.v1[\s\S]*?schedulerRunId: runId[\s\S]*?privacyWasmArtifacts[\s\S]*?artifactRef/u);
    assert.match(localBundleRunner, /validateFrontendBuildStageReceiptIdentity\(stageReceipt,[\s\S]*?runId,[\s\S]*?sourceState: currentSourceState\(\)/u);
    assert.match(localBundleRunner, /expectedFrontendBuildStages\(\)[\s\S]*?createFrontendBuildStages/u);
    assert.match(localBundleRunner, /criticalFrontendBuildStageOutputs[\s\S]*?frontendDistRoot[\s\S]*?frontendWasmRoot[\s\S]*?backendWebRoot/u);
    assert.match(localBundleRunner, /stageReceipt:[\s\S]*?path: stageReceiptPath[\s\S]*?digest:[\s\S]*?contentDigest:[\s\S]*?artifactRef:[\s\S]*?identity: stageReceiptIdentity/u);
    assert.match(localBundleRunner, /frontendDist:[\s\S]*?path: frontendDistPath[\s\S]*?digest:[\s\S]*?artifactRef:/u);
    assert.match(localBundleRunner, /backendWebRoot:[\s\S]*?path: backendWebRootPath[\s\S]*?digest:[\s\S]*?artifactRef:/u);
    assert.match(localBundleRunner, /if \(step\.id === 'sync-static-assets'\)\s*\{\s*publishFrontendBuildReady\(\);\s*\}/u);
    assert.match(localBundleRunner, /async function waitForFrontendBuildReady[\s\S]*?marker\.schedulerRunId !== expectedRunId[\s\S]*?digestArtifacts/u);
    assert.match(localBundleRunner, /async function waitForFrontendBuildReady[\s\S]*?validateFrontendBuildStageReceiptBinding\([\s\S]*?expectedPath: stageReceiptPath[\s\S]*?marker\.stageReceipt\.digest[\s\S]*?marker\.stageReceipt\.artifactRef/u);
    assert.match(localBundleRunner, /producerStepId: 'sync-static-assets'[\s\S]*?publishedAt/u);
    assert.match(localBundleRunner, /function publishFrontendBuildTerminal[\s\S]*?publishFrontendBuildTerminalMarker/u);
    assert.match(localBundleRunner, /function publishFrontendBuildTerminal[\s\S]*?validateExistingSuccess:[\s\S]*?validateFrontendBuildStageReceiptBinding/u);
    assert.match(localBundleRunner, /\['frontend-build', 'sync-static-assets'\]\.includes\(step\.id\)[\s\S]*?publishFrontendBuildTerminal\('failure'/u);
    assert.match(localBundleRunner, /if \(bundleId === 'build-static'\)\s*\{\s*publishFrontendBuildTerminal\('cancelled', signal\);\s*\}/u);
    assert.match(localBundleRunner, /function resolveMarkerPollIntervalMs\(\)[\s\S]*?bundleCapacity\(\)\.cpuUnits[\s\S]*?Math\.ceil\(1000 \/ cpuUnits\)/u);
});

test('runtime early start is guarded by run-bound backend frontend and production artifact markers', () =>
{
    assert.match(localBundleRunner, /backendBuildReadyFile[\s\S]*?\.tmp\/test-runs[\s\S]*?backend-build-ready\.json/u);
    assert.match(localBundleRunner, /publishBackendBuildReady[\s\S]*?schedulerRunId: runId[\s\S]*?serverDll:[\s\S]*?exists: true[\s\S]*?digest: artifact\.digests[\s\S]*?artifactRef/u);
    const backendTestsMarker = localBundleRunner.slice(
        localBundleRunner.indexOf('function publishBackendTestsReady()'),
        localBundleRunner.indexOf('\nfunction publishBenchmarkBuildReady')
    );
    assert.match(backendTestsMarker, /backend-tests-ready\.v1[\s\S]*?testDll:[\s\S]*?digest: artifact\.digests\[artifactPath\]/u);
    assert.match(backendTestsMarker, /contentDigest: fileContentDigest\(backendTestDll\)/u);
    assert.doesNotMatch(backendTestsMarker, /declaredDigest/u);
    assert.match(localBundleRunner, /writeFileSync\(temporary[\s\S]*?renameSync\(temporary, markerFile\)/u);
    assert.match(localBundleRunner, /async function waitForBackendBuildReady[\s\S]*?marker\.schema !== 'fsusblog\.local-production\.backend-build-ready\.v1'[\s\S]*?marker\.schedulerRunId !== expectedRunId[\s\S]*?digestArtifacts/u);
    assert.match(localBundleRunner, /async function waitForFrontendBuildReady[\s\S]*?marker\.schema !== 'fsusblog\.local-production\.frontend-build-ready\.v1'[\s\S]*?marker\.schedulerRunId !== expectedRunId[\s\S]*?digestArtifacts/u);
    assert.match(localBundleRunner, /production-build-artifacts-ready[\s\S]*?productionBuildReadyBindings[\s\S]*?repairReadOnlySeal: false/u);
    assert.match(localBundleRunner, /afterSuccess: \(\) => publishCurrentRunMarker\([\s\S]*?'production-build-artifacts-ready'/u);
    assert.match(localBundleRunner, /function buildLayoutBinding\(\)[\s\S]*?productionBuildLayoutDigest[\s\S]*?sourceFingerprint/u);
    assert.match(localBundleRunner, /benchmarkDll:[\s\S]*?digest: artifact\.digests\[artifactPath\][\s\S]*?contentDigest: fileContentDigest\(benchmarkDll\)[\s\S]*?artifactRef/u);
    assert.match(localBundleRunner, /async function waitForBenchmarkBuildReady[\s\S]*?digestArtifacts\(\[artifactPath\],[\s\S]*?marker\.benchmarkDll\?\.digest !== artifact\.digests\[artifactPath\][\s\S]*?marker\.benchmarkDll\?\.contentDigest !== fileContentDigest\(benchmarkDll\)[\s\S]*?marker\.benchmarkDll\?\.artifactRef !== artifact\.refs\[artifactPath\]/u);
    assert.match(localBundleRunner, /production-frontend-build-contract\.v1[\s\S]*?privacyWasmArtifacts[\s\S]*?generatedContract/u);
    assert.doesNotMatch(localBundleRunner, /generatedProverBundle/u);
    assert.match(localBundleRunner, /function producerFailure[\s\S]*?readSchedulerProducerTerminalFailure\(\{[\s\S]*?runId: schedulerRunId\(\)[\s\S]*?targetTierId: profileId[\s\S]*?sourceState: currentSourceState\(\)/u);
    assert.doesNotMatch(localBundleRunner, /checkpoint\.tiers\?\.\[`local-\$\{profileId\}-backend-tests`\]\?\.status/u);
    const backendBuildWait = localBundleRunner.slice(
        localBundleRunner.indexOf('async function waitForBackendBuildReady'),
        localBundleRunner.indexOf('\nasync function waitForBackendTestsReady')
    );
    assert.ok(backendBuildWait.indexOf('if (fs.existsSync(markerFile))') < backendBuildWait.indexOf("producerFailure('backend-tests')"));
    assert.match(localBundleRunner, /async function executeRuntimeStep[\s\S]*?backend-build-ready[\s\S]*?waitForBackendBuildReady[\s\S]*?frontend-build-ready[\s\S]*?waitForFrontendBuildReady/u);
    assert.match(localBundleRunner, /bundleId === 'runtime-browser' \? executeRuntimeStep : executePerformanceStep/u);
});

test('performance marker producers are exact and quiet markers publish only after bundle finalization', () =>
{
    assert.match(localBundleRunner, /function publishCurrentRunMarker\(markerId, actualProducerStepId\)[\s\S]*?bundleId !== producerBundleId[\s\S]*?actualProducerStepId !== producerStepId/u);
    assert.match(localBundleRunner, /function currentRunMarkerArtifacts[\s\S]*?backend-coverage-ready[\s\S]*?frontend-coverage-ready[\s\S]*?runtime-state-ready/u);
    assert.match(localBundleRunner, /async function waitForCurrentRunMarker[\s\S]*?artifacts: currentRunMarkerArtifacts\(markerId\)[\s\S]*?signal: shutdownController\.signal/u);
    const summaryPublished = localBundleRunner.lastIndexOf('writeBundleSummaryAtomically(summaryFile, summary)');
    const quietPublished = [...localBundleRunner.matchAll(
        /if \(quietMarker\)\s*\{\s*publishCurrentRunMarker\(\.\.\.quietMarker\);\s*\}/gu
    )].at(-1)?.index ?? -1;
    assert.ok(summaryPublished >= 0 && quietPublished > summaryPublished);
    assert.doesNotMatch(localBundleRunner.slice(localBundleRunner.indexOf('async function run()'), summaryPublished), /quiet-ready.*publishCurrentRunMarker/u);
    assert.match(localBundleRunner, /signal: shutdownController\.signal,[\s\S]*?exclusiveResources: bundle\.exclusiveResources/u);
    assert.match(localBundleRunner, /finalizeBundleResourceUtilization\('partial', new Error\(`bundle cancelled by/u);
    assert.match(localBundleRunner, /coordination:\s*\{[\s\S]*?status: shutdownController\.signal\.aborted \? 'cancelled' : 'failure'/u);
    assert.match(localBundleRunner, /async function executeBundleStepDag[\s\S]*?execution\.terminalReceipts[\s\S]*?error\?\.terminalReceipts/u);
    assert.match(localBundleRunner, /run\(\)\.catch[\s\S]*?status: 'partial'[\s\S]*?writeBundleSummaryAtomically\(summaryFile, partialSummary\)[\s\S]*?writePhysicalProducerReceipts\(\{[\s\S]*?status: 'partial'/u);
    assert.match(localBundleRunner, /producerId: `\$\{bundleId\}\/failure-finalizer`[\s\S]*?status: 'partial'/u);
});

test('bundle child processes inherit their admitted machine-resolved CPU and memory', () =>
{
    assert.match(localBundleRunner, /for \(const stalePhysicalWorkerCap of \[[\s\S]*?'FSUSBLOG_COMMAND_MANIFEST_WORKERS'[\s\S]*?'FSUSBLOG_VITEST_MAX_WORKERS'[\s\S]*?'FSUSBLOG_PLAYWRIGHT_WORKERS'[\s\S]*?delete childBaseEnvironment\[stalePhysicalWorkerCap\]/u);
    assert.match(localBundleRunner, /MSBUILDDISABLENODEREUSE: '1'/u);
    assert.match(matrixRunner, /tier\.physicalBundleId[\s\S]*?FSUSBLOG_BUNDLE_CPU_BUDGET = String\(workerBudget\)/u);
    assert.match(matrixRunner, /tier\.physicalBundleId[\s\S]*?FSUSBLOG_BUNDLE_MEMORY_GIB = String\(memoryGiB\)/u);
    assert.match(localBundleRunner, /schedulerResourceGrant\(\)[\s\S]*?inheritedCpuBudget: liveGrant\?\.cpuUnits \?\? process\.env\.FSUSBLOG_BUNDLE_CPU_BUDGET,[\s\S]*?inheritedMemoryGiB: liveGrant\?\.memoryGiB \?\? process\.env\.FSUSBLOG_BUNDLE_MEMORY_GIB/u);
    assert.match(localBundleRunner, /const stepCapacity = resolveStepRuntimeCapacity\(bundleId, step, bundleCapacity\(\)\)[\s\S]*?\.\.\.\(step\.env \?\? \{\}\),[\s\S]*?FSUSBLOG_STEP_CPU_BUDGET: String\(stepCapacity\.cpuUnits\),[\s\S]*?FSUSBLOG_STEP_MEMORY_GIB: String\(stepCapacity\.memoryGiB\),[\s\S]*?FSUSBLOG_BUNDLE_CPU_BUDGET: String\(stepCapacity\.maxParallel\),[\s\S]*?FSUSBLOG_BUNDLE_CPU_UNITS: String\(stepCapacity\.cpuUnits\),[\s\S]*?FSUSBLOG_BUNDLE_MEMORY_GIB: String\(stepCapacity\.memoryGiB\)/u);
    assert.match(localBundleRunner, /remainingBundleDeadlineMs[\s\S]*?baseTimeoutMs: remainingBundleDeadlineMs[\s\S]*?workload: step\.resources[\s\S]*?actualCapacity: stepCapacity[\s\S]*?FSUSBLOG_STEP_DEADLINE_MS: String\(stepDeadlineMs\)/u);
    assert.match(localBundleRunner, /frontend-runtime-contracts'[\s\S]*?FSUSBLOG_COMMAND_MANIFEST_WORKERS="\$FSUSBLOG_STEP_CPU_BUDGET"/u);
    assert.match(frontendBundleRunner, /FSUSBLOG_LOCAL_STATIC_PHASE=\$\{stage\}[\s\S]*?FSUSBLOG_COMMAND_MANIFEST_WORKERS="\$FSUSBLOG_STEP_CPU_BUDGET"/u);
    assert.doesNotMatch(localBundleRunner, /FSUSBLOG_COMMAND_MANIFEST_WORKERS=[34]\b/u);
});

test('bundle execution waits derive deadlines from matrix budgets and scheduler capacity', () =>
{
    assert.match(localBundleRunner, /function bundleDeadlineMs\(\)[\s\S]*?profile\.enforceBudget === false[\s\S]*?timeoutMinutes[\s\S]*?FSUSBLOG_BUNDLE_DEADLINE_MS[\s\S]*?Number\.isFinite\(deadlineMs\) && deadlineMs > 0[\s\S]*?baseTimeoutMs: profile\.budgetMs[\s\S]*?actualCapacity: bundleCapacity\(\)/u);
    assert.match(localBundleRunner, /function resolveExecutionWaitTimeoutMs\(dependencyBundleIds\)[\s\S]*?baseTimeoutMs: bundleDeadlineMs\(\)[\s\S]*?workload: bundle[\s\S]*?actualCapacity: bundleCapacity\(\)/u);
    assert.doesNotMatch(localBundleRunner, /bundle\.budgetMs|dependency\.budgetMs/u);
    assert.match(localBundleRunner, /waitForBackendBuildReady\(timeoutMs = resolveExecutionWaitTimeoutMs\(\['backend-tests'\]\)\)/u);
    assert.match(localBundleRunner, /waitForFrontendBuildReady\(timeoutMs = resolveExecutionWaitTimeoutMs\(\['build-static'\]\)\)/u);
    assert.match(localBundleRunner, /resolveMarkerPollIntervalMs\(\)/u);
    assert.doesNotMatch(localBundleRunner, /timeoutMs = 120_000/u);
});

test('production evidence is assigned to the earliest safe physical bundle without being omitted', () =>
{
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const bundles = new Map(matrix.localProfiles.production.bundles.map((bundle) => [bundle.id, bundle.members]));
    const deferred = [
        'backend-build-governance',
        'integrity-proof-verification',
        'perception-v2-test-matrix',
        'cross-stack-contract',
        'privacy-zk-comment-matrix',
        'aeds-frame-cost',
        'aeds-compression-profile'
    ];

    for (const tierId of deferred)
    {
        assert.equal(bundles.get('build-static').includes(tierId), false, tierId);
    }
    assert.ok(bundles.get('build-static').includes('ux-viewport-plan-progress'));
    assert.ok(bundles.get('frontend-tests').includes('static-governance'));
    assert.equal(bundles.get('build-static').includes('frontend-static-governance'), false);
    assert.ok(bundles.get('frontend-tests').includes('frontend-static-governance'));
    assert.match(localBundleRunner, /commandStep\('viewport-plan-progress', 'node tools\/ux\/run-viewport-plan-progress\.mjs', \['ux-viewport-plan-progress'\],[\s\S]*?viewport-plan-progress\.json/u);
    assert.match(frontendBundleRunner, /commandStep\('static-governance-concurrent', 'node tools\/governance\/repository-governance-authority\.mjs run application-static-governance', \['static-governance'\],[\s\S]*?cpuWeight: 1,[\s\S]*?memoryWeight: 0\.5,[\s\S]*?minCpuUnits: 1/u);
    assert.doesNotMatch(frontendBundleRunner, /commandStep\('static-governance-node-contracts'/u);
    assert.match(frontendBundleRunner, /commandStep\('static-governance-post-vitest', 'node tools\/governance\/repository-governance-authority\.mjs ensure test-asset-governance', \['static-governance'\],[\s\S]*?dependsOn: \['vitest-settled'\]/u);
    for (const tierId of ['backend-build-governance', 'integrity-proof-verification', 'perception-v2-test-matrix'])
    {
        assert.ok(bundles.get('backend-tests').includes(tierId), tierId);
    }
    assert.ok(bundles.get('runtime-browser').includes('cross-stack-contract'));
    assert.equal(bundles.get('frontend-tests').includes('privacy-zk-comment-matrix'), false);
    assert.ok(bundles.get('performance-evidence').includes('privacy-zk-comment-matrix'));
    assert.match(frontendBundleRunner, /commandStep\('privacy-zk-contract'[\s\S]*?privacy-zk-comment-matrix\.sh contract/u);
    assert.match(localBundleSteps, /step\('privacy-zk-project-functional'[\s\S]*?privacy-zk-comment-matrix\.sh project-functional/u);
    for (const tierId of ['aeds-frame-cost', 'aeds-compression-profile'])
    {
        assert.ok(bundles.get('performance-evidence').includes(tierId), tierId);
    }
});

test('fresh production cleanup removes outputs and preserves dependency caches', () =>
{
    const buildEnvironment = fs.readFileSync(path.join(root, 'tools/build-with-data-env.sh'), 'utf8');
    assert.match(buildEnvironment, /DEPENDENCY_CACHE_ROOT=.*\.tmp\/dependency-cache\/dotnet/u);
    assert.match(buildEnvironment, /DOTNET_CLI_HOME="\$\{DEPENDENCY_CACHE_ROOT\}\/dotnet-cli"/u);
    assert.match(buildEnvironment, /NUGET_PACKAGES="\$\{DEPENDENCY_CACHE_ROOT\}\/nuget\/packages"/u);
    assert.match(buildEnvironment, /NUGET_SCRATCH="\$\{DATA_ROOT\}\/tmp\/nuget-scratch"/u);
    const temp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-fresh-production-'));
    const generated = [
        '.tmp/stale/result.json',
        'src/frontend/coverage/unit/result.json',
        'src/frontend/test-results/result.json',
        'src/backend/Logs/log-20260712.txt'
    ];
    const legacyBuildOutputs = [
        'src/frontend/dist/index.html',
        'src/frontend/public/wasm/aeds_decoder_speed.wasm',
        'src/frontend/wasm/build-basic/aeds_decoder_basic.wasm',
        'src/backend/wwwroot/index.html',
        'src/backend/bin/Debug/server.dll',
        'src/core/obj/project.assets.json',
        'tests/backend/bin/Debug/tests.dll'
    ];
    const caches = [
        'src/frontend/node_modules/vitest/package.json',
        'src/frontend/wasm/.emscripten-cache/sysroot/cache.txt',
        '.tmp/emscripten-cache/sysroot/cache.txt',
        '.tmp/dependency-cache/dotnet/nuget/packages/example/package.nupkg',
        '.tmp/dependency-cache/dotnet/dotnet-cli/.dotnet/initialized',
        '.tmp/data-root/cache/dev/nuget/packages/example/package.nupkg',
        '.tmp/data-root/cache/dev/dotnet-cli/.dotnet/initialized',
        '.tmp/build/previous-run/layout.json',
        '.nuget/packages/cache.txt'
    ];
    for (const file of [...generated, ...legacyBuildOutputs, ...caches])
    {
        fs.mkdirSync(path.dirname(path.join(temp, file)), { recursive: true });
        fs.writeFileSync(path.join(temp, file), 'fixture');
    }

    const cleanup = cleanLocalProductionOutputs(temp, {
        runId: 'local-profile-cleanup-test',
        ownerIdentity: cacheTransactionOwner(temp)
    });

    for (const file of generated)
    {
        assert.equal(fs.existsSync(path.join(temp, file)), false, file);
    }
    for (const file of legacyBuildOutputs)
    {
        assert.equal(fs.existsSync(path.join(temp, file)), true, file);
    }
    for (const file of caches)
    {
        assert.equal(fs.existsSync(path.join(temp, file)), true, file);
    }
    assert.equal(cleanup.schema, 'fsusblog.fresh-production-cleanup.v1');
    assert.ok(cleanup.preservedRoots.includes('.tmp/build'));
});

test('fresh production cleanup preserves an external temp root and its dependency caches', () =>
{
    const temp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-fresh-production-link-'));
    const repositoryRoot = path.join(temp, 'repository');
    const externalTempRoot = path.join(temp, 'external', '.tmp');
    fs.mkdirSync(repositoryRoot, { recursive: true });
    fs.mkdirSync(externalTempRoot, { recursive: true });
    fs.symlinkSync(externalTempRoot, path.join(repositoryRoot, '.tmp'), 'dir');
    fs.mkdirSync(path.join(externalTempRoot, 'dependency-cache/dotnet'), { recursive: true });
    fs.mkdirSync(path.join(externalTempRoot, 'emscripten-cache/sysroot'), { recursive: true });
    fs.mkdirSync(path.join(externalTempRoot, 'stale'), { recursive: true });
    fs.writeFileSync(path.join(externalTempRoot, 'dependency-cache/dotnet/cache.txt'), 'cache');
    fs.writeFileSync(path.join(externalTempRoot, 'emscripten-cache/sysroot/cache.txt'), 'cache');
    fs.writeFileSync(path.join(externalTempRoot, 'stale/result.json'), '{}');

    cleanLocalProductionOutputs(repositoryRoot, {
        runId: 'local-profile-external-cleanup-test',
        ownerIdentity: cacheTransactionOwner(repositoryRoot)
    });

    assert.equal(fs.lstatSync(path.join(repositoryRoot, '.tmp')).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(externalTempRoot, 'stale')), false);
    assert.equal(fs.existsSync(path.join(externalTempRoot, 'dependency-cache/dotnet/cache.txt')), true);
    assert.equal(fs.existsSync(path.join(externalTempRoot, 'emscripten-cache/sysroot/cache.txt')), true);
});

test('acceptance services enforce a bounded log file size', () =>
{
    const source = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8');
    assert.match(source, /FSUSBLOG_ACCEPTANCE_LOG_MAX_KIB:-262144/u);
    assert.match(source, /ulimit -f "\$ACCEPTANCE_LOG_MAX_KIB"/u);
});

test('acceptance backend derives thread-pool capacity from machine CPUs and burst policy', () =>
{
    const source = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8');
    assert.match(source, /os\.availableParallelism\?\.\(\) \?\? os\.cpus\(\)\.length/u);
    assert.match(source, /Math\.ceil\(concurrency \/ cpu\)/u);
    assert.match(source, /RuntimeTuning__ThreadPool__Enabled=true/u);
    assert.match(source, /RuntimeTuning__ThreadPool__MinThreadsPerCpu=\$RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU/u);
    assert.doesNotMatch(source, /RuntimeTuning__ThreadPool__MinThreadsPerCpu=[0-9]/u);
});

test('acceptance bootstrap starts independent services within dynamic CPU and memory grants', () =>
{
    const source = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8');
    const publicFixtureSource = fs.readFileSync(path.join(root, 'tools/test-fixtures/producers/public-content-producer.mjs'), 'utf8');
    assert.match(source, /ResolveBootstrapParallelWorkers/u);
    assert.match(source, /resolveManifestLiveCapacity\(\{ env: process\.env, workload: 'scheduler-admitted' \}\)/u);
    assert.match(source, /readManifestSchedulerResourceGrant\(\{ env: process\.env \}\)/u);
    assert.match(source, /resolveManifestChildEnvironment/u);
    assert.match(source, /capacity update workers=\$workerCap->\$nextWorkerCap active=\$active/u);
    assert.match(source, /RunBootstrapParallel 'database services'[\s\S]*?postgres EnsurePostgres[\s\S]*?redis EnsureRedis/u);
    assert.match(source, /PrepareReleasePreviewBundle[\s\S]*?local -a runtimeApplications=\(debug-backend EnsureBackend\)[\s\S]*?runtimeApplications\+=\(release-preview EnsureReleasePreview debug-frontend EnsureDebugFrontend\)[\s\S]*?RunBootstrapParallel 'runtime applications'/u);
    assert.match(source, /InvokeFixtureOrchestrator/u);
    assert.match(source, /tools\/test-fixtures\/cli\.mjs/u);
    assert.doesNotMatch(source, /PrepareAuthFixturesOnce|PreparePublicFixturesOnce|PrepareRuntimeFixturesOnce|PrepareFixtures\s*\(/u);
    assert.doesNotMatch(source, /RunParallel "bootstrap-runtime-fixtures"/u);
    assert.doesNotMatch(source, /FLUSHDB|RefreshAcceptanceCacheAfterFixtures/u);
    assert.match(publicFixtureSource, /transaction-fixture/u);
    assert.match(publicFixtureSource, /public-content-fixture\/prepare/u);
    assert.doesNotMatch(publicFixtureSource, /seedPublicFixturesViaApi|buildSeededArticleFallback|seedPublicFixtures\s*\(/u);
    assert.match(source, /failures\+=\("\$\{labels\[\$index\]\} \(exit \$\{childStatus\}\)"\)/u);
    assert.doesNotMatch(source, /FSUSBLOG_BOOTSTRAP_(?:WORKERS|CPU|MEMORY)=[0-9]/u);
});

test('acceptance service ports use sealed role leases below the kernel ephemeral range and Vite cannot drift', () =>
{
    const source = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8');
    const leaseSource = fs.readFileSync(
        path.join(root, 'tools/test-matrix/production-fresh-port-lease.mjs'),
        'utf8'
    );
    for (const [role, minPort, maxPort] of [
        ['postgres', 20000, 21999],
        ['redis', 22000, 23999],
        ['debug-backend', 24000, 25999],
        ['debug-frontend', 26000, 27999],
        ['release-preview', 28000, 29999]
    ])
    {
        assert.match(
            leaseSource,
            new RegExp(`role: '${role}',[\\s\\S]*?minPort: ${minPort},[\\s\\S]*?maxPort: ${maxPort}`, 'u')
        );
    }
    assert.match(source, /PORT_LEASE_SCRIPT=.*production-fresh-port-lease\.mjs/u);
    assert.match(source, /\$PORT_LEASE_SCRIPT" serve/u);
    assert.match(source, /PortLeaseCli verify --manifest/u);
    assert.match(source, /PortLeaseCli release-before-bind/u);
    assert.match(source, /PortLeaseCli complete-handoff/u);
    assert.doesNotMatch(source, /FindFreePort/u);
    assert.equal((source.match(/--strictPort/gu) ?? []).length, 3);
    assert.equal((source.match(/--host 127\.0\.0\.1/gu) ?? []).length, 3);
    assert.match(source, /-p "127\.0\.0\.1:\$\{POSTGRES_PORT\}:5432"/u);
    assert.match(source, /-p "127\.0\.0\.1:\$\{REDIS_PORT\}:6379"/u);
    assert.match(source, /process exited before becoming ready at \$url/u);
});
