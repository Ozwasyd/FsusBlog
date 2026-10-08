import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { currentProcessIdentity, processIdentityStatus } = await import(new URL("../../tools/test/process-identity.mjs", import.meta.url));
const { bindProductionBuildLayoutSource, finalizeProductionBuildLayout, prepareProductionBuildLayout, registerProductionBuildCompiler } = await import(new URL("../../tools/test-matrix/production-build-layout.mjs", import.meta.url));
const { collectSchedulerProcessGroupOrJobIdentity, createSchedulerRunOwner, finalizeSchedulerRunOwner, heartbeatSchedulerRunOwner, readSchedulerProducerTerminalFailure, schedulerCandidateIdentityDigest, schedulerProcessGroupOrJobIdentityIsComplete, schedulerRunOwnerFields, schedulerRunOwnerSchema, sealSchedulerRunOwner, verifySchedulerProcessAuthority, verifySchedulerRunOwner } = await import(new URL("../../tools/test-matrix/scheduler-run-owner.mjs", import.meta.url));
const { findLatestRunId, reclaimSchedulerRunLock, runDag, schedulerRunLockActivity, schedulerRunLockIsActive } = await import(new URL("../../tools/test-matrix/scheduler.mjs", import.meta.url));
const { runWindowsJobSupervisorStateMachine, windowsJobSupervisorStateSchema } = await import(new URL("../../tools/test-matrix/windows-job-supervisor-state.mjs", import.meta.url));
const {
    acquireSchedulerRunLock,
    createSchedulerTierAdmission,
    schedulerTierAdmissionActivity,
    writeSchedulerTierAdmission
} = await import(new URL('../../tools/test-matrix/scheduler-run-owner.mjs', import.meta.url));
const { RunEvidenceObjectStore } = await import(new URL('../../tools/test-matrix/content-addressed-evidence-store.mjs', import.meta.url));

import {
    createBehaviorDocAdmissionFixture,
    prepareBehaviorDocAdmissionFixtureAuthority
} from './support/behavior-doc-admission-fixture.mjs';
import { materializeTestMatrixRunner } from './support/esm-fixture-materializer-contracts.mjs';
import { prepareSchedulerCliMatrixFixture } from './support/scheduler-cli-fixture.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fixture(t, name)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function materializeSchedulerCliRunner(root)
{
    const runner = materializeTestMatrixRunner(repositoryRoot, root);
    fs.mkdirSync(path.join(root, 'tools/fixtures'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), [
        '/*',
        '!/.gitignore',
        '!/.github/',
        '!/config/',
        '!/tools/',
        '!/tests/'
    ].join('\n') + '\n');
    prepareBehaviorDocAdmissionFixtureAuthority({
        sourceRepositoryRoot: repositoryRoot,
        repositoryRoot: root
    });
    const git = (args) =>
    {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    };
    git(['init', '--quiet']);
    git(['add', '--all', '--', '.gitignore', '.github', 'config', 'tools', 'tests']);
    git([
        '-c', 'user.name=Test',
        '-c', 'user.email=test@example.invalid',
        '-c', 'commit.gpgsign=false',
        'commit', '--quiet', '--allow-empty', '-m', 'fixture'
    ]);
    return runner;
}

function sealSchedulerCliRunner(root, matrixFile, options)
{
    prepareSchedulerCliMatrixFixture(repositoryRoot, root, matrixFile, options);
    for (const args of [
        ['add', '--all', '--', 'config', 'tools', 'tests'],
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
            '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'sealed fixture']
    ])
    {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    }
}

function schedulerCliAdmissionEnvironment(root)
{
    const admission = createBehaviorDocAdmissionFixture({
        sourceRepositoryRoot: repositoryRoot,
        repositoryRoot: root
    });
    return {
        FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT: admission.receiptFile,
        FSUSBLOG_BEHAVIOR_DOC_ADMISSION_DIGEST: admission.contentDigest,
        FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RUN_ID: admission.runId
    };
}

function schedulerOwner(runId, overrides = {})
{
    const identity = currentProcessIdentity();
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'stable' };
    const owner = createSchedulerRunOwner({
        runId,
        candidateIdentityDigest: schedulerCandidateIdentityDigest({
            runId,
            targetTierId: 'fixture',
            namespace: 'test-matrix',
            sourceState
        }),
        targetTierId: 'fixture',
        ownerToken: `token-${runId}`,
        identity
    });
    return sealSchedulerRunOwner({ ...owner, ...overrides });
}

function tier(id, command)
{
    return {
        id,
        command,
        executionDependsOn: [],
        services: [],
        parallelizable: true,
        exclusiveResources: [],
        resourceClass: 'cpu',
        maxParallel: 1,
        cpuUnits: 1,
        memoryGiB: 0.1,
        cacheInputs: [],
        executionKey: id,
        executionVariant: 'ordinary',
        coverage: []
    };
}

function cliTierLines(id, command)
{
    return [
        `  - id: ${id}`,
        `    command: ${JSON.stringify(command)}`,
        '    executionDependsOn: []',
        '    services: []',
        '    parallelizable: true',
        '    exclusiveResources: []',
        '    resourceClass: cpu',
        '    maxParallel: 1',
        '    cpuUnits: 1',
        '    memoryGiB: 0.1',
        '    cacheInputs: []',
        `    executionKey: ${id}`,
        '    executionVariant: ordinary',
        '    coverage: []',
        '    requiresPlaywright: none',
        '    artifacts: []',
        '    evidence: []',
        `    ciJob: ${id}`
    ];
}

