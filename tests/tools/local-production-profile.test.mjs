import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await import(
    pathToFileURL(path.join(root, 'tools/test/run-mixed-performance-window.mjs')).href
);
await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/fresh-production.mjs')).href
);
await import(pathToFileURL(path.join(root, 'tools/test-matrix/local-profile.mjs')).href);
const { parseMatrix } = await import(pathToFileURL(path.join(root, 'tools/test-matrix/parse-matrix.mjs')).href);
const {
    runLocalProfile
} = await import(pathToFileURL(path.join(root, 'tools/run-test-matrix.mjs')).href);
await import(
    pathToFileURL(path.join(root, 'tools/testing/fixture-catalog.mjs')).href
);
const { acquireProductionFreshExclusiveLease } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/production-fresh-exclusive-lease.mjs')).href
);
const { acquireProductionCapacityReservation } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/production-capacity-reservation.mjs')).href
);


function verifiedBehaviorDocAdmissionRuntime(repositoryRoot, runId, sourceState)
{
    const contentDigest = `sha256:${'d'.repeat(64)}`;
    return {
        behaviorDocStaticAdmission: {
            receiptFile: path.join(
                repositoryRoot,
                '.tmp/behavior-doc-static-admission/receipt.json'
            ),
            runId,
            contentDigest
        },
        behaviorDocSourceIdentity: () => sourceState,
        readBehaviorDocStaticAdmissionReceipt: () => ({ contentDigest })
    };
}

const localBundleRunner = fs.readFileSync(path.join(root, 'tools/test/bundles/run-bundle.mjs'), 'utf8');
const matrixRunner = fs.readFileSync(path.join(root, 'tools/run-test-matrix.mjs'), 'utf8');



