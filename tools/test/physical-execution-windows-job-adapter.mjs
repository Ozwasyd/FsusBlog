import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectProcessIdentity } from './process-identity.mjs'
import { createPhysicalExecutionOutputTracker } from './physical-execution-process-tree.mjs'
import { queryWindowsJobProcessIds } from '../test-matrix/windows-job-members.mjs'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'physical-execution-windows-job.ps1')

function quoteWindowsCommandPart(value) {
    const text = String(value)
    if (!/[\s"&|<>^]/u.test(text)) return text
    return `"${text.replaceAll('"', '\\"')}"`
}

function cancellationError(signal) {
    if (signal?.reason instanceof Error) return signal.reason
    return Object.assign(new Error('physical execution cancelled'), { name: 'AbortError' })
}

function waitForFile(file, child, intervalMs, signal) {
    return new Promise((resolve, reject) => {
        const inspect = () => {
            if (fs.existsSync(file)) {
                resolve()
                return
            }
            if (signal?.aborted) {
                reject(cancellationError(signal))
                return
            }
            if (child.exitCode != null) {
                reject(new Error('Windows Job supervisor exited before its creation-bound handshake'))
                return
            }
            setTimeout(inspect, intervalMs)
        }
        inspect()
    })
}

function boundedChildExit(child, milliseconds) {
    if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true)
    return new Promise((resolve) => {
        let settled = false
        const finish = (terminal) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            child.off?.('exit', onExit)
            child.off?.('error', onExit)
            resolve(terminal)
        }
        const onExit = () => finish(true)
        const timer = setTimeout(() => finish(false), milliseconds)
        child.once('exit', onExit)
        child.once('error', onExit)
    })
}