async function waitFor(predicate, message, timeoutMs = 10_000)
{
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline)
    {
        if (predicate())
        {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(message);
}

const stableSnapshot = async () => ({ fingerprint: 'stable', entries: {} });

test('scheduler stale-lock reclaim preserves a replacement owner across the delete race', (t) =>
{
    const root = fixture(t, 'scheduler-lock-cas');
    const lock = path.join(root, 'runs/.locks/race.lock');
    fs.mkdirSync(lock, { recursive: true });
    const stale = schedulerOwner('race', {
        ownerToken: 'stale',
        processStartIdentity: `${currentProcessIdentity().processStartIdentity}:exited`
    });
    fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify(stale)}\n`);
    const replacement = schedulerOwner('race', { ownerToken: 'replacement' });
    const reclaimed = reclaimSchedulerRunLock(lock, stale, {
        beforeDelete({ ownerFile })
        {
            fs.writeFileSync(ownerFile, `${JSON.stringify(replacement)}\n`);
        }
    });
    assert.equal(reclaimed, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).ownerToken, 'replacement');
});

test('scheduler activity verification rejects PID reuse and fails closed on unreadable owner identity', (t) =>
{
    const root = fixture(t, 'scheduler-activity-identity');
    const runsRoot = path.join(root, 'runs');
    const lock = path.join(runsRoot, '.locks', 'identity.lock');
    const ownerFile = path.join(lock, 'owner.json');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(ownerFile, `${JSON.stringify(schedulerOwner('identity'))}\n`);
    assert.equal(schedulerRunLockIsActive({ runsRoot, runId: 'identity' }), true);

    const reused = schedulerOwner('identity', {
        processStartIdentity: `${currentProcessIdentity().processStartIdentity}:reused`
    });
    fs.writeFileSync(ownerFile, `${JSON.stringify(reused)}\n`);
    assert.equal(schedulerRunLockActivity({ runsRoot, runId: 'identity' }).status, 'inactive');
    assert.equal(schedulerRunLockIsActive({ runsRoot, runId: 'identity' }), false);

    fs.writeFileSync(ownerFile, '{');
    assert.equal(schedulerRunLockActivity({ runsRoot, runId: 'identity' }).status, 'unverifiable');
    assert.throws(
        () => schedulerRunLockIsActive({ runsRoot, runId: 'identity' }),
        /owner-unverifiable/u
    );
});

test('scheduler owner schema binds candidate, target, process group, lifecycle state, and content digest', () =>
{
    const owner = schedulerOwner('schema');
    assert.equal(owner.schema, schedulerRunOwnerSchema);
    assert.deepEqual(Object.keys(owner).sort(), [...schedulerRunOwnerFields].sort());
    assert.match(owner.candidateIdentityDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(owner.targetTierId, 'fixture');
    assert.equal(owner.state, 'starting');
    assert.match(owner.contentDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(schedulerProcessGroupOrJobIdentityIsComplete(owner.processGroupOrJobIdentity), true);
    assert.equal(verifySchedulerRunOwner(owner).status, 'active');
});

test('scheduler candidate identity separates namespaces and resume cannot omit the candidate binding', (t) =>
{
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'stable' };
    const first = schedulerCandidateIdentityDigest({
        runId: 'candidate',
        targetTierId: 'fixture',
        namespace: 'first',
        sourceState
    });
    const second = schedulerCandidateIdentityDigest({
        runId: 'candidate',
        targetTierId: 'fixture',
        namespace: 'second',
        sourceState
    });
    assert.notEqual(first, second);

    const root = fixture(t, 'scheduler-resume-candidate');
    const runsRoot = path.join(root, 'runs');
    const runDirectory = path.join(runsRoot, 'candidate');
    const lock = path.join(runsRoot, '.locks/candidate.lock');
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, 'checkpoint.json'), `${JSON.stringify({
        schema: 'fsusblog.test-matrix.checkpoint.v1',
        runId: 'candidate',
        targetTierId: 'fixture',
        sourceState,
        status: 'running',
        updatedAt: new Date().toISOString()
    })}\n`);
    fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify(schedulerOwner('candidate'))}\n`);
    assert.throws(
        () => findLatestRunId(runsRoot, 'fixture'),
        /candidate checkpoint identity is incomplete/u
    );
});

test('producer terminal waits trust only the active same-run scheduler checkpoint authority', (t) =>
{
    const root = fixture(t, 'scheduler-producer-terminal-authority');
    const runsRoot = path.join(root, 'runs');
    const runId = 'producer-terminal';
    const targetTierId = 'production';
    const namespace = 'production-authority';
    const sourceState = {
        commit: 'a'.repeat(40),
        worktreeFingerprint: 'candidate'
    };
    const candidateIdentityDigest = schedulerCandidateIdentityDigest({
        runId,
        targetTierId,
        namespace,
        sourceState
    });
    const checkpointFile = path.join(runsRoot, runId, 'checkpoint.json');
    fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
    const checkpoint = {
        schema: 'fsusblog.test-matrix.checkpoint.v1',
        runId,
        targetTierId,
        namespace,
        schedulerCandidateIdentityDigest: candidateIdentityDigest,
        mode: 'fresh',
        authoritative: true,
        status: 'failure',
        revision: 7,
        budgetPolicyDigest: null,
        sourceState,
        tiers: {
            'local-production-backend-tests': {
                status: 'failure',
                reason: 'backend failed'
            }
        }
    };
    fs.writeFileSync(checkpointFile, `${JSON.stringify(checkpoint)}\n`);
    const active = (expected) =>
    {
        assert.equal(expected.runsRoot, runsRoot);
        assert.equal(expected.runId, runId);
        assert.equal(expected.targetTierId, targetTierId);
        assert.equal(expected.candidateIdentityDigest, candidateIdentityDigest);
        return { status: 'active', reason: null };
    };
    const failure = readSchedulerProducerTerminalFailure({
        runsRoot,
        runId,
        targetTierId,
        namespace,
        sourceState,
        producerTierId: 'local-production-backend-tests',
        activity: active
    });
    assert.deepEqual(failure, {
        status: 'failure',
        reason: 'backend failed',
        checkpointRevision: 7,
        candidateIdentityDigest
    });

    checkpoint.tiers['local-production-backend-tests'].status = 'success';
    fs.writeFileSync(checkpointFile, `${JSON.stringify(checkpoint)}\n`);
    assert.equal(readSchedulerProducerTerminalFailure({
        runsRoot,
        runId,
        targetTierId,
        namespace,
        sourceState,
        producerTierId: 'local-production-backend-tests',
        activity: active
    }), null);

    checkpoint.tiers['local-production-backend-tests'].status = 'failure';
    checkpoint.schedulerCandidateIdentityDigest = `sha256:${'f'.repeat(64)}`;
    fs.writeFileSync(checkpointFile, `${JSON.stringify(checkpoint)}\n`);
    assert.throws(() => readSchedulerProducerTerminalFailure({
        runsRoot,
        runId,
        targetTierId,
        namespace,
        sourceState,
        producerTierId: 'local-production-backend-tests',
        activity: active
    }), /candidate identity is invalid/u);

    checkpoint.schedulerCandidateIdentityDigest = candidateIdentityDigest;
    fs.writeFileSync(checkpointFile, `${JSON.stringify(checkpoint)}\n`);
    assert.throws(() => readSchedulerProducerTerminalFailure({
        runsRoot,
        runId,
        targetTierId,
        namespace,
        sourceState: { ...sourceState, worktreeFingerprint: 'different-candidate' },
        producerTierId: 'local-production-backend-tests',
        activity: active
    }), /authority identity mismatch/u);
    assert.throws(() => readSchedulerProducerTerminalFailure({
        runsRoot,
        runId,
        targetTierId,
        namespace,
        sourceState,
        producerTierId: 'local-production-backend-tests',
        activity: () => ({ status: 'inactive', reason: 'lock-missing' })
    }), /owner authority is inactive.*lock-missing/u);
});