test('local production runner attaches the logical projection only after fresh physical evidence is complete', () =>
{
    const localProfileRunner = matrixRunner.slice(
        matrixRunner.indexOf('function writeSummaryOnlyEvidence('),
        matrixRunner.indexOf('\nasync function runCiJob(')
    );
    const freshProjectionRunner = localProfileRunner.slice(localProfileRunner.indexOf('await runDag({'));
    const orderedMarkers = [
        'await runDag({',
        'const projectionInput = projectLocalBundleSummaries(',
        'const summaryOnlyEvidence = writeSummaryOnlyEvidence(',
        'buildLocalProfileProjection({',
        'attachCheckpointEvidence('
    ].map((marker) => freshProjectionRunner.indexOf(marker));

    assert.ok(orderedMarkers.every((index) => index >= 0));
    assert.deepEqual(orderedMarkers, [...orderedMarkers].sort((left, right) => left - right));
    assert.match(localProfileRunner, /if \(result\.status === 'success' && !options\.resume\)[\s\S]*?attachCheckpointEvidence/u);
    assert.doesNotMatch(localProfileRunner, /fresh-only/u);
    assert.match(localProfileRunner, /readProductionResumeCheckpointAuthority\(admissionRunIdentity\)/u);
    assert.match(localProfileRunner, /capacityIdentity: productionResumeAuthority\.authorityDigest/u);
    assert.match(localProfileRunner, /assertProductionResumeCheckpointAuthorityStable\(productionResumeAuthority, resumeIdentity\)[\s\S]*?resumeEvidence\(checkpointPath[\s\S]*?fresh-projection-resume/u);
    assert.match(localProfileRunner, /guardProducer\('logical-projection-resume'\)[\s\S]*?createProductionFreshOutputRoot\([\s\S]*?resumeEvidence\(checkpointPath[\s\S]*?beforeCommit: async[\s\S]*?finalizeProductionFreshAttempt\([\s\S]*?completeProducer\([\s\S]*?'logical-projection-resume'/u);
    assert.match(localProfileRunner, /physical resume run=\$\{runId\}/u);
    assert.match(localProfileRunner, /runProductionBuildLifecycle\(\{[\s\S]*?prepareOptions: \{[\s\S]*?fresh: !options\.resume/u);
    assert.match(localProfileRunner, /mode: options\.resume \? 'resume' : 'fresh'/u);
    assert.match(localProfileRunner, /resume: options\.resume/u);
    assert.match(localProfileRunner, /reuseAcrossSourceChanges: false/u);
    assert.match(matrixRunner, /function resetResumeRunCoordination\(runsRoot, runId\)[\s\S]*?entry\.name === 'checkpoint\.json'[\s\S]*?removed\.sort\(\)/u);
    assert.match(localProfileRunner, /resetResumeRunCoordination\(runsRoot, runId\)/u);
    assert.match(localProfileRunner, /resume source changed; reset run-bound artifact digest table and \$\{removedCoordination\.length\} coordination file/u);
    assert.match(localProfileRunner, /FSUSBLOG_TEST_EXECUTION_SOURCE: options\.resume \? 'resume' : 'fresh'/u);
    assert.match(localProfileRunner, /executionSource: options\.resume \? 'resume' : 'fresh'/u);
    assert.match(localProfileRunner, /if \(result\.status === 'success' && !options\.resume\)/u);
    assert.match(localBundleRunner, /executionSource: process\.env\.FSUSBLOG_TEST_EXECUTION_SOURCE === 'resume' \? 'resume' : 'fresh'/u);
    assert.match(localProfileRunner, /resume-build-layout\.json/u);
    assert.match(localProfileRunner, /authoritative: false/u);
    assert.match(localProfileRunner, /if \(options\.resume\)\s*\{[\s\S]*?\}\s*else\s*\{[\s\S]*?emitProductionResourceUtilization/u);
    assert.match(localProfileRunner, /const resolvedLogicalMatrix = \{[\s\S]*?tiers: resolveLogicalTierResources\(matrix\.tiers, detectedResources\)[\s\S]*?projectLocalBundleSummaries\([\s\S]*?resolvedLogicalMatrix,[\s\S]*?tiers: resolvedLogicalMatrix\.tiers/u);
    assert.match(localProfileRunner, /writeSummaryOnlyEvidence\([\s\S]*?profileId,[\s\S]*?profile,[\s\S]*?runId,[\s\S]*?lockedCheckpoint\.sourceState,[\s\S]*?artifactTable\)/u);
    assert.match(localProfileRunner, /artifactTable\.finalize\([\s\S]*?production-artifact-digest-table\.json/u);
    assert.match(localProfileRunner, /collectFailures: true/u);
    assert.match(localProfileRunner, /failures: result\.checkpoint\.failures/u);
    assert.match(localProfileRunner, /independent failure\(s\) collected/u);
    assert.match(localProfileRunner, /const leaseSourceState = await \(runtime\.snapshotSourceState \?\? snapshotSourceState\)\(profileRoot\)[\s\S]*?acquireProductionFreshExclusiveLease\(\{[\s\S]*?sourceState: leaseSourceState[\s\S]*?const cleanupSource = runtime\.productionFreshSourceState[\s\S]*?executeProductionFreshPreflight\(\{[\s\S]*?receiptDirectory: runtime\.receiptDirectory[\s\S]*?fsusblog-runtime-cleanup-receipts[\s\S]*?additionalCleanup: runtime\.additionalCleanup,/u);
    assert.match(localProfileRunner, /productionFreshLeaseOwner: lease\.owner[\s\S]*?cleanLocalProductionOutputs\)\(profileRoot, \{[\s\S]*?runId,[\s\S]*?ownerIdentity: runtime\.productionFreshLeaseOwner/u);
    assert.match(localProfileRunner, /envForTier\(tier\)[\s\S]*?productionFreshEnvironmentForPhysicalTier\(runOutputs, tier\)/u);
    assert.match(localProfileRunner, /const scheduledPhysicalTiers = prependManagedProductionBuildGc\(physicalTiers, runId, \{[\s\S]*?outputRoot: runOutputs\.outputRoot/u);
    assert.match(localProfileRunner, /freshRunDirectoryPreservation:[\s\S]*?productionFreshSchedulerRunDirectoryPreservation\(runOutputs\)/u);
    assert.match(localProfileRunner, /catch \(error\)\s*\{\s*runError = error;[\s\S]*?throw error;[\s\S]*?\}\s*finally\s*\{[\s\S]*?if \(runError !== null \|\| !result\)\s*\{[\s\S]*?recordCheckpointFailure\(/u);
    assert.match(localProfileRunner, /let postflightReceipt = null[\s\S]*?try\s*\{[\s\S]*?prepareNamespaceEnvironmentIfNeeded\([\s\S]*?runDag\([\s\S]*?finally\s*\{/u);
    assert.doesNotMatch(localProfileRunner, /fs\.writeFileSync\(result\.checkpointPath/u);
    assert.match(localProfileRunner, /if \(runError !== null \|\| finalizationError !== null\)[\s\S]*?status: 'failure'[\s\S]*?runtimeCleanup: result\.checkpoint\.runtimeCleanup[\s\S]*?fs\.writeFileSync\(summaryFile/u);
});
test('a rejected second Production Fresh invocation reaches no cleanup, container, port, or producer mutation', async (t) =>
{
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-profile-exclusive-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const profileRoot = path.join(directory, 'repository');
    fs.mkdirSync(profileRoot);
    execFileSync('git', ['init', '-q'], { cwd: profileRoot });
    fs.writeFileSync(path.join(profileRoot, '.gitignore'), '.tmp/\n');
    fs.writeFileSync(path.join(profileRoot, 'tracked'), 'tracked\n');
    fs.mkdirSync(path.join(profileRoot, 'nested'));
    fs.writeFileSync(path.join(profileRoot, 'nested/untracked'), 'untracked\n');
    execFileSync('git', ['add', '.gitignore', 'tracked'], { cwd: profileRoot });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: profileRoot });
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` };
    const runId = 'production-exclusive-a';
    const lease = acquireProductionFreshExclusiveLease({
        root: profileRoot,
        runId,
        targetTierId: 'production',
        sourceState,
        heartbeatEveryMs: 60_000,
        verifyDescendants: () => ({ status: 'verified', identities: [] })
    });
    t.after(() =>
    {
        try
        {
            lease.release();
        }
        catch
        {
            // The assertion path may already release the lease.
        }
    });
    const ownerFile = path.join(lease.leasePath, 'owner.json');
    const before = {
        files: [
            fs.readFileSync(path.join(profileRoot, 'tracked'), 'utf8'),
            fs.readFileSync(path.join(profileRoot, 'nested/untracked'), 'utf8'),
            fs.readFileSync(ownerFile, 'utf8')
        ],
        processes: [{ pid: lease.owner.pid, start: lease.owner.processStartIdentity }],
        containers: [{ id: 'fresh-a', state: 'running' }],
        ports: [{ port: 54321, ownerPid: lease.owner.pid }]
    };
    const mutations = {
        runtimeCleanup: 0,
        additionalCleanup: 0,
        outputCleanup: 0,
        producerSpawn: 0
    };
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    await assert.rejects(
        runLocalProfile(matrix, 'production', { resume: false, planOnly: false, maxParallel: null }, {
            root: profileRoot,
            ...verifiedBehaviorDocAdmissionRuntime(
                profileRoot,
                'production-exclusive-b',
                sourceState
            ),
            schedulerRunIdentity: () => ({
                runsRoot: path.join(profileRoot, '.tmp/test-runs'),
                runId: 'production-exclusive-b'
            }),
            snapshotSourceState: async () => sourceState,
            cleanupRuntime: () =>
            {
                mutations.runtimeCleanup += 1;
                return {};
            },
            additionalCleanup: () =>
            {
                mutations.additionalCleanup += 1;
                return [];
            },
            cleanLocalProductionOutputs: () =>
            {
                mutations.outputCleanup += 1;
                return {};
            },
            executeTier: () =>
            {
                mutations.producerSpawn += 1;
            }
        }),
        /production fresh lease already active/u
    );
    const after = {
        files: [
            fs.readFileSync(path.join(profileRoot, 'tracked'), 'utf8'),
            fs.readFileSync(path.join(profileRoot, 'nested/untracked'), 'utf8'),
            fs.readFileSync(ownerFile, 'utf8')
        ],
        processes: [{ pid: lease.owner.pid, start: lease.owner.processStartIdentity }],
        containers: [{ id: 'fresh-a', state: 'running' }],
        ports: [{ port: 54321, ownerPid: lease.owner.pid }]
    };
    assert.deepEqual(after, before);
    assert.deepEqual(mutations, {
        runtimeCleanup: 0,
        additionalCleanup: 0,
        outputCleanup: 0,
        producerSpawn: 0
    });
});

test('local production run keeps a blocked invocation sealed after its run directory is rebuilt', async (t) =>
{
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-profile-blocked-ledger-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const profileRoot = path.join(directory, 'repository');
    fs.mkdirSync(profileRoot);
    execFileSync('git', ['init', '-q'], { cwd: profileRoot });
    fs.writeFileSync(path.join(profileRoot, '.gitignore'), '.tmp/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: profileRoot });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: profileRoot });
    const receiptDirectory = path.join(directory, 'runtime-cleanup-receipts');
    const runsRoot = path.join(profileRoot, '.tmp/test-runs');
    const runId = 'production-blocked-ledger';
    const invocationId = 'production-blocked-ledger-invocation';
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const options = { resume: false, planOnly: false, maxParallel: null };
    let cleanupAttempts = 0;
    let producerStarts = 0;
    const runtime = {
        root: profileRoot,
        ...verifiedBehaviorDocAdmissionRuntime(profileRoot, runId, sourceState),
        invocationId,
        receiptDirectory,
        wallClockStartedAtMs: Date.now() - 100,
        schedulerRunIdentity: () => ({ runsRoot, runId }),
        snapshotSourceState: async () => sourceState,
        detectedResources: {
            cpuCount: 8,
            availableCpuUnits: 8,
            availableMemoryGiB: 15,
            load1: 0,
            launchParallelism: 8,
            memoryReserveGiB: 1
        },
        resolveDockerRoot: () => directory,
        resolveFilesystem: (candidate) => ({
            filesystemIdentity: 'fixture:production-capacity',
            canonicalPath: path.resolve(candidate),
            availableBytes: 128 * 1024 ** 3
        }),
        acquireProductionCapacityReservation: (reservationOptions) =>
            acquireProductionCapacityReservation({
                ...reservationOptions,
                remeasureFilesystem: (filesystem) => filesystem.observedFreeBytes
            }),
        cleanupRuntime: () =>
        {
            cleanupAttempts += 1;
            return {
                namespaces: [],
                cleanups: [],
                untrackedContainerRecords: [],
                orphanProcessRecords: [],
                operationFailures: cleanupAttempts === 1
                    ? [{ stage: 'preflight-inventory-cleanup', message: 'injected blocked attempt' }]
                    : []
            };
        },
        additionalCleanup: () => [],
        cleanLocalProductionOutputs: () =>
        {
            producerStarts += 1;
            throw new Error('producer must not start for a sealed blocked invocation');
        }
    };

    await assert.rejects(
        runLocalProfile(matrix, 'production', options, runtime),
        /runtime cleanup preflight blocked/u
    );
    assert.equal(cleanupAttempts, 1);
    assert.equal(producerStarts, 0);

    const ledgerRoot = `${receiptDirectory}.attempt-ledgers`;
    const [ledgerRunId] = fs.readdirSync(ledgerRoot)
        .filter((entry) => entry !== '.locks');
    const ledgerFile = path.join(ledgerRoot, ledgerRunId, 'checkpoint.json');
    const sealedLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    assert.equal(sealedLedger.runtimeCleanupAttemptLedger.status, 'blocked');
    assert.equal(sealedLedger.runtimeCleanupAttemptLedger.attempts.length, 1);
    assert.equal(sealedLedger.runtimeCleanupAttemptLedger.attempts[0].status, 'blocked');
    const ledgerJournal = fs.readFileSync(
        path.join(ledgerRoot, ledgerRunId, 'evidence-store/journals', `${ledgerRunId}.jsonl`),
        'utf8'
    ).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(ledgerJournal.map((entry) => entry.eventType), ['runtime-cleanup-attempt-sealed']);
    assert.equal(fs.existsSync(path.join(ledgerRoot, '.locks', `${ledgerRunId}.lock`)), false);

    fs.rmSync(path.join(runsRoot, runId), { recursive: true, force: true });
    await assert.rejects(
        runLocalProfile(matrix, 'production', { ...options, resume: true }, runtime),
        /runtime cleanup preflight blocked/u
    );

    assert.equal(cleanupAttempts, 1, 'the complete retry must not run after the authority reads a sealed block');
    assert.equal(producerStarts, 0);
    const rebuiltCheckpoint = JSON.parse(fs.readFileSync(
        path.join(runsRoot, runId, 'checkpoint.json'),
        'utf8'
    ));
    assert.equal(rebuiltCheckpoint.status, 'failure');
    assert.equal(rebuiltCheckpoint.runtimeCleanup.preflight.status, 'blocked');
    assert.equal(fs.existsSync(path.join(runsRoot, runId, 'logs')), false);
    const rebuiltSummary = JSON.parse(fs.readFileSync(
        path.join(runsRoot, runId, 'preflight/summary.json'),
        'utf8'
    ));
    assert.equal(rebuiltSummary.status, 'failure');
    assert.equal(rebuiltSummary.runtimeCleanup.preflight.status, 'blocked');
    const unchangedLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    assert.equal(unchangedLedger.revision, sealedLedger.revision);
    assert.equal(unchangedLedger.runtimeCleanupAttemptLedger.attempts.length, 1);
});
