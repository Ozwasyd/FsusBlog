import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
    bindProductionBuildLayoutSource,
    finalizeProductionBuildLayout,
    prepareProductionBuildLayout,
    registerProductionBuildCompiler
} from '../../tools/test-matrix/production-build-layout.mjs'
import {
    reclaimSchedulerRunLock,
    runDag,
    schedulerRunLockActivity,
    schedulerRunLockIsActive
} from '../../tools/test-matrix/scheduler.mjs'
import {
    runWindowsJobSupervisorStateMachine,
    windowsJobSupervisorStateSchema
} from '../../tools/test-matrix/windows-job-supervisor-state.mjs'
import { currentProcessIdentity, processIdentityStatus } from '../../tools/test/process-identity.mjs'
import { materializeTestMatrixRunner } from './support/esm-fixture-materializer-contracts.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function fixture(t, name) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return root
}

function schedulerOwner(runId, overrides = {}) {
    const identity = currentProcessIdentity()
    return {
        ...identity,
        schema: 'fsusblog.scheduler-lock-owner.v2',
        ownerToken: `token-${runId}`,
        schedulerRunId: runId,
        namespace: 'test-matrix',
        executionKey: runId,
        sourceCommit: null,
        worktreeFingerprint: 'stable',
        createdAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        ...overrides
    }
}

function tier(id, command) {
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
    }
}

function cliTierLines(id, command) {
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
    ]
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(message)
}

const stableSnapshot = async () => ({ fingerprint: 'stable', entries: {} })