test('scheduler heartbeat and finalize require exact token plus identity and terminal owners reject heartbeat', (t) =>
{
    const root = fixture(t, 'scheduler-heartbeat-finalize');
    const lock = path.join(root, 'runs/.locks/heartbeat.lock');
    const ownerFile = path.join(lock, 'owner.json');
    fs.mkdirSync(lock, { recursive: true });
    const owner = schedulerOwner('heartbeat');
    fs.writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`);

    const originalHeartbeat = owner.heartbeatAt;
    assert.equal(heartbeatSchedulerRunOwner({ lockPath: lock, expectedOwner: owner }), true);
    const heartbeated = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    assert.equal(heartbeated.state, 'running');
    assert.ok(Date.parse(heartbeated.heartbeatAt) >= Date.parse(originalHeartbeat));
    assert.notEqual(heartbeated.contentDigest, undefined);

    const wrongToken = sealSchedulerRunOwner({ ...owner, ownerToken: 'replacement' });
    assert.equal(heartbeatSchedulerRunOwner({ lockPath: lock, expectedOwner: wrongToken }), false);
    assert.equal(heartbeatSchedulerRunOwner({
        lockPath: lock,
        expectedOwner: owner,
        state: 'finalizing'
    }), true);
    assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).state, 'finalizing');
    assert.equal(heartbeatSchedulerRunOwner({
        lockPath: lock,
        expectedOwner: owner,
        state: 'running'
    }), false);
    assert.equal(finalizeSchedulerRunOwner({
        lockPath: lock,
        expectedOwner: owner,
        state: 'complete',
        processStatus: () => ({ status: 'mismatch', actual: null })
    }), false);
    assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).state, 'finalizing');
    assert.equal(finalizeSchedulerRunOwner({ lockPath: lock, expectedOwner: owner, state: 'complete' }), true);
    assert.equal(fs.existsSync(lock), false);
    const terminalReceipt = JSON.parse(fs.readFileSync(
        path.join(root, 'runs/.locks/.terminal/heartbeat', `${owner.ownerToken}.json`),
        'utf8'
    ));
    assert.equal(terminalReceipt.state, 'complete');
    assert.equal(heartbeatSchedulerRunOwner({ lockPath: lock, expectedOwner: owner }), false);
    assert.equal(
        schedulerRunLockActivity({ runsRoot: path.join(root, 'runs'), runId: 'heartbeat' }).status,
        'inactive'
    );
});

test('scheduler executable and command mismatch cannot impersonate a live owner', (t) =>
{
    const root = fixture(t, 'scheduler-command-mismatch');
    const runsRoot = path.join(root, 'runs');
    const lock = path.join(runsRoot, '.locks/identity.lock');
    const ownerFile = path.join(lock, 'owner.json');
    fs.mkdirSync(lock, { recursive: true });
    for (const field of ['executableDigest', 'commandDigest'])
    {
        const mismatched = sealSchedulerRunOwner({
            ...schedulerOwner('identity'),
            [field]: `sha256:${field === 'executableDigest' ? '1' : '2'}`.padEnd(71, field === 'executableDigest' ? '1' : '2')
        });
        fs.writeFileSync(ownerFile, `${JSON.stringify(mismatched)}\n`);
        assert.equal(schedulerRunLockActivity({ runsRoot, runId: 'identity' }).status, 'inactive');
    }
});

test('scheduler corrupt owner uses content-bound observation grace and never lock mtime', (t) =>
{
    const root = fixture(t, 'scheduler-corrupt-owner-grace');
    const runsRoot = path.join(root, 'runs');
    const lock = path.join(runsRoot, '.locks/corrupt.lock');
    const ownerFile = path.join(lock, 'owner.json');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(ownerFile, '{');
    fs.utimesSync(lock, new Date(0), new Date(0));
    fs.utimesSync(ownerFile, new Date(0), new Date(0));
    const first = schedulerRunLockActivity({ runsRoot, runId: 'corrupt', nowMs: 1_000 });
    assert.equal(first.status, 'unverifiable');
    assert.match(first.reason, /within-grace/u);
    const expired = schedulerRunLockActivity({ runsRoot, runId: 'corrupt', nowMs: 31_001 });
    assert.equal(expired.status, 'unverifiable');
    assert.match(expired.reason, /grace-expired/u);
    assert.equal(fs.existsSync(lock), true);
});

test('scheduler owner content digest tamper fails before process liveness can be consulted', (t) =>
{
    const root = fixture(t, 'scheduler-content-tamper');
    const runsRoot = path.join(root, 'runs');
    const lock = path.join(runsRoot, '.locks/tamper.lock');
    fs.mkdirSync(lock, { recursive: true });
    const tampered = schedulerOwner('tamper');
    tampered.targetTierId = 'different';
    fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify(tampered)}\n`);
    let processChecks = 0;
    const activity = schedulerRunLockActivity({
        runsRoot,
        runId: 'tamper',
        processStatus()
        {
            processChecks += 1;
            return { status: 'live' };
        }
    });
    assert.equal(activity.status, 'unverifiable');
    assert.match(activity.reason, /content-digest/u);
    assert.equal(processChecks, 0);
});

