import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

import {
    physicalExecutionProcessTreeSchema,
    runPhysicalExecution
} from '../../tools/test/physical-execution-process-tree.mjs'
import { processGroupMemberIdentities } from '../../tools/test/process-identity.mjs'
import { runBoundExecution } from '../../tools/test/run-once.mjs'

const quiet = { write() {} }
const fastPolicy = {
    schema: 'fsusblog.physical-execution-process-policy.v1',
    gracefulTerminationMs: 80,
    forceTerminationMs: 1500,
    observationIntervalMs: 10,
    zeroMemberObservations: 2,
    unixProcessGroupRequired: true,
    linuxCgroupRequired: true,
    windowsJobObjectRequired: true
}

function temporaryRoot(name) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`))
}

function processExists(pid) {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        if (error.code === 'ESRCH') return false
        throw error
    }
}

function readinessSink(marker = 'ready') {
    let output = ''
    let resolve
    const ready = new Promise((value) => {
        resolve = value
    })
    return {
        sink: {
            write(chunk) {
                output += chunk.toString()
                if (output.includes(marker)) resolve()
            }
        },
        ready
    }
}

async function expectFailure(options) {
    try {
        await runPhysicalExecution({
            policy: fastPolicy,
            stdout: quiet,
            stderr: quiet,
            ...options
        })
    } catch (error) {
        return error
    }
    assert.fail('physical execution unexpectedly succeeded')
}

test('child and sleeping grandchild are both absent after cancellation', async () => {
    const controller = new AbortController()
    const readiness = readinessSink()
    const result = runPhysicalExecution({
        command: [
            process.execPath,
            '-e',
            "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('ready',c.pid);setInterval(()=>{},1000)"
        ],
        signal: controller.signal,
        residualRoot: path.join(temporaryRoot('cancel-tree'), 'residuals'),
        policy: fastPolicy,
        stdout: readiness.sink,
        stderr: quiet
    })
    await readiness.ready
    controller.abort(Object.assign(new Error('cancelled by test'), { name: 'AbortError', signal: 'SIGTERM' }))
    const error = await result.catch((value) => value)
    assert.equal(error.name, 'AbortError')
    assert.equal(error.physicalExecution.postObservation, 'zero-members')
    assert.ok(error.physicalExecution.processInventory.length >= 3)
    for (const entry of error.physicalExecution.processInventory) {
        assert.equal(processExists(entry.pid), false, `process ${entry.pid} remained alive`)
    }
})

test('parent exit with a live grandchild is terminated and cannot succeed', async () => {
    const error = await expectFailure({
        command: [
            process.execPath,
            '-e',
            "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref()"
        ],
        residualRoot: path.join(temporaryRoot('parent-exit'), 'residuals')
    })
    assert.match(error.message, /parent exited before its process group became empty/u)
    assert.ok(error.physicalExecution.termination.length > 0)
    for (const entry of error.physicalExecution.processInventory) {
        assert.equal(processExists(entry.pid), false)
    }
})

test('ignored graceful signal is followed by force kill and recorded', async () => {
    const controller = new AbortController()
    const readiness = readinessSink()
    const result = runPhysicalExecution({
        command: [process.execPath, '-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
        signal: controller.signal,
        residualRoot: path.join(temporaryRoot('force'), 'residuals'),
        policy: fastPolicy,
        stdout: readiness.sink,
        stderr: quiet
    })
    await readiness.ready
    controller.abort(Object.assign(new Error('timeout'), { name: 'AbortError', signal: 'SIGTERM' }))
    const error = await result.catch((value) => value)
    assert.deepEqual(error.physicalExecution.termination.map((entry) => entry.phase), ['graceful', 'forced'])
    assert.ok(error.physicalExecution.processInventory.some((entry) => entry.signal === 'SIGKILL'))
})

test('a descendant spawned while cancelling remains contained and is terminated', async () => {
    const controller = new AbortController()
    const readiness = readinessSink()
    const result = runPhysicalExecution({
        command: [
            process.execPath,
            '-e',
            "const{spawn}=require('child_process');process.on('SIGTERM',()=>{spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});});console.log('ready');setInterval(()=>{},1000)"
        ],
        signal: controller.signal,
        residualRoot: path.join(temporaryRoot('late-spawn'), 'residuals'),
        policy: fastPolicy,
        stdout: readiness.sink,
        stderr: quiet
    })
    await readiness.ready
    controller.abort(Object.assign(new Error('cancel'), { name: 'AbortError', signal: 'SIGTERM' }))
    const error = await result.catch((value) => value)
    assert.ok(error.physicalExecution.processInventory.some((entry) => entry.role === 'descendant'))
    for (const entry of error.physicalExecution.processInventory) {
        assert.equal(processExists(entry.pid), false)
    }
})

test('PID start identity mismatch prevents any signal from being sent', async () => {
    const controller = new AbortController()
    const residualRoot = path.join(temporaryRoot('pid-reuse'), 'residuals')
    const signalled = []
    let authority = null
    const result = runPhysicalExecution({
        command: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
        signal: controller.signal,
        residualRoot,
        policy: fastPolicy,
        stdout: quiet,
        stderr: quiet,
        collectMembers(group) {
            authority = group
            return { status: 'unverifiable', reason: 'process-group leader start identity mismatch' }
        },
        signalGroup(pid, signal) {
            signalled.push({ pid, signal })
        }
    })
    setTimeout(() => controller.abort(Object.assign(new Error('cancel'), { name: 'AbortError', signal: 'SIGTERM' })), 80)
    const error = await result.catch((value) => value)
    assert.match(error.message, /start identity mismatch/u)
    assert.deepEqual(signalled, [])
    assert.ok(authority)
    process.kill(-authority.groupId, 'SIGKILL')
})

test('post-observe collector failure blocks the next candidate before spawn', async () => {
    const controller = new AbortController()
    const residualRoot = path.join(temporaryRoot('collector'), 'residuals')
    let collections = 0
    const result = runPhysicalExecution({
        command: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
        signal: controller.signal,
        residualRoot,
        policy: fastPolicy,
        stdout: quiet,
        stderr: quiet,
        collectMembers(group, options) {
            collections += 1
            if (collections > 1) return { status: 'unverifiable', reason: 'injected collector failure' }
            return processGroupMemberIdentities(group, options)
        }
    })
    setTimeout(() => controller.abort(Object.assign(new Error('cancel'), { name: 'AbortError', signal: 'SIGTERM' })), 80)
    const error = await result.catch((value) => value)
    assert.match(error.message, /post-observe failed: injected collector failure/u)
    assert.ok(fs.readdirSync(residualRoot).some((entry) => entry.endsWith('.json')))

    let spawns = 0
    const blocked = await expectFailure({
        command: [process.execPath, '-e', 'process.exit(0)'],
        residualRoot,
        spawnProcess() {
            spawns += 1
            assert.fail('spawn must remain zero while residual evidence is unresolved')
        }
    })
    assert.match(blocked.message, /preflight blocked by unresolved residual receipt/u)
    assert.equal(spawns, 0)
})

test('Windows requires a Job Object adapter and validates its kill-on-close evidence', async () => {
    const root = path.join(temporaryRoot('windows'), 'residuals')
    const missing = await expectFailure({
        command: ['cmd.exe', '/c', 'exit', '0'],
        platform: 'win32',
        residualRoot: root,
        windowsJobAdapter: false
    })
    assert.match(missing.message, /Windows Job Object adapter is unavailable/u)

    const evidence = await runPhysicalExecution({
        command: ['cmd.exe', '/c', 'exit', '0'],
        platform: 'win32',
        residualRoot: root,
        policy: fastPolicy,
        stdout: quiet,
        stderr: quiet,
        windowsJobAdapter: {
            async run() {
                return {
                    schema: physicalExecutionProcessTreeSchema,
                    platform: 'win32',
                    policy: fastPolicy,
                    authority: {
                        schema: 'fsusblog.process-group-or-job-identity.v1',
                        platform: 'win32',
                        kind: 'windows-job-object',
                        jobName: 'Local\\FsusBlogPhysicalExecution-test',
                        killPolicy: 'kill-on-close'
                    },
                    lifecycle: ['created', 'running', 'post-observe-zero-members'],
                    termination: [],
                    postObservation: 'zero-members',
                    processInventory: [],
                    stdout: '',
                    stderr: ''
                }
            }
        }
    })
    assert.equal(evidence.authority.kind, 'windows-job-object')

    const script = fs.readFileSync(path.join(
        path.dirname(new URL(import.meta.url).pathname),
        '../../tools/test/physical-execution-windows-job.ps1'
    ), 'utf8')
    assert.match(script, /JobObjectLimitKillOnJobClose/u)
    assert.match(script, /CreateProcess[\s\S]*CreateSuspended \| CreateNewProcessGroup[\s\S]*AssignProcessToJobObject[\s\S]*assignedFile[\s\S]*resumeFile[\s\S]*ResumeThread/u)
    assert.match(script, /GenerateConsoleCtrlEvent[\s\S]*ObserveEmpty[\s\S]*TerminateJobObject[\s\S]*ObserveEmpty/u)
})

test('Windows native Job Object physically contains and terminates a descendant tree', {
    skip: process.platform !== 'win32'
}, async () => {
    const controller = new AbortController()
    const readiness = readinessSink()
    const execution = runPhysicalExecution({
        command: [
            process.execPath,
            '-e',
            "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','process.on(\\'SIGTERM\\',()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('ready',c.pid);process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
        ],
        signal: controller.signal,
        residualRoot: path.join(temporaryRoot('windows-native-job'), 'residuals'),
        policy: { ...fastPolicy, gracefulTerminationMs: 500 },
        stdout: readiness.sink,
        stderr: quiet
    })
    await readiness.ready
    controller.abort(Object.assign(new Error('Windows Job cancellation'), {
        name: 'AbortError',
        signal: 'SIGTERM'
    }))
    const error = await execution.catch((value) => value)
    assert.equal(error.physicalExecution.authority.kind, 'windows-job-object')
    assert.equal(error.physicalExecution.authority.killPolicy, 'kill-on-close')
    assert.equal(error.physicalExecution.postObservation, 'zero-members')
    assert.ok(error.physicalExecution.processInventory.length >= 2)
    for (const entry of error.physicalExecution.processInventory) {
        assert.equal(processExists(entry.pid), false)
    }
})

test('partial outputs remain evidence but cannot turn a failed execution into success', async () => {
    const root = temporaryRoot('partial-output')
    const output = path.join(root, 'partial.txt')
    await assert.rejects(
        runBoundExecution({
            root: path.join(root, 'receipts'),
            runId: 'partial-output-run',
            key: 'partial-output',
            command: [process.execPath, '-e', 'write-output-then-fail'],
            cwd: root,
            inputDigest: 'input',
            environmentDigest: 'environment',
            outputContract: ['partial.txt'],
            requiredOutputs: ['partial.txt'],
            commit: 'commit',
            worktreeFingerprint: 'worktree',
            testIds: ['partial-output'],
            consumerId: 'partial-output'
        }, async () => await runPhysicalExecution({
            command: [
                process.execPath,
                '-e',
                `require('node:fs').writeFileSync(${JSON.stringify(output)},'partial');console.log('preserved stdout');console.error('preserved stderr');process.exit(7)`
            ],
            cwd: root,
            residualRoot: path.join(root, 'residuals'),
            policy: fastPolicy,
            stdout: quiet,
            stderr: quiet
        })),
        /command failed \(exit 7\)/u
    )
    const receiptDirectory = path.join(root, 'receipts', 'partial-output-run', 'receipts', 'partial-output')
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptDirectory, fs.readdirSync(receiptDirectory).find((entry) => entry.endsWith('.json'))), 'utf8'))
    assert.equal(receipt.status, 'failure')
    assert.equal(receipt.requiredOutputStates.length, 1)
    assert.match(receipt.physicalExecution.stdout, /preserved stdout/u)
    assert.match(receipt.physicalExecution.stderr, /preserved stderr/u)
    assert.ok(receipt.physicalExecution.processInventory.every((entry) => entry.startIdentity && entry.executableDigest && entry.commandDigest))
})

test('cancelled run-bound receipt retains stdout, stderr, and process inventory', async () => {
    const root = temporaryRoot('cancelled-receipt')
    const controller = new AbortController()
    const readiness = readinessSink()
    const execution = runBoundExecution({
        root: path.join(root, 'receipts'),
        runId: 'cancelled-receipt-run',
        key: 'cancelled-receipt',
        command: [process.execPath, '-e', 'cancelled-receipt'],
        cwd: root,
        inputDigest: 'input',
        environmentDigest: 'environment',
        commit: 'commit',
        worktreeFingerprint: 'worktree',
        testIds: ['cancelled-receipt'],
        consumerId: 'cancelled-receipt',
        signal: controller.signal
    }, async () => await runPhysicalExecution({
        command: [
            process.execPath,
            '-e',
            "console.log('ready retained stdout');console.error('retained stderr');setInterval(()=>{},1000)"
        ],
        cwd: root,
        signal: controller.signal,
        residualRoot: path.join(root, 'residuals'),
        policy: fastPolicy,
        stdout: readiness.sink,
        stderr: quiet
    }))
    await readiness.ready
    controller.abort(Object.assign(new Error('cancelled receipt'), { name: 'AbortError', signal: 'SIGTERM' }))
    await assert.rejects(execution, { name: 'AbortError' })

    const receiptDirectory = path.join(root, 'receipts', 'cancelled-receipt-run', 'receipts', 'cancelled-receipt')
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptDirectory, fs.readdirSync(receiptDirectory).find((entry) => entry.endsWith('.json'))), 'utf8'))
    assert.equal(receipt.status, 'cancelled')
    assert.equal(receipt.physicalExecution.postObservation, 'zero-members')
    assert.match(receipt.physicalExecution.stdout, /retained stdout/u)
    assert.match(receipt.physicalExecution.stderr, /retained stderr/u)
    assert.ok(receipt.physicalExecution.processInventory.length >= 2)
})

test('Linux cgroup authority contains a setsid daemon holding a port and inherited output FD', {
    skip: process.platform !== 'linux'
}, async (t) => {
    const capability = spawnSync('systemctl', ['--user', 'show-environment'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    })
    if (capability.status !== 0) {
        t.skip(`systemd user cgroup authority unavailable: ${String(capability.stderr).trim()}`)
        return
    }
    const root = temporaryRoot('daemon-port-fd')
    const marker = path.join(root, 'daemon.json')
    const daemonSource = [
        "const fs=require('fs'),net=require('net')",
        "process.on('SIGTERM',()=>{})",
        "const server=net.createServer(()=>{})",
        "server.listen(0,'127.0.0.1',()=>{",
        "fs.writeFileSync(process.env.FSUSBLOG_DAEMON_MARKER,JSON.stringify({pid:process.pid,port:server.address().port}))",
        "console.log('daemon-ready')",
        "})",
        "setInterval(()=>{},1000)"
    ].join(';')
    const parentSource = [
        "const{spawn}=require('child_process'),fs=require('fs')",
        `spawn('setsid',[process.execPath,'-e',${JSON.stringify(daemonSource)}],{detached:true,stdio:['ignore','inherit','inherit'],env:{...process.env,FSUSBLOG_DAEMON_MARKER:${JSON.stringify(marker)}}}).unref()`,
        `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);console.log('ready')}},5)`,
        "setInterval(()=>{},1000)"
    ].join(';')
    const controller = new AbortController()
    const readiness = readinessSink()
    const execution = runPhysicalExecution({
        command: [process.execPath, '-e', parentSource],
        signal: controller.signal,
        residualRoot: path.join(root, 'residuals'),
        policy: { ...fastPolicy, gracefulTerminationMs: 250 },
        stdout: readiness.sink,
        stderr: quiet
    })
    await readiness.ready
    const daemon = JSON.parse(fs.readFileSync(marker, 'utf8'))
    controller.abort(Object.assign(new Error('daemon cancellation'), {
        name: 'AbortError',
        signal: 'SIGTERM'
    }))
    const error = await execution.catch((value) => value)
    assert.equal(error.physicalExecution.authority.kind, 'linux-cgroup-process-group')
    assert.equal(error.physicalExecution.postObservation, 'zero-members')
    assert.ok(error.physicalExecution.processInventory.some((entry) => entry.pid === daemon.pid))
    assert.equal(processExists(daemon.pid), false)
    await assert.rejects(new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: daemon.port })
        socket.setTimeout(250)
        socket.once('connect', () => {
            socket.destroy()
            resolve()
        })
        socket.once('error', reject)
        socket.once('timeout', () => {
            socket.destroy()
            reject(new Error('connection timed out after daemon termination'))
        })
    }))
})