export function createPhysicalExecutionWindowsJobAdapter({
    spawnProcess = spawn,
    queryMembers = queryWindowsJobProcessIds,
    collectIdentity = collectProcessIdentity
} = {}) {
    return {
        async run({ command, cwd, env, signal, policy, stdout, stderr, outputTracker = null }) {
            const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-physical-job-'))
            const jobName = `Local\\FsusBlogPhysicalExecution-${randomUUID()}`
            const readyFile = path.join(controlRoot, 'ready')
            const startFile = path.join(controlRoot, 'start')
            const assignedFile = path.join(controlRoot, 'assigned')
            const resumeFile = path.join(controlRoot, 'resume')
            const cancelFile = path.join(controlRoot, 'cancel')
            const resultFile = path.join(controlRoot, 'result.json')
            const commandLine = command.map(quoteWindowsCommandPart).join(' ')
            const commandBase64 = Buffer.from(commandLine, 'utf16le').toString('base64')
            const authority = {
                schema: 'fsusblog.process-group-or-job-identity.v1',
                platform: 'win32',
                kind: 'windows-job-object',
                jobName,
                killPolicy: 'kill-on-close'
            }
            const child = spawnProcess('powershell.exe', [
                '-NoProfile',
                '-ExecutionPolicy', 'Bypass',
                '-File', script,
                '-JobName', jobName,
                '-ReadyFile', readyFile,
                '-StartFile', startFile,
                '-AssignedFile', assignedFile,
                '-ResumeFile', resumeFile,
                '-CancelFile', cancelFile,
                '-ResultFile', resultFile,
                '-WorkingDirectory', cwd,
                '-CommandBase64', commandBase64,
                '-GracefulTerminationMs', String(policy.gracefulTerminationMs),
                '-ForceTerminationMs', String(policy.forceTerminationMs),
                '-ObservationIntervalMs', String(policy.observationIntervalMs),
                '-ZeroMemberObservations', String(policy.zeroMemberObservations)
            ], {
                cwd,
                env,
                stdio: ['inherit', 'pipe', 'pipe'],
                windowsHide: true
            })
            const executionOutput = outputTracker ??
                createPhysicalExecutionOutputTracker({ policy, stdout, stderr })
            executionOutput.attach(child.stdout, 'stdout')
            executionOutput.attach(child.stderr, 'stderr')
            let supervisorStopPromise = null
            const stopSupervisor = () => {
                if (supervisorStopPromise) return supervisorStopPromise
                supervisorStopPromise = (async () => {
                    if (child.exitCode != null || child.signalCode != null) return null
                    try {
                        child.kill()
                    } catch (error) {
                        return new Error(`Windows Job supervisor termination failed: ${error.message}`, {
                            cause: error
                        })
                    }
                    if (await boundedChildExit(child, policy.forceTerminationMs)) return null
                    try {
                        child.kill('SIGKILL')
                    } catch (error) {
                        return new Error(`Windows Job supervisor force termination failed: ${error.message}`, {
                            cause: error
                        })
                    }
                    return await boundedChildExit(child, policy.forceTerminationMs)
                        ? null
                        : new Error('Windows Job supervisor did not become terminal before the deadline')
                })()
                return supervisorStopPromise
            }
            const inventory = new Map()
            const observe = () => {
                const members = queryMembers(authority, { platform: 'win32' })
                if (members.status !== 'verified') throw new Error(members.reason)
                for (const pid of members.processIds) {
                    const identity = collectIdentity(pid, { platform: 'win32' })
                    if (identity.status !== 'verified') {
                        throw new Error(`Windows Job member ${pid} identity is unverifiable: ${identity.reason}`)
                    }
                    const key = `${pid}:${identity.processStartIdentity}`
                    if (!inventory.has(key)) {
                        inventory.set(key, {
                            pid,
                            startIdentity: identity.processStartIdentity,
                            ppid: null,
                            pgid: null,
                            jobId: jobName,
                            executableDigest: identity.executableDigest,
                            commandDigest: identity.commandDigest,
                            role: 'job-member',
                            observedAt: new Date().toISOString(),
                            exitCode: null,
                            signal: null
                        })
                    }
                }
            }
            const onAbort = () => fs.writeFileSync(cancelFile, 'cancel\n', { encoding: 'utf8', mode: 0o600 })
            let thrownError = null
            try {
                if (signal?.aborted) onAbort()
                else signal?.addEventListener('abort', onAbort, { once: true })
                await waitForFile(readyFile, child, policy.observationIntervalMs, signal)
                fs.writeFileSync(startFile, 'start\n', { encoding: 'utf8', mode: 0o600 })
                await waitForFile(assignedFile, child, policy.observationIntervalMs, signal)
                observe()
                fs.writeFileSync(resumeFile, 'resume\n', { encoding: 'utf8', mode: 0o600 })
                while (!fs.existsSync(resultFile) && child.exitCode == null) {
                    observe()
                    if (signal?.aborted) onAbort()
                    await new Promise((resolve) => setTimeout(resolve, policy.observationIntervalMs))
                }
                const exit = await new Promise((resolve, reject) => {
                    if (child.exitCode != null) {
                        resolve({ exitCode: child.exitCode, signal: child.signalCode })
                        return
                    }
                    child.once('error', reject)
                    child.once('exit', (exitCode, childSignal) => resolve({ exitCode, signal: childSignal }))
                })
                if (!fs.existsSync(resultFile)) {
                    throw new Error(`Windows Job supervisor failed without a result (exit ${exit.exitCode})`)
                }
                const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
                const outputEvidence = await executionOutput.close()
                for (const entry of inventory.values()) {
                    entry.role = entry.pid === Number(result.pid) ? 'direct-child' : 'descendant'
                    if (entry.role === 'direct-child') entry.exitCode = Number(result.exitCode)
                    if (result.forced) entry.signal = 'TerminateJobObject'
                }
                const evidence = {
                    schema: 'fsusblog.physical-execution-process-tree.v1',
                    platform: 'win32',
                    policy,
                    authority,
                    lifecycle: [
                        'created',
                        'running',
                        ...(result.cancelled
                            ? ['mark-cancelling', 'stop-new-spawns', 'forward-graceful-signal', 'wait-grace-period']
                            : []),
                        ...(result.forced ? ['force-kill-remaining-tree'] : []),
                        'bounded-pipe-close',
                        'post-observe-zero-members',
                        result.cancelled || result.parentResidual || result.exitCode !== 0
                            ? 'seal-cancelled-or-failed-receipt'
                            : 'seal-completed-receipt'
                    ],
                    termination: [
                        ...(result.cancelled
                            ? [{
                                phase: 'graceful',
                                signal: 'CTRL_BREAK',
                                reason: 'cancel',
                                observedAt: new Date().toISOString()
                            }]
                            : []),
                        ...(result.forced
                            ? [{
                                phase: 'forced',
                                signal: 'TerminateJobObject',
                                reason: result.cancelled
                                    ? 'cancel'
                                    : 'parent-exited-with-live-descendants',
                                observedAt: new Date().toISOString()
                            }]
                            : [])
                    ],
                    postObservation: result.empty ? 'zero-members' : 'unverifiable',
                    processInventory: [...inventory.values()],
                    ...outputEvidence
                }
                let primaryError = result.cancelled
                    ? signal?.reason instanceof Error
                        ? signal.reason
                        : Object.assign(new Error('physical execution cancelled'), { name: 'AbortError' })
                    : result.exitCode !== 0
                        ? Object.assign(
                            new Error(`command failed (exit ${result.exitCode}): ${command.join(' ')}`),
                            { exitCode: result.exitCode }
                        )
                        : result.parentResidual
                            ? new Error('physical execution parent exited before its Windows Job became empty')
                            : null
                const attachSecondary = (field, error) => {
                    if (!primaryError) {
                        primaryError = error
                        return
                    }
                    primaryError[field] ??= { name: error.name, message: error.message }
                }
                if (!result.empty) {
                    attachSecondary(
                        'physicalExecutionContainmentError',
                        new Error('Windows Job post-observe did not prove zero members')
                    )
                }
                if (!outputEvidence.logComplete) {
                    attachSecondary(
                        'physicalExecutionLogError',
                        new Error(`physical execution log is incomplete: ${outputEvidence.logTruncationReason}`)
                    )
                }
                if (primaryError) {
                    primaryError.physicalExecution = evidence
                    throw primaryError
                }
                return evidence
            } catch (error) {
                thrownError = error instanceof Error ? error : new Error(String(error))
                const terminalError = await stopSupervisor()
                const outputEvidence = await executionOutput.close()
                if (terminalError) {
                    thrownError.physicalExecutionTerminalError ??= {
                        name: terminalError.name,
                        message: terminalError.message
                    }
                }
                thrownError.physicalExecution ??= {
                    schema: 'fsusblog.physical-execution-process-tree.v1',
                    platform: 'win32',
                    policy,
                    authority: {
                        ...authority,
                        established: fs.existsSync(assignedFile)
                    },
                    lifecycle: [
                        'created',
                        ...(signal?.aborted
                            ? ['mark-cancelling', 'stop-new-spawns']
                            : []),
                        'bounded-pipe-close',
                        'post-observation-unverifiable',
                        'seal-cancelled-or-failed-receipt'
                    ],
                    termination: [],
                    postObservation: 'unverifiable',
                    processInventory: [...inventory.values()],
                    ...outputEvidence
                }
                throw thrownError
            } finally {
                signal?.removeEventListener('abort', onAbort)
                const terminalError = await stopSupervisor()
                if (terminalError && thrownError) {
                    thrownError.physicalExecutionTerminalError ??= {
                        name: terminalError.name,
                        message: terminalError.message
                    }
                } else if (terminalError) {
                    throw terminalError
                }
                fs.rmSync(controlRoot, { recursive: true, force: true })
            }
        }
    }
}