test('scheduler verifier covers Unix process groups and explicit Windows Job Object identity', () =>
{
    const unixOwner = schedulerOwner('unix-group');
    assert.equal(unixOwner.processGroupOrJobIdentity.kind, 'process-group');
    assert.equal(verifySchedulerRunOwner(unixOwner).status, 'active');
    assert.equal(verifySchedulerProcessAuthority({
        pid: unixOwner.pid,
        processStartIdentity: unixOwner.processStartIdentity,
        executableDigest: unixOwner.executableDigest,
        commandDigest: unixOwner.commandDigest,
        processGroupOrJobIdentity: unixOwner.processGroupOrJobIdentity
    }).status, 'active');

    const identity = {
        pid: 42,
        processStartIdentity: 'windows:20260727000000.000000+000',
        executableDigest: `sha256:${'3'.repeat(64)}`,
        commandDigest: `sha256:${'4'.repeat(64)}`
    };
    const jobIdentity = {
        schema: 'fsusblog.process-group-or-job-identity.v1',
        platform: 'win32',
        kind: 'windows-job-object',
        authorityId: 'job-authority',
        jobName: 'Local\\FsusBlog-Scheduler',
        supervisorProcessStartIdentity: identity.processStartIdentity,
        ownerProcessStartIdentity: identity.processStartIdentity
    };
    assert.deepEqual(
        collectSchedulerProcessGroupOrJobIdentity(identity, {
            platform: 'win32',
            env: {
                FSUSBLOG_SCHEDULER_JOB_AUTHORITY_ID: jobIdentity.authorityId,
                FSUSBLOG_SCHEDULER_JOB_NAME: jobIdentity.jobName,
                FSUSBLOG_SCHEDULER_JOB_SUPERVISOR_START_IDENTITY:
                    jobIdentity.supervisorProcessStartIdentity
            }
        }),
        { status: 'verified', value: jobIdentity }
    );
    const windowsOwner = createSchedulerRunOwner({
        runId: 'windows-job',
        candidateIdentityDigest: `sha256:${'5'.repeat(64)}`,
        targetTierId: 'fixture',
        identity,
        processGroupOrJobIdentity: jobIdentity
    });
    assert.equal(schedulerProcessGroupOrJobIdentityIsComplete(jobIdentity), true);
    assert.equal(verifySchedulerRunOwner(windowsOwner, {
        processStatus: () => ({ status: 'live', actual: identity }),
        groupOrJobStatus: () => ({ status: 'verified', value: jobIdentity })
    }).status, 'active');
});