test('scheduler stale-lock reclaim preserves a replacement owner across the delete race', (t) => {
    const root = fixture(t, 'scheduler-lock-cas')
    const lock = path.join(root, 'runs/.locks/race.lock')
    fs.mkdirSync(lock, { recursive: true })
    const stale = schedulerOwner('race', {
        ownerToken: 'stale',
        processStartIdentity: `${currentProcessIdentity().processStartIdentity}:exited`
    })
    fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify(stale)}\n`)
    const replacement = schedulerOwner('race', { ownerToken: 'replacement' })
    const reclaimed = reclaimSchedulerRunLock(lock, stale, {
        beforeDelete({ ownerFile }) {
            fs.writeFileSync(ownerFile, `${JSON.stringify(replacement)}\n`)
        }
    })
    assert.equal(reclaimed, false)
    assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).ownerToken, 'replacement')
})

test('scheduler activity verification rejects PID reuse and fails closed on unreadable owner identity', (t) => {
    const root = fixture(t, 'scheduler-activity-identity')
    const runsRoot = path.join(root, 'runs')
    const lock = path.join(runsRoot, '.locks', 'identity.lock')
    const ownerFile = path.join(lock, 'owner.json')
    fs.mkdirSync(lock, { recursive: true })
    fs.writeFileSync(ownerFile, `${JSON.stringify(schedulerOwner('identity'))}\n`)
    assert.equal(schedulerRunLockIsActive({ runsRoot, runId: 'identity' }), true)

    const reused = schedulerOwner('identity', {
        processStartIdentity: `${currentProcessIdentity().processStartIdentity}:reused`
    })
    fs.writeFileSync(ownerFile, `${JSON.stringify(reused)}\n`)
    assert.equal(schedulerRunLockActivity({ runsRoot, runId: 'identity' }).status, 'inactive')
    assert.equal(schedulerRunLockIsActive({ runsRoot, runId: 'identity' }), false)

    fs.writeFileSync(ownerFile, '{')
    assert.equal(schedulerRunLockActivity({ runsRoot, runId: 'identity' }).status, 'unverifiable')
    assert.throws(
        () => schedulerRunLockIsActive({ runsRoot, runId: 'identity' }),
        /owner-unverifiable/u
    )
})

test(
    'registration handshake captures a live identity even for an immediately exiting command',
    {
        skip: process.platform !== 'linux'
    },
    async (t) => {
        const root = fixture(t, 'scheduler-fast-registration')
        let registration = null
        const result = await runDag({
            tiers: [tier('fast', '/bin/true')],
            root,
            runsRoot: path.join(root, 'runs'),
            runId: 'fast',
            mode: 'fresh',
            maxParallel: 1,
            snapshotWorktree: stableSnapshot,
            registerManagedProcess(identity, _tier, authority) {
                registration = { identity, authority, status: processIdentityStatus(identity).status }
            }
        })
        assert.equal(result.status, 'success')
        assert.equal(registration.status, 'live')
        assert.equal(registration.authority.kind, 'systemd-transient-service')
        assert.equal(registration.authority.killPolicy, 'control-group')
    }
)

test(
    'durable Linux containment kills a detached new-session writer before scheduler success',
    {
        skip: process.platform !== 'linux'
    },
    async (t) => {
        const root = fixture(t, 'scheduler-detached-writer')
        const lateWrite = path.join(root, 'late-write')
        const writer = path.join(root, 'writer.mjs')
        const wrapper = path.join(root, 'wrapper.mjs')
        fs.writeFileSync(
            writer,
            [
                "import fs from 'node:fs'",
                'setTimeout(() => {',
                `    fs.writeFileSync(${JSON.stringify(lateWrite)}, 'late')`,
                '}, 200)'
            ].join('\n')
        )
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
        )
        const result = await runDag({
            tiers: [tier('escape', `${JSON.stringify(process.execPath)} ${JSON.stringify(wrapper)}`)],
            root,
            runsRoot: path.join(root, 'runs'),
            runId: 'escape',
            mode: 'fresh',
            maxParallel: 1,
            snapshotWorktree: stableSnapshot,
            registerManagedProcess() {}
        })
        await new Promise((resolve) => setTimeout(resolve, 350))
        assert.equal(result.status, 'success')
        assert.equal(fs.existsSync(lateWrite), false)
    }
)

test(
    'production build receipt persists the durable authority and seals only after it becomes inactive',
    {
        skip: process.platform !== 'linux'
    },
    async (t) => {
        const root = fixture(t, 'production-contained-writer')
        const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'stable' }
        const namespace = 'production:contained'
        const layout = prepareProductionBuildLayout({
            root,
            runId: 'contained',
            sourceState,
            namespace
        })
        const lateWrite = path.join(layout.runRoot, 'late-write')
        const writer = path.join(root, 'writer.mjs')
        const wrapper = path.join(root, 'wrapper.mjs')
        fs.writeFileSync(
            writer,
            `import fs from 'node:fs'; setTimeout(() => fs.writeFileSync(${JSON.stringify(lateWrite)}, 'late'), 200)\n`
        )
        fs.writeFileSync(
            wrapper,
            `import { spawn } from 'node:child_process'; const child = spawn(process.execPath, [${JSON.stringify(writer)}], { detached: true, stdio: 'ignore' }); child.unref()\n`
        )
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
            onSourceState(value) {
                bindProductionBuildLayoutSource(layout, value)
            },
            registerManagedProcess(identity, _tier, authority) {
                registerProductionBuildCompiler(layout, identity, authority)
            }
        })
        assert.equal(result.status, 'success')
        const finalized = finalizeProductionBuildLayout(layout, { status: 'success' })
        assert.equal(finalized.owner.managedContainmentAuthorities.length, 1)
        assert.equal(finalized.owner.managedContainmentAuthorities[0].kind, 'systemd-transient-service')
        await new Promise((resolve) => setTimeout(resolve, 350))
        assert.equal(fs.existsSync(lateWrite), false)
    }
)

test('CLI scheduler errors preserve the original failure and seal the production build layout', (t) => {
    const root = fixture(t, 'scheduler-cli-error-seal')
    const runner = materializeTestMatrixRunner(repositoryRoot, root)
    const matrix = path.join(root, 'matrix.yml')
    const runId = `scheduler-cli-error-seal-${process.pid}`
    const tierLines = (id, variant, supersedes = []) => [
        `  - id: ${id}`,
        `    command: ${JSON.stringify(`${process.execPath} -e "process.exit(0)"`)}`,
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
    ]
    fs.writeFileSync(
        matrix,
        [
            'version: fsusblog-test-matrix-v2',
            'tiers:',
            ...tierLines('ordinary', 'ordinary'),
            ...tierLines('invalid-replacement', 'ordinary', ['ordinary'])
        ].join('\n')
    )

    const result = spawnSync(
        process.execPath,
        [runner, 'run', 'invalid-replacement', '--no-deps', '--resume'],
        {
            cwd: root,
            env: {
                ...process.env,
                FSUSBLOG_MATRIX_FILE: matrix,
                FSUSBLOG_TEST_RUN_ID: runId
            },
            encoding: 'utf8'
        }
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /invalid supersedes metadata/u)
    assert.doesNotMatch(result.stderr, /failed to seal scheduler error/u)

    const runRoot = path.join(root, '.tmp/build', runId)
    const manifest = JSON.parse(fs.readFileSync(path.join(runRoot, 'layout.json'), 'utf8'))
    assert.equal(manifest.status, 'failure')
    assert.equal(manifest.owner.state, 'failed')
    assert.equal(fs.existsSync(path.join(runRoot, '.active.json')), false)
})

test(
    'materialized CLI preserves tier exit 7 while reporting seal failure and removing active authority',
    {
        skip: process.platform !== 'linux'
    },
    (t) => {
        const root = fixture(t, 'scheduler-cli-tier-and-seal-failure')
        const runner = materializeTestMatrixRunner(repositoryRoot, root)
        const lifecycleFile = path.join(root, 'tools/test-matrix/production-build-lifecycle.mjs')
        const lifecycleSource = fs.readFileSync(lifecycleFile, 'utf8')
        const finalizeAdapter = '    finalize: finalizeProductionBuildLayout,'
        assert.equal(lifecycleSource.split(finalizeAdapter).length - 1, 1)
        fs.writeFileSync(
            lifecycleFile,
            lifecycleSource.replace(
                finalizeAdapter,
                "    finalize: () => { throw new Error('injected production build seal failure') },"
            )
        )

        const matrix = path.join(root, 'matrix.yml')
        const runId = `scheduler-cli-tier-and-seal-failure-${process.pid}`
        fs.writeFileSync(
            matrix,
            [
                'version: fsusblog-test-matrix-v2',
                'tiers:',
                ...cliTierLines('exit-seven', `${process.execPath} -e "process.exit(7)"`)
            ].join('\n')
        )
        const result = spawnSync(process.execPath, [runner, 'run', 'exit-seven', '--no-deps', '--resume'], {
            cwd: root,
            env: {
                ...process.env,
                FSUSBLOG_MATRIX_FILE: matrix,
                FSUSBLOG_TEST_RUN_ID: runId
            },
            encoding: 'utf8'
        })
        assert.equal(result.status, 7, result.stderr)
        assert.match(result.stderr, /exited 7/u)
        assert.match(result.stderr, /secondary seal failure: injected production build seal failure/u)

        const runRoot = path.join(root, '.tmp/build', runId)
        const manifest = JSON.parse(fs.readFileSync(path.join(runRoot, 'layout.json'), 'utf8'))
        assert.equal(manifest.status, 'failure')
        assert.equal(manifest.owner.state, 'failed')
        assert.equal(manifest.lifecycleFinalization.mode, 'fail-closed-fallback')
        assert.equal(fs.existsSync(path.join(runRoot, '.active.json')), false)
    }
)

test(
    'materialized advisory CLI SIGTERM cancels the tier and seals the layout without an active marker',
    {
        skip: process.platform !== 'linux'
    },
    async (t) => {
        const root = fixture(t, 'scheduler-cli-sigterm')
        const runner = materializeTestMatrixRunner(repositoryRoot, root)
        const matrix = path.join(root, 'matrix.yml')
        const runId = `scheduler-cli-sigterm-${process.pid}`
        fs.writeFileSync(
            matrix,
            [
                'version: fsusblog-test-matrix-v2',
                'tiers:',
                ...cliTierLines('long-running', `${process.execPath} -e "setTimeout(() => {}, 30000)"`)
            ].join('\n')
        )
        const child = spawn(process.execPath, [runner, 'run', 'long-running', '--no-deps', '--resume'], {
            cwd: root,
            env: {
                ...process.env,
                FSUSBLOG_CGROUP_ENFORCEMENT: 'advisory',
                FSUSBLOG_MATRIX_FILE: matrix,
                FSUSBLOG_TEST_RUN_ID: runId
            },
            stdio: ['ignore', 'pipe', 'pipe']
        })
        t.after(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        })
        child.stdout.resume()
        let stderr = ''
        child.stderr.on('data', (chunk) => {
            stderr += chunk
        })
        const closed = new Promise((resolve) => {
            child.once('close', (code, signal) => resolve({ code, signal }))
        })
        const runRoot = path.join(root, '.tmp/build', runId)
        await waitFor(() => {
            try {
                const manifest = JSON.parse(fs.readFileSync(path.join(runRoot, 'layout.json'), 'utf8'))
                return manifest.owner?.state === 'building'
            } catch {
                return false
            }
        }, `CLI did not enter building state: ${stderr}`)
        child.kill('SIGTERM')
        const outcome = await closed
        assert.deepEqual(outcome, { code: 143, signal: null }, stderr)
        const manifest = JSON.parse(fs.readFileSync(path.join(runRoot, 'layout.json'), 'utf8'))
        assert.equal(manifest.status, 'cancelled')
        assert.equal(manifest.owner.state, 'cancelled')
        assert.equal(fs.existsSync(path.join(runRoot, '.active.json')), false)
    }
)

function windowsJobAdapter(events, { failAt = null, exitCode = 7 } = {}) {
    const step = (name, value) => {
        events.push(name)
        if (failAt === name) throw new Error(`injected ${name} failure`)
        return value
    }
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
    }
}

test('Windows Job state machine completes ready/start, assignment, resume, and kill-on-close in order', async () => {
    const events = []
    const result = await runWindowsJobSupervisorStateMachine({
        adapter: windowsJobAdapter(events)
    })
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
    ])
    assert.equal(result.schema, windowsJobSupervisorStateSchema)
    assert.equal(result.assignedBeforeResume, true)
    assert.equal(result.killPolicy, 'kill-on-job-close')
})

test('Windows Job state machine recovers a start-handshake failure by terminating and closing the Job', async () => {
    const events = []
    await assert.rejects(
        runWindowsJobSupervisorStateMachine({
            adapter: windowsJobAdapter(events, { failAt: 'waitForStart' })
        }),
        /injected waitForStart failure/u
    )
    assert.deepEqual(events, [
        'createJob',
        'configureKillOnClose',
        'signalReady',
        'waitForStart',
        'terminateJob:1',
        'closeJob',
        'cleanupHandshake'
    ])
})

test('Windows Job state machine never resumes a process whose Job assignment failed', async () => {
    const events = []
    await assert.rejects(
        runWindowsJobSupervisorStateMachine({
            adapter: windowsJobAdapter(events, { failAt: 'assignProcess' })
        }),
        /injected assignProcess failure/u
    )
    assert.equal(events.includes('resumeProcess'), false)
    assert.deepEqual(events.slice(-5), [
        'terminateProcess',
        'terminateJob:1',
        'closeProcess',
        'closeJob',
        'cleanupHandshake'
    ])
})

test('PowerShell supervisor declares the same tested Job state-machine schema', () => {
    const script = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '../../tools/test-matrix/windows-job-supervisor.ps1'),
        'utf8'
    )
    assert.match(script, new RegExp(windowsJobSupervisorStateSchema.replaceAll('.', '\\.'), 'u'))
})
