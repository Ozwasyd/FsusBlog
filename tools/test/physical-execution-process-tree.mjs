import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
    collectProcessGroupOrJobIdentity,
    collectProcessIdentity,
    processGroupMemberIdentities
} from './process-identity.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const policyFile = path.join(repoRoot, 'config/testing/physical-execution-process-policy.json')
const unixBootstrap = path.join(repoRoot, 'tools/test/physical-execution-unix-bootstrap.mjs')
const defaultResidualRoot = path.join(repoRoot, '.tmp', 'physical-execution-residuals')
export const physicalExecutionProcessTreeSchema = 'fsusblog.physical-execution-process-tree.v1'

function readPolicy(file = policyFile) {
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (
        policy?.schema !== 'fsusblog.physical-execution-process-policy.v1' ||
        !Number.isInteger(policy.gracefulTerminationMs) ||
        policy.gracefulTerminationMs < 0 ||
        !Number.isInteger(policy.forceTerminationMs) ||
        policy.forceTerminationMs <= 0 ||
        !Number.isInteger(policy.observationIntervalMs) ||
        policy.observationIntervalMs <= 0 ||
        !Number.isInteger(policy.zeroMemberObservations) ||
        policy.zeroMemberObservations < 2 ||
        policy.unixProcessGroupRequired !== true ||
        policy.linuxCgroupRequired !== true ||
        policy.windowsJobObjectRequired !== true
    ) {
        throw new Error('physical execution process policy is invalid')
    }
    return policy
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function waitForObservationInterval(milliseconds) {
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(waitBuffer, 0, 0, milliseconds)
}

function processCoordinates(pid, platform = process.platform, procRoot = '/proc') {
    if (platform === 'linux') {
        const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8')
        const close = stat.lastIndexOf(')')
        const fields = stat.slice(close + 2).trim().split(/\s+/u)
        return { ppid: Number(fields[1]), pgid: Number(fields[2]), jobId: null }
    }
    return { ppid: null, pgid: null, jobId: null }
}

function inventoryRecord(identity, authority, role, observedAt, coordinates) {
    return {
        pid: identity.pid,
        startIdentity: identity.processStartIdentity,
        ppid: coordinates.ppid,
        pgid: authority.kind === 'process-group' ? authority.groupId : null,
        jobId: authority.kind === 'windows-job-object' ? authority.jobName : null,
        executableDigest: identity.executableDigest,
        commandDigest: identity.commandDigest,
        role,
        observedAt,
        exitCode: null,
        signal: null
    }
}

function recordMembers(inventory, identities, authority, leaderPid, platform, procRoot) {
    const observedAt = new Date().toISOString()
    for (const identity of identities) {
        const key = `${identity.pid}:${identity.processStartIdentity}`
        if (inventory.has(key)) continue
        let coordinates = { ppid: null, pgid: null, jobId: authority.jobName ?? null }
        try {
            coordinates = processCoordinates(identity.pid, platform, procRoot)
        } catch (error) {
            if (!['ENOENT', 'ESRCH'].includes(error?.code)) throw error
        }
        inventory.set(
            key,
            inventoryRecord(
                identity,
                authority,
                identity.pid === leaderPid ? 'direct-child' : 'descendant',
                observedAt,
                coordinates
            )
        )
    }
}

async function stableMemberObservation({
    authority,
    inventory,
    leaderPid,
    policy,
    collectMembers,
    platform,
    procRoot,
    deadlineAt = Number.POSITIVE_INFINITY
}) {
    let zeroCount = 0
    while (Date.now() <= deadlineAt) {
        const observation = collectMembers(authority, { platform, procRoot })
        if (observation?.status !== 'verified') {
            throw new Error(`physical execution post-observe failed: ${observation?.reason ?? 'unknown collector failure'}`)
        }
        recordMembers(inventory, observation.identities, authority, leaderPid, platform, procRoot)
        if (observation.identities.length === 0) {
            zeroCount += 1
            if (zeroCount >= policy.zeroMemberObservations) return { status: 'empty', members: [] }
        } else {
            zeroCount = 0
        }
        await delay(policy.observationIntervalMs)
    }
    const finalObservation = collectMembers(authority, { platform, procRoot })
    if (finalObservation?.status !== 'verified') {
        throw new Error(`physical execution post-observe failed: ${finalObservation?.reason ?? 'unknown collector failure'}`)
    }
    recordMembers(inventory, finalObservation.identities, authority, leaderPid, platform, procRoot)
    return { status: finalObservation.identities.length === 0 ? 'empty' : 'residual', members: finalObservation.identities }
}

function sameIdentity(expected, actual) {
    return expected.pid === actual.pid
        && expected.processStartIdentity === actual.processStartIdentity
        && expected.executableDigest === actual.executableDigest
        && expected.commandDigest === actual.commandDigest
}

export function terminatePhysicalExecutionAuthoritySync({
    authority,
    reason,
    policy = readPolicy(),
    expectedIdentities = [],
    collectMembers = processGroupMemberIdentities,
    validateMembers = () => ({ status: 'verified' }),
    signalAuthority = (value, signal) => process.kill(-value.groupId, signal),
    platform = process.platform,
    procRoot = '/proc',
    windowsJobTerminator = null
}) {
    if (authority?.kind === 'systemd-transient-service' && authority.platform === 'linux') {
        const show = () => {
            const result = spawnSync('systemctl', [
                '--user',
                'show',
                authority.unitName,
                '--property=LoadState',
                '--property=ActiveState',
                '--property=ControlGroup',
                '--no-pager'
            ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
            if (result.status !== 0) {
                return { status: 'unverifiable', reason: String(result.stderr ?? result.stdout ?? '').trim() }
            }
            const values = Object.fromEntries(String(result.stdout).trim().split(/\r?\n/u)
                .map((line) => line.split(/=(.*)/su).slice(0, 2)))
            let pids = []
            if (values.ControlGroup) {
                const file = path.join(
                    '/sys/fs/cgroup',
                    values.ControlGroup.replace(/^\/+/u, ''),
                    'cgroup.procs'
                )
                try {
                    pids = fs.readFileSync(file, 'utf8').trim().split(/\s+/u)
                        .filter(Boolean)
                        .map(Number)
                } catch (error) {
                    if (error.code !== 'ENOENT') {
                        return { status: 'unverifiable', reason: error.message }
                    }
                }
            }
            return {
                status: 'verified',
                empty: pids.length === 0 &&
                    (values.LoadState === 'not-found' ||
                      ['inactive', 'failed'].includes(values.ActiveState)),
                pids
            }
        }
        const waitEmpty = (deadlineAt) => {
            let zeroObservations = 0
            while (Date.now() <= deadlineAt) {
                const observed = show()
                if (observed.status !== 'verified') return observed
                if (observed.empty) {
                    zeroObservations += 1
                    if (zeroObservations >= policy.zeroMemberObservations) return observed
                } else {
                    zeroObservations = 0
                }
                waitForObservationInterval(policy.observationIntervalMs)
            }
            return show()
        }
        spawnSync('systemctl', [
            '--user',
            'kill',
            '--kill-who=all',
            '--signal=SIGTERM',
            authority.unitName
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        let observed = waitEmpty(Date.now() + policy.gracefulTerminationMs)
        let forced = false
        if (observed.status === 'verified' && !observed.empty) {
            forced = true
            spawnSync('systemctl', [
                '--user',
                'kill',
                '--kill-who=all',
                '--signal=SIGKILL',
                authority.unitName
            ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
            spawnSync('systemctl', ['--user', 'stop', authority.unitName], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe']
            })
            observed = waitEmpty(Date.now() + policy.forceTerminationMs)
        }
        return observed.status === 'verified' && observed.empty
            ? { terminated: true, forced, reason, postObservation: 'zero-members' }
            : {
                terminated: false,
                reason: observed.reason ?? 'systemd cgroup still has live members',
                postObservation: observed.status === 'verified' ? 'members-remain' : 'unverifiable'
            }
    }
    if (authority?.kind === 'windows-job-object') {
        if (typeof windowsJobTerminator !== 'function') {
            return {
                terminated: false,
                reason: 'Windows Job Object termination adapter is unavailable',
                postObservation: 'unverifiable'
            }
        }
        return windowsJobTerminator({ authority, reason, policy, expectedIdentities })
    }
    if (
        authority?.schema !== 'fsusblog.process-group-or-job-identity.v1' ||
        authority.kind !== 'process-group' ||
        !['linux', 'darwin'].includes(authority.platform) ||
        authority.platform !== platform
    ) {
        return {
            terminated: false,
            reason: 'physical execution containment authority is incomplete',
            postObservation: 'unverifiable'
        }
    }
    const expectedByPid = new Map(expectedIdentities.map((identity) => [identity.pid, identity]))
    const observe = () => {
        const observed = collectMembers(authority, { platform, procRoot })
        if (observed?.status !== 'verified' || !Array.isArray(observed.identities)) {
            return {
                status: 'unverifiable',
                reason: observed?.reason ?? 'process-group member collection failed'
            }
        }
        for (const member of observed.identities) {
            const expected = expectedByPid.get(member.pid)
            if (expected && !sameIdentity(expected, member)) {
                return {
                    status: 'unverifiable',
                    reason: `process identity changed before termination for PID ${member.pid}`
                }
            }
        }
        const validation = validateMembers(observed.identities)
        if (validation?.status !== 'verified') {
            return {
                status: 'unverifiable',
                reason: validation?.reason ?? 'process-group ownership validation failed'
            }
        }
        return observed
    }
    const initial = observe()
    if (initial.status !== 'verified') {
        return {
            terminated: false,
            reason: initial.reason,
            postObservation: 'unverifiable'
        }
    }
    if (initial.identities.length === 0) {
        return {
            terminated: true,
            alreadyAbsent: true,
            reason,
            postObservation: 'zero-members',
            processInventory: []
        }
    }
    const inventory = new Map(initial.identities.map((identity) => [
        `${identity.pid}:${identity.processStartIdentity}`,
        identity
    ]))
    const observeUntil = (deadlineAt) => {
        let zeroObservations = 0
        while (Date.now() <= deadlineAt) {
            const observation = observe()
            if (observation.status !== 'verified') return observation
            for (const identity of observation.identities) {
                inventory.set(`${identity.pid}:${identity.processStartIdentity}`, identity)
            }
            if (observation.identities.length === 0) {
                zeroObservations += 1
                if (zeroObservations >= policy.zeroMemberObservations) {
                    return { status: 'empty', identities: [] }
                }
            } else {
                zeroObservations = 0
            }
            waitForObservationInterval(policy.observationIntervalMs)
        }
        return observe()
    }
    try {
        signalAuthority(authority, 'SIGTERM')
    } catch (error) {
        if (error?.code !== 'ESRCH') {
            return {
                terminated: false,
                reason: `graceful containment signal failed: ${error.message}`,
                postObservation: 'unverifiable'
            }
        }
    }
    let observation = observeUntil(Date.now() + policy.gracefulTerminationMs)
    let forced = false
    if (observation.status === 'unverifiable') {
        return {
            terminated: false,
            reason: observation.reason,
            postObservation: 'unverifiable',
            processInventory: [...inventory.values()]
        }
    }
    if (observation.status !== 'empty' && observation.identities.length > 0) {
        forced = true
        try {
            signalAuthority(authority, 'SIGKILL')
        } catch (error) {
            if (error?.code !== 'ESRCH') {
                return {
                    terminated: false,
                    reason: `forced containment signal failed: ${error.message}`,
                    postObservation: 'unverifiable',
                    processInventory: [...inventory.values()]
                }
            }
        }
        observation = observeUntil(Date.now() + policy.forceTerminationMs)
    }
    if (observation.status !== 'empty') {
        return {
            terminated: false,
            reason: observation.reason ?? 'containment authority still has live members',
            postObservation: observation.status === 'verified' ? 'members-remain' : 'unverifiable',
            processInventory: [...inventory.values()]
        }
    }
    return {
        terminated: true,
        forced,
        reason,
        postObservation: 'zero-members',
        processInventory: [...inventory.values()]
    }
}

function residualMarkerFiles(root) {
    if (!fs.existsSync(root)) return []
    return fs.readdirSync(root).filter((entry) => entry.endsWith('.json')).sort()
}

function writeResidualMarker(root, evidence, reason) {
    fs.mkdirSync(root, { recursive: true })
    const marker = path.join(root, `${Date.now()}-${process.pid}-${randomUUID()}.json`)
    fs.writeFileSync(marker, `${JSON.stringify({
        schema: 'fsusblog.physical-execution-residual-block.v1',
        reason,
        authority: evidence.authority,
        processInventory: evidence.processInventory,
        observedAt: new Date().toISOString()
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return marker
}

function physicalExecutionError(message, evidence, cause = null) {
    const error = new Error(message, cause ? { cause } : undefined)
    if (cause?.name) error.name = cause.name
    if (cause?.signal) error.signal = cause.signal
    if (Number.isInteger(cause?.exitCode)) error.exitCode = cause.exitCode
    error.physicalExecution = evidence
    return error
}

async function waitForExit(child) {
    return await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))
    })
}

async function startUnixExecution({
    command,
    cwd,
    env,
    signal,
    policy,
    residualRoot,
    collectIdentity,
    collectAuthority,
    collectMembers,
    procRoot,
    spawnProcess,
    signalGroup,
    stdout,
    stderr
}) {
    const lifecycle = ['created']
    const termination = []
    const inventory = new Map()
    const output = { stdout: '', stderr: '' }
    const encodedCommand = Buffer.from(JSON.stringify(command), 'utf8').toString('base64url')
    const child = spawnProcess(process.execPath, [unixBootstrap, encodedCommand], {
        cwd,
        env,
        detached: true,
        stdio: ['inherit', 'pipe', 'pipe', 'ipc']
    })
    child.stdout?.on('data', (chunk) => {
        output.stdout += chunk.toString()
        stdout?.write(chunk)
    })
    child.stderr?.on('data', (chunk) => {
        output.stderr += chunk.toString()
        stderr?.write(chunk)
    })
    await new Promise((resolve, reject) => {
        child.on('message', (message) => {
            if (message?.type === 'physical-execution-bootstrap-ready') resolve()
        })
        child.once('error', reject)
    })

    const leader = collectIdentity(child.pid, { platform: process.platform, procRoot })
    if (leader.status !== 'verified') {
        try {
            signalGroup(-child.pid, 'SIGKILL')
        } catch {}
        throw new Error(`physical execution leader identity is unverifiable: ${leader.reason}`)
    }
    const authorityResult = collectAuthority(child.pid, { platform: process.platform, procRoot })
    if (authorityResult.status !== 'verified' || authorityResult.value.kind !== 'process-group') {
        try {
            signalGroup(-child.pid, 'SIGKILL')
        } catch {}
        throw new Error(`physical execution process group is unverifiable: ${authorityResult.reason ?? 'incomplete authority'}`)
    }
    const authority = authorityResult.value
    if (authority.groupId !== child.pid) {
        try {
            signalGroup(-child.pid, 'SIGKILL')
        } catch {}
        throw new Error('physical execution child did not become its run-owned process-group leader')
    }
    recordMembers(inventory, [leader], authority, child.pid, process.platform, procRoot)
    child.send({ type: 'physical-execution-start' })
    const commandChildPid = await new Promise((resolve, reject) => {
        const onExit = () => reject(new Error('physical execution bootstrap exited before command registration'))
        child.once('exit', onExit)
        child.on('message', (message) => {
            if (message?.type !== 'physical-execution-child-started') return
            child.off('exit', onExit)
            resolve(Number(message.pid))
        })
    })
    const commandChild = collectIdentity(commandChildPid, { platform: process.platform, procRoot })
    if (commandChild.status !== 'verified') {
        signalGroup(-child.pid, 'SIGKILL')
        throw new Error(`physical execution command identity is unverifiable: ${commandChild.reason}`)
    }
    recordMembers(inventory, [commandChild], authority, commandChildPid, process.platform, procRoot)
    const commandChildKey = `${commandChild.pid}:${commandChild.processStartIdentity}`
    inventory.get(commandChildKey).role = 'direct-child'
    inventory.get(`${leader.pid}:${leader.processStartIdentity}`).role = 'containment-supervisor'
    child.disconnect()
    lifecycle.push('running')

    let abortReason = null
    let resolveAbort
    const abortPromise = new Promise((resolve) => {
        resolveAbort = resolve
    })
    const onAbort = () => {
        abortReason = signal?.reason
        resolveAbort({ kind: 'cancel' })
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    const childExitPromise = waitForExit(child).then((value) => ({ kind: 'exit', ...value }))
    let first = await Promise.race([childExitPromise, abortPromise])
    let postObservedZero = false
    const terminateTree = async (reason) => {
        lifecycle.push('mark-cancelling', 'stop-new-spawns')
        const beforeSignal = collectMembers(authority, { platform: process.platform, procRoot })
        if (beforeSignal?.status !== 'verified') {
            throw new Error(`physical execution member collection failed before termination: ${beforeSignal?.reason ?? 'unknown'}`)
        }
        recordMembers(inventory, beforeSignal.identities, authority, child.pid, process.platform, procRoot)
        if (beforeSignal.identities.length > 0) {
            lifecycle.push('forward-graceful-signal')
            signalGroup(-authority.groupId, 'SIGTERM')
            termination.push({ phase: 'graceful', signal: 'SIGTERM', reason, observedAt: new Date().toISOString() })
        }
        lifecycle.push('wait-grace-period')
        let observed = await stableMemberObservation({
            authority,
            inventory,
            leaderPid: child.pid,
            policy,
            collectMembers,
            platform: process.platform,
            procRoot,
            deadlineAt: Date.now() + policy.gracefulTerminationMs
        })
        if (observed.status !== 'empty') {
            lifecycle.push('force-kill-remaining-tree')
            const recheck = collectMembers(authority, { platform: process.platform, procRoot })
            if (recheck?.status !== 'verified') {
                throw new Error(`physical execution member collection failed before force kill: ${recheck?.reason ?? 'unknown'}`)
            }
            recordMembers(inventory, recheck.identities, authority, child.pid, process.platform, procRoot)
            if (recheck.identities.length > 0) {
                signalGroup(-authority.groupId, 'SIGKILL')
                termination.push({ phase: 'forced', signal: 'SIGKILL', reason, observedAt: new Date().toISOString() })
            }
            observed = await stableMemberObservation({
                authority,
                inventory,
                leaderPid: child.pid,
                policy,
                collectMembers,
                platform: process.platform,
                procRoot,
                deadlineAt: Date.now() + policy.forceTerminationMs
            })
        }
        lifecycle.push('post-observe-zero-members')
        if (observed.status !== 'empty') {
            throw new Error(`physical execution left ${observed.members.length} process-group member(s)`)
        }
        postObservedZero = true
    }

    let exit = first.kind === 'exit' ? first : null
    let failure = null
    try {
        if (first.kind === 'cancel') {
            await terminateTree('cancel')
            exit = await childExitPromise
            failure = abortReason instanceof Error ? abortReason : new Error('physical execution cancelled')
        } else {
            const postExit = await stableMemberObservation({
                authority,
                inventory,
                leaderPid: child.pid,
                policy: { ...policy, zeroMemberObservations: 1 },
                collectMembers,
                platform: process.platform,
                procRoot,
                deadlineAt: Date.now()
            })
            if (postExit.status !== 'empty') {
                await terminateTree('parent-exited-with-live-descendants')
                failure = new Error('physical execution parent exited before its process group became empty')
            } else if (exit.exitCode !== 0 || exit.signal) {
                postObservedZero = true
                failure = Object.assign(
                    new Error(`command failed (${exit.signal ? `signal ${exit.signal}` : `exit ${exit.exitCode}`}): ${command.join(' ')}`),
                    { exitCode: exit.exitCode, signal: exit.signal }
                )
            } else {
                postObservedZero = true
            }
        }
    } catch (error) {
        failure = error
    } finally {
        signal?.removeEventListener('abort', onAbort)
    }
    lifecycle.push(failure ? 'seal-cancelled-or-failed-receipt' : 'seal-completed-receipt')

    for (const record of inventory.values()) {
        if (record.role === 'direct-child') {
            record.exitCode = exit?.exitCode ?? null
            record.signal = exit?.signal ?? null
        } else if (termination.some((entry) => entry.phase === 'forced')) {
            record.signal = 'SIGKILL'
        } else if (termination.some((entry) => entry.phase === 'graceful')) {
            record.signal = 'SIGTERM'
        }
    }
    const evidence = {
        schema: physicalExecutionProcessTreeSchema,
        platform: process.platform,
        policy,
        authority,
        lifecycle,
        termination,
        postObservation: postObservedZero ? 'zero-members' : 'unverifiable',
        processInventory: [...inventory.values()].sort((left, right) => left.pid - right.pid),
        stdout: output.stdout,
        stderr: output.stderr
    }
    if (failure) {
        if (/collect|observe|left \d+ process-group/u.test(failure.message)) {
            evidence.residualBlock = writeResidualMarker(residualRoot, evidence, failure.message)
            child.stdout?.destroy()
            child.stderr?.destroy()
            child.unref()
        }
        throw physicalExecutionError(failure.message, evidence, failure)
    }
    return evidence
}

export async function runPhysicalExecution({
    command,
    cwd = process.cwd(),
    env = process.env,
    signal,
    platform = process.platform,
    policy = readPolicy(),
    residualRoot = defaultResidualRoot,
    windowsJobAdapter = null,
    collectIdentity = collectProcessIdentity,
    collectAuthority = collectProcessGroupOrJobIdentity,
    collectMembers = processGroupMemberIdentities,
    procRoot = '/proc',
    spawnProcess = spawn,
    signalGroup = process.kill.bind(process),
    stdout = process.stdout,
    stderr = process.stderr
}) {
    if (!Array.isArray(command) || command.length === 0) {
        throw new Error('physical execution requires a command')
    }
    const residuals = residualMarkerFiles(residualRoot)
    if (residuals.length > 0) {
        throw new Error(`physical execution preflight blocked by unresolved residual receipt: ${residuals[0]}`)
    }
    if (platform === 'win32') {
        if (windowsJobAdapter === false) {
            throw new Error('physical execution Windows Job Object adapter is unavailable')
        }
        const adapter = windowsJobAdapter ?? (await import('./physical-execution-windows-job-adapter.mjs'))
            .createPhysicalExecutionWindowsJobAdapter()
        if (typeof adapter?.run !== 'function') {
            throw new Error('physical execution Windows Job Object adapter is unavailable')
        }
        let evidence
        try {
            evidence = await adapter.run({ command, cwd, env, signal, policy, residualRoot, stdout, stderr })
        } catch (error) {
            const failureEvidence = error?.physicalExecution ?? {
                schema: physicalExecutionProcessTreeSchema,
                platform: 'win32',
                policy,
                authority: null,
                lifecycle: ['created', 'post-observation-unverifiable'],
                termination: [],
                postObservation: 'unverifiable',
                processInventory: [],
                stdout: '',
                stderr: ''
            }
            if (failureEvidence.postObservation !== 'zero-members') {
                failureEvidence.residualBlock = writeResidualMarker(
                    residualRoot,
                    failureEvidence,
                    error instanceof Error ? error.message : String(error)
                )
            }
            if (error && typeof error === 'object') error.physicalExecution = failureEvidence
            throw error
        }
        if (
            evidence?.schema !== physicalExecutionProcessTreeSchema ||
            evidence.platform !== 'win32' ||
            evidence.authority?.kind !== 'windows-job-object' ||
            evidence.authority.platform !== 'win32' ||
            !evidence.authority.jobName ||
            evidence.authority.killPolicy !== 'kill-on-close' ||
            evidence.postObservation !== 'zero-members' ||
            !Array.isArray(evidence.processInventory)
        ) {
            throw new Error('physical execution Windows Job Object adapter returned unverifiable evidence')
        }
        return evidence
    }
    if (
        platform === 'linux' &&
        procRoot === '/proc' &&
        spawnProcess === spawn &&
        collectIdentity === collectProcessIdentity &&
        collectAuthority === collectProcessGroupOrJobIdentity &&
        collectMembers === processGroupMemberIdentities
    ) {
        const adapter = (await import('./physical-execution-linux-systemd-adapter.mjs'))
            .createPhysicalExecutionLinuxSystemdAdapter()
        try {
            return await adapter.run({
                command,
                cwd,
                env,
                signal,
                policy,
                residualRoot,
                stdout,
                stderr,
                schema: physicalExecutionProcessTreeSchema
            })
        } catch (error) {
            if (error?.physicalExecution && error.physicalExecution.postObservation !== 'zero-members') {
                error.physicalExecution.residualBlock = writeResidualMarker(
                    residualRoot,
                    error.physicalExecution,
                    error instanceof Error ? error.message : String(error)
                )
            }
            throw error
        }
    }
    if (!['linux', 'darwin'].includes(platform)) {
        throw new Error(`physical execution platform is unsupported: ${platform}`)
    }
    return await startUnixExecution({
        command,
        cwd,
        env,
        signal,
        policy,
        residualRoot,
        collectIdentity,
        collectAuthority,
        collectMembers,
        procRoot,
        spawnProcess,
        signalGroup,
        stdout,
        stderr
    })
}

export function loadPhysicalExecutionProcessPolicy(file) {
    return readPolicy(file)
}