test('scheduler reclaim archives a terminal owner receipt before releasing the lock', (t) =>
{
    const root = fixture(t, 'scheduler-terminal-archive');
    const lock = path.join(root, 'runs/.locks/archive.lock');
    fs.mkdirSync(lock, { recursive: true });
    const stale = schedulerOwner('archive', {
        processStartIdentity: `${currentProcessIdentity().processStartIdentity}:exited`
    });
    fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify(stale)}\n`);
    assert.equal(reclaimSchedulerRunLock(lock, stale), true);
    assert.equal(fs.existsSync(lock), false);
    const archive = path.join(root, 'runs/.locks/.terminal/archive', `${stale.ownerToken}.json`);
    assert.equal(JSON.parse(fs.readFileSync(archive, 'utf8')).state, 'failed');
});

test('scheduler, build owner, GC, cleanup, and resume expose only the shared owner verifier', () =>
{
    const authority = fs.readFileSync(
        path.join(repositoryRoot, 'tools/test-matrix/scheduler-run-owner.mjs'),
        'utf8'
    );
    const scheduler = fs.readFileSync(path.join(repositoryRoot, 'tools/test-matrix/scheduler.mjs'), 'utf8');
    const buildOwner = fs.readFileSync(
        path.join(repositoryRoot, 'tools/test-matrix/production-build-layout.mjs'),
        'utf8'
    );
    const runner = fs.readFileSync(path.join(repositoryRoot, 'tools/run-test-matrix.mjs'), 'utf8');
    const buildServerCleanup = fs.readFileSync(
        path.join(repositoryRoot, 'tools/test-matrix/dotnet-build-server-cleanup.mjs'),
        'utf8'
    );
    assert.equal((authority.match(/function schedulerRunLockActivity/gu) ?? []).length, 1);
    assert.equal((scheduler.match(/function schedulerRunLockActivity/gu) ?? []).length, 0);
    assert.match(scheduler, /from '\.\/scheduler-run-owner\.mjs'/u);
    assert.match(buildOwner, /schedulerRunLockActivity[\s\S]*from '\.\/scheduler-run-owner\.mjs'/u);
    assert.match(buildServerCleanup, /schedulerRunLockActivity/u);
    assert.doesNotMatch(runner, /productionBuildRunIsActive/u);
    assert.doesNotMatch(authority, /statSync\([^)]*lock|mtime/u);
    assert.doesNotMatch(authority, /process\.kill\([^,]+,\s*0/u);
});

test('runDag retains terminal owner receipts and archives them before same-run reacquisition', async (t) =>
{
    const root = fixture(t, 'scheduler-run-terminal-lifecycle');
    const runsRoot = path.join(root, 'runs');
    const options = {
        tiers: [tier('fixture', `${process.execPath} -e "process.exit(0)"`)],
        root,
        runsRoot,
        runId: 'terminal-run',
        targetTierId: 'fixture',
        mode: 'fresh',
        snapshotWorktree: stableSnapshot,
        executeTier: async () => ({ code: 0, signal: null })
    };
    assert.equal((await runDag(options)).status, 'success');
    const lockPath = path.join(runsRoot, '.locks/terminal-run.lock');
    const archiveDirectory = path.join(runsRoot, '.locks/.terminal/terminal-run');
    assert.equal(fs.existsSync(lockPath), false);
    const firstReceipts = fs.readdirSync(archiveDirectory);
    assert.equal(firstReceipts.length, 1);
    const firstOwner = JSON.parse(fs.readFileSync(path.join(archiveDirectory, firstReceipts[0]), 'utf8'));
    assert.equal(firstOwner.state, 'complete');
    assert.equal(schedulerRunLockActivity({
        runsRoot,
        runId: 'terminal-run',
        targetTierId: 'fixture',
        candidateIdentityDigest: firstOwner.candidateIdentityDigest
    }).status, 'inactive');

    assert.equal((await runDag({ ...options, mode: 'resume', resume: true })).status, 'success');
    assert.equal(fs.existsSync(lockPath), false);
    const secondReceipts = fs.readdirSync(archiveDirectory);
    assert.equal(secondReceipts.length, 2);
    const secondOwner = secondReceipts
        .map((file) => JSON.parse(fs.readFileSync(path.join(archiveDirectory, file), 'utf8')))
        .find((owner) => owner.ownerToken !== firstOwner.ownerToken);
    assert.equal(secondOwner.state, 'complete');
    assert.notEqual(secondOwner.ownerToken, firstOwner.ownerToken);
    assert.equal(
        fs.existsSync(path.join(archiveDirectory, `${firstOwner.ownerToken}.json`)),
        true
    );
});

test(
    'registration handshake captures a live identity even for an immediately exiting command',
    {
        skip: process.platform !== 'linux'
    },
    async (t) =>
    {
        const root = fixture(t, 'scheduler-fast-registration');
        let registration = null;
        const result = await runDag({
            tiers: [tier('fast', '/bin/true')],
            root,
            runsRoot: path.join(root, 'runs'),
            runId: 'fast',
            mode: 'fresh',
            maxParallel: 1,
            snapshotWorktree: stableSnapshot,
            registerManagedProcess(identity, _tier, authority)
            {
                registration = { identity, authority, status: processIdentityStatus(identity).status };
            }
        });
        assert.equal(result.status, 'success');
        assert.equal(registration.status, 'live');
        assert.equal(registration.authority.kind, 'systemd-transient-service');
        assert.equal(registration.authority.killPolicy, 'control-group');
    }
);

test(
    'rejected durable registration terminates the stopped launcher without releasing its workload',
    {
        skip: process.platform !== 'linux'
    },
    async (t) =>
    {
        const root = fixture(t, 'scheduler-rejected-registration');
        const marker = path.join(root, 'unadmitted-workload');
        const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`)}`;
        let registered = null;
        await assert.rejects(() => runDag({
            tiers: [tier('rejected', command)],
            root,
            runsRoot: path.join(root, 'runs'),
            runId: 'rejected',
            mode: 'fresh',
            maxParallel: 1,
            snapshotWorktree: stableSnapshot,
            registerManagedProcess(identity, _tier, authority)
            {
                registered = { identity, authority };
                throw new Error('independent registration refused');
            }
        }), /independent registration refused/u);
        assert.ok(registered);
        const deadline = Date.now() + 5000;
        while (fs.existsSync(`/proc/${registered.identity.pid}`) && Date.now() < deadline)
        {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(fs.existsSync(`/proc/${registered.identity.pid}`), false, 'the exact task launcher must become terminal');
        const unit = spawnSync('systemctl', ['--user', 'show', registered.authority.unitName, '--property=ActiveState', '--value'], { encoding: 'utf8' });
        assert.ok([0, 4].includes(unit.status), unit.stderr);
        assert.equal(unit.stdout.trim(), 'inactive');
        assert.equal(fs.existsSync(marker), false, 'registration failure must not resume the actual workload');
    }
);

test(
    'durable Linux containment kills a detached new-session writer before scheduler success',
    {
        skip: process.platform !== 'linux'
    },
    async (t) =>
    {
        const root = fixture(t, 'scheduler-detached-writer');
        const lateWrite = path.join(root, 'late-write');
        const writer = path.join(root, 'writer.mjs');
        const wrapper = path.join(root, 'wrapper.mjs');
        fs.writeFileSync(
            writer,
            [
                "import fs from 'node:fs'",
                'setTimeout(() => {',
                `    fs.writeFileSync(${JSON.stringify(lateWrite)}, 'late')`,
                '}, 200)'
            ].join('\n')
        );
        fs.writeFileSync(
            wrapper,
            [
                "import { spawn } from 'node:child_process'",
                `const child = spawn(process.execPath, [${JSON.stringify(writer)}], {`,
                '    detached: true,',
                "    stdio: 'ignore'",
                '})',
                'child.unref()'
            ].join('\n')
        );
        const result = await runDag({
            tiers: [tier('escape', `${JSON.stringify(process.execPath)} ${JSON.stringify(wrapper)}`)],
            root,
            runsRoot: path.join(root, 'runs'),
            runId: 'escape',
            mode: 'fresh',
            maxParallel: 1,
            snapshotWorktree: stableSnapshot,
            registerManagedProcess()
            {}
        });
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.equal(result.status, 'success');
        assert.equal(fs.existsSync(lateWrite), false);
    }
);

test(
    'production build receipt persists the durable authority and seals only after it becomes inactive',
    {
        skip: process.platform !== 'linux'
    },
    async (t) =>
    {
        const root = fixture(t, 'production-contained-writer');
        const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'stable' };
        const namespace = 'production:contained';
        const layout = prepareProductionBuildLayout({
            root,
            runId: 'contained',
            sourceState,
            namespace
        });
        const lateWrite = path.join(layout.runRoot, 'late-write');
        const writer = path.join(root, 'writer.mjs');
        const wrapper = path.join(root, 'wrapper.mjs');
        fs.writeFileSync(
            writer,
            `import fs from 'node:fs'; setTimeout(() => fs.writeFileSync(${JSON.stringify(lateWrite)}, 'late'), 200)\n`
        );
        fs.writeFileSync(
            wrapper,
            `import { spawn } from 'node:child_process'; const child = spawn(process.execPath, [${JSON.stringify(writer)}], { detached: true, stdio: 'ignore' }); child.unref()\n`
        );
        const result = await runDag({
            tiers: [tier('build', `${JSON.stringify(process.execPath)} ${JSON.stringify(wrapper)}`)],
            root,
            runsRoot: path.join(root, '.tmp/test-runs'),
            runId: layout.runId,
            namespace,
            sourceState,
            mode: 'fresh',
            maxParallel: 1,
            snapshotWorktree: stableSnapshot,
            onSourceState(value)
            {
                bindProductionBuildLayoutSource(layout, value);
            },
            registerManagedProcess(identity, _tier, authority)
            {
                registerProductionBuildCompiler(layout, identity, authority);
            }
        });
        assert.equal(result.status, 'success');
        const finalized = finalizeProductionBuildLayout(layout, { status: 'success' });
        assert.equal(finalized.owner.managedContainmentAuthorities.length, 1);
        assert.equal(finalized.owner.managedContainmentAuthorities[0].kind, 'systemd-transient-service');
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.equal(fs.existsSync(lateWrite), false);
    }
);

test('CLI scheduler errors preserve the original failure and seal the production build layout', (t) =>
{
    const root = fixture(t, 'scheduler-cli-error-seal');
    const runner = materializeSchedulerCliRunner(root);
    const matrix = path.join(root, 'matrix.yml');
    fs.writeFileSync(path.join(root, 'tools/fixtures/success.mjs'), 'process.exit(0);\n');
    const runId = `scheduler-cli-error-seal-${process.pid}`;
    const tierLines = (id, variant, supersedes = []) => [
        `  - id: ${id}`,
        '    command: node tools/fixtures/success.mjs',
        '    executionDependsOn: []',
        '    services: []',
        '    parallelizable: true',
        '    exclusiveResources: []',
        '    resourceClass: cpu',
        '    maxParallel: 1',
        '    cpuUnits: 1',
        '    memoryGiB: 0.1',
        '    cacheInputs: []',
        '    executionKey: shared',
        `    executionVariant: ${variant}`,
        '    coverage: [ordinary-unit]',
        '    requiresPlaywright: none',
        '    artifacts: []',
        '    evidence: []',
        `    ciJob: ${id}`,
        ...(supersedes.length > 0 ? [`    supersedes: [${supersedes.join(', ')}]`] : [])
    ];
    fs.writeFileSync(
        matrix,
        [
            'version: fsusblog-test-matrix-v2',
            'tiers:',
            ...tierLines('backend-unit', 'ordinary'),
            ...tierLines('backend-fast', 'ordinary', ['backend-unit'])
        ].join('\n')
    );
    sealSchedulerCliRunner(root, matrix);
    const admissionEnvironment = schedulerCliAdmissionEnvironment(root);

    const result = spawnSync(
        process.execPath,
        [runner, 'run', 'backend-fast', '--no-deps', '--resume'],
        {
            cwd: root,
            env: {
                ...process.env,
                ...admissionEnvironment,
                FSUSBLOG_MATRIX_FILE: matrix,
                FSUSBLOG_TEST_RUN_ID: runId
            },
            encoding: 'utf8'
        }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid supersedes metadata/u);
    assert.doesNotMatch(result.stderr, /failed to seal scheduler error/u);

    const runRoot = path.join(root, '.tmp/build', runId);
    const manifest = JSON.parse(fs.readFileSync(path.join(runRoot, 'layout.json'), 'utf8'));
    assert.equal(manifest.status, 'failure');
    assert.equal(manifest.owner.state, 'failed');
    assert.equal(fs.existsSync(path.join(runRoot, '.active.json')), false);
});

test(
    'materialized CLI preserves tier exit 7 while reporting seal failure and removing active authority',
    {
        skip: process.platform !== 'linux'
    },
    (t) =>
    {
        const root = fixture(t, 'scheduler-cli-tier-and-seal-failure');
        const runner = materializeSchedulerCliRunner(root);
        const matrix = path.join(root, 'matrix.yml');
        fs.writeFileSync(path.join(root, 'tools/fixtures/exit-seven.mjs'), 'process.exit(7);\n');
        const runId = `scheduler-cli-tier-and-seal-failure-${process.pid}`;
        fs.writeFileSync(
            matrix,
            [
                'version: fsusblog-test-matrix-v2',
                'tiers:',
                ...cliTierLines('backend-unit', 'node tools/fixtures/exit-seven.mjs')
            ].join('\n')
        );
        sealSchedulerCliRunner(root, matrix, {
            beforeSeal()
            {
                const lifecycleFile = path.join(root, 'tools/test-matrix/production-build-lifecycle.mjs');
                const lifecycleSource = fs.readFileSync(lifecycleFile, 'utf8');
                const finalizeAdapter = '    finalize: finalizeProductionBuildLayout,';
                assert.equal(lifecycleSource.split(finalizeAdapter).length - 1, 1);
                fs.writeFileSync(lifecycleFile, lifecycleSource.replace(
                    finalizeAdapter,
                    "    finalize: () => { throw new Error('injected production build seal failure') },"
                ));
            }
        });
        const admissionEnvironment = schedulerCliAdmissionEnvironment(root);
        const result = spawnSync(process.execPath, [runner, 'run', 'backend-unit', '--no-deps', '--resume'], {
            cwd: root,
            env: {
                ...process.env,
                ...admissionEnvironment,
                FSUSBLOG_MATRIX_FILE: matrix,
                FSUSBLOG_TEST_RUN_ID: runId
            },
            encoding: 'utf8'
        });
        assert.equal(result.status, 7, result.stderr);
        assert.match(result.stderr, /exited 7/u);
        assert.match(result.stderr, /secondary seal failure: injected production build seal failure/u);

        const runRoot = path.join(root, '.tmp/build', runId);
        const manifest = JSON.parse(fs.readFileSync(path.join(runRoot, 'layout.json'), 'utf8'));
        assert.equal(manifest.status, 'failure');
        assert.equal(manifest.owner.state, 'failed');
        assert.equal(manifest.lifecycleFinalization.mode, 'fail-closed-fallback');
        assert.equal(fs.existsSync(path.join(runRoot, '.active.json')), false);
    }
);

test(
    'materialized advisory CLI SIGTERM cancels the tier and seals the layout without an active marker',
    {
        skip: process.platform !== 'linux'
    },
    async (t) =>
    {
        const root = fixture(t, 'scheduler-cli-sigterm');
        const runner = materializeSchedulerCliRunner(root);
        const matrix = path.join(root, 'matrix.yml');
        fs.writeFileSync(path.join(root, 'tools/fixtures/long-running.mjs'), 'setTimeout(() => {}, 30000);\n');
        const runId = `scheduler-cli-sigterm-${process.pid}`;
        fs.writeFileSync(
            matrix,
            [
                'version: fsusblog-test-matrix-v2',
                'tiers:',
                ...cliTierLines('backend-unit', 'node tools/fixtures/long-running.mjs')
            ].join('\n')
        );
        sealSchedulerCliRunner(root, matrix);
        const admissionEnvironment = schedulerCliAdmissionEnvironment(root);
        const child = spawn(process.execPath, [runner, 'run', 'backend-unit', '--no-deps', '--resume'], {
            cwd: root,
            env: {
                ...process.env,
                ...admissionEnvironment,
                FSUSBLOG_CGROUP_ENFORCEMENT: 'advisory',
                FSUSBLOG_MATRIX_FILE: matrix,
                FSUSBLOG_TEST_RUN_ID: runId
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        t.after(() =>
        {
            if (child.exitCode === null && child.signalCode === null)
            {
                child.kill('SIGKILL');
            }
        });
        child.stdout.resume();
        let stderr = '';
        child.stderr.on('data', (chunk) =>
        {
            stderr += chunk;
        });
        const closed = new Promise((resolve) =>
        {
            child.once('close', (code, signal) => resolve({ code, signal }));
        });
        const runRoot = path.join(root, '.tmp/build', runId);
        await waitFor(() =>
        {
            try
            {
                const manifest = JSON.parse(fs.readFileSync(path.join(runRoot, 'layout.json'), 'utf8'));
                return manifest.owner?.state === 'building';
            }
            catch
            {
                return false;
            }
        }, `CLI did not enter building state: ${stderr}`);
        child.kill('SIGTERM');
        const outcome = await closed;
        assert.deepEqual(outcome, { code: 143, signal: null }, stderr);
        const manifest = JSON.parse(fs.readFileSync(path.join(runRoot, 'layout.json'), 'utf8'));
        assert.equal(manifest.status, 'cancelled');
        assert.equal(manifest.owner.state, 'cancelled');
        assert.equal(fs.existsSync(path.join(runRoot, '.active.json')), false);
    }
);

function windowsJobAdapter(events, { failAt = null, exitCode = 7 } = {})
{
    const step = (name, value) =>
    {
        events.push(name);
        if (failAt === name)
        {
            throw new Error(`injected ${name} failure`);
        }
        return value;
    };
    return {
        createJob: () => step('createJob', { id: 'job' }),
        configureKillOnClose: () => step('configureKillOnClose'),
        signalReady: () => step('signalReady'),
        waitForStart: () => step('waitForStart'),
        createProcessSuspended: () => step('createProcessSuspended', { id: 'process' }),
        assignProcess: () => step('assignProcess'),
        resumeProcess: () => step('resumeProcess'),
        waitForProcess: () => step('waitForProcess', exitCode),
        terminateProcess: () => step('terminateProcess'),
        terminateJob: (_job, code) => step(`terminateJob:${code}`),
        closeProcess: () => step('closeProcess'),
        closeJob: () => step('closeJob'),
        cleanupHandshake: () => step('cleanupHandshake')
    };
}

test('Windows Job state machine completes ready/start, assignment, resume, and kill-on-close in order', async () =>
{
    const events = [];
    const result = await runWindowsJobSupervisorStateMachine({
        adapter: windowsJobAdapter(events)
    });
    assert.deepEqual(events, [
        'createJob',
        'configureKillOnClose',
        'signalReady',
        'waitForStart',
        'createProcessSuspended',
        'assignProcess',
        'resumeProcess',
        'waitForProcess',
        'terminateJob:7',
        'closeProcess',
        'closeJob',
        'cleanupHandshake'
    ]);
    assert.equal(result.schema, windowsJobSupervisorStateSchema);
    assert.equal(result.assignedBeforeResume, true);
    assert.equal(result.killPolicy, 'kill-on-job-close');
});

test('Windows Job state machine recovers a start-handshake failure by terminating and closing the Job', async () =>
{
    const events = [];
    await assert.rejects(
        runWindowsJobSupervisorStateMachine({
            adapter: windowsJobAdapter(events, { failAt: 'waitForStart' })
        }),
        /injected waitForStart failure/u
    );
    assert.deepEqual(events, [
        'createJob',
        'configureKillOnClose',
        'signalReady',
        'waitForStart',
        'terminateJob:1',
        'closeJob',
        'cleanupHandshake'
    ]);
});

test('Windows Job state machine never resumes a process whose Job assignment failed', async () =>
{
    const events = [];
    await assert.rejects(
        runWindowsJobSupervisorStateMachine({
            adapter: windowsJobAdapter(events, { failAt: 'assignProcess' })
        }),
        /injected assignProcess failure/u
    );
    assert.equal(events.includes('resumeProcess'), false);
    assert.deepEqual(events.slice(-5), [
        'terminateProcess',
        'terminateJob:1',
        'closeProcess',
        'closeJob',
        'cleanupHandshake'
    ]);
});

test('PowerShell supervisor declares the same tested Job state-machine schema', () =>
{
    const script = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '../../tools/test-matrix/windows-job-supervisor.ps1'),
        'utf8'
    );
    assert.match(script, new RegExp(windowsJobSupervisorStateSchema.replaceAll('.', '\\.'), 'u'));
});

test('scheduler tier admission observation preserves custody and refuses missing evidence directories', (t) =>
{
    const root = fixture(t, 'scheduler-admission-read-only');
    const runsRoot = path.join(root, 'runs');
    const runId = 'admission-read-only';
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
    const candidateIdentityDigest = schedulerCandidateIdentityDigest({
        runId,
        targetTierId: 'release-final',
        namespace: 'test-matrix',
        sourceState,
        budgetPolicyDigest: null
    });
    const lock = acquireSchedulerRunLock({
        runsRoot,
        runId,
        candidateIdentityDigest,
        targetTierId: 'release-final'
    });
    t.after(() => lock.finalize('complete'));
    assert.equal(lock.markRunning(), true);
    const storeRoot = path.join(runsRoot, runId, 'evidence-store');
    const writer = new RunEvidenceObjectStore({ root: storeRoot, runId, sourceState });
    const admission = createSchedulerTierAdmission({
        runId,
        targetTierId: 'release-final',
        currentTierId: 'behavior-evidence-post-runtime',
        namespace: 'test-matrix',
        mode: 'fresh',
        sourceState,
        schedulerCandidateIdentityDigest: candidateIdentityDigest,
        schedulerOwnerToken: lock.owner.ownerToken,
        budgetPolicyDigest: null,
        schedulerCheckpointRevision: 1,
        admissionSequence: 1,
        activeTierIds: [],
        releaseFinalSpawnCountBeforeAdmission: 0
    });
    const published = writeSchedulerTierAdmission({ runsRoot, admission });
    const reference = {
        schema: published.schema,
        ref: path.relative(root, published.file).replaceAll(path.sep, '/'),
        fileDigest: published.fileDigest,
        contentDigest: published.contentDigest,
        currentTierId: published.currentTierId,
        admissionSequence: published.admissionSequence
    };
    writer.appendJournalEvent({
        eventType: 'tier-admitted',
        tier: admission.currentTierId,
        step: 'scheduler',
        status: 'running',
        payload: { operations: [{ kind: 'set', path: ['schedulerAdmissions', admission.currentTierId], value: reference }] }
    });
    const snapshot = () => ['.', ...fs.readdirSync(storeRoot, { recursive: true }).sort()].map((file) =>
    {
        const target = path.join(storeRoot, file);
        const stat = fs.lstatSync(target, { bigint: true });
        return {
            file,
            inode: stat.ino,
            mode: stat.mode,
            mtimeNs: stat.mtimeNs,
            ctimeNs: stat.ctimeNs,
            bytes: stat.isFile() ? fs.readFileSync(target).toString('base64') : null
        };
    });
    const observe = () => schedulerTierAdmissionActivity({ runsRoot, admission, reference });
    const before = snapshot();
    assert.equal(observe().status, 'active');
    assert.equal(observe().status, 'active');
    assert.deepEqual(snapshot(), before, 'repeated valid observation must not mutate evidence custody');
    for (const name of ['objects', 'receipts', 'journals', 'checkpoints'])
    {
        const directory = path.join(storeRoot, name);
        const retained = path.join(root, `${name}-retained`);
        fs.renameSync(directory, retained);
        try
        {
            const missingSnapshot = snapshot();
            for (let attempt = 0; attempt < 2; attempt += 1)
            {
                assert.equal(observe().status, 'invalid', `${name}: incomplete store must refuse admission`);
                assert.equal(fs.existsSync(directory), false, `${name}: observation must not recreate missing authority`);
                assert.deepEqual(snapshot(), missingSnapshot, `${name}: refusal must preserve surviving custody`);
            }
        }
        finally
        {
            if (fs.existsSync(directory))
            {
                fs.rmSync(directory, { recursive: true });
            }
            fs.renameSync(retained, directory);
        }
    }
    const retainedStore = path.join(root, 'store-retained');
    fs.renameSync(storeRoot, retainedStore);
    try
    {
        assert.equal(observe().status, 'invalid');
        assert.equal(fs.existsSync(storeRoot), false, 'observation must not recreate the missing store');
    }
    finally
    {
        fs.renameSync(retainedStore, storeRoot);
    }
    const restoredSnapshot = snapshot();
    assert.equal(observe().status, 'active');
    assert.deepEqual(snapshot(), restoredSnapshot, 'restored custody must remain unchanged after observation');
});
