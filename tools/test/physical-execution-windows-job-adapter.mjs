import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectProcessIdentity } from './process-identity.mjs'
import { queryWindowsJobProcessIds } from '../test-matrix/windows-job-members.mjs'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'physical-execution-windows-job.ps1')

function quoteWindowsCommandPart(value) {
    const text = String(value)
    if (!/[\s"&|<>^]/u.test(text)) return text
    return `"${text.replaceAll('"', '\\"')}"`
}

function waitForFile(file, child, intervalMs) {
    return new Promise((resolve, reject) => {
        const inspect = () => {
            if (fs.existsSync(file)) {
                resolve()
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

export function createPhysicalExecutionWindowsJobAdapter({
    spawnProcess = spawn,
    queryMembers = queryWindowsJobProcessIds,
    collectIdentity = collectProcessIdentity
} = {}) {
    return {
        async run({ command, cwd, env, signal, policy, stdout, stderr }) {
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
            let capturedStdout = ''
            let capturedStderr = ''
            child.stdout.on('data', (chunk) => {
                capturedStdout += chunk.toString()
                stdout?.write(chunk)
            })
            child.stderr.on('data', (chunk) => {
                capturedStderr += chunk.toString()
                stderr?.write(chunk)
            })
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
            try {
                if (signal?.aborted) onAbort()
                else signal?.addEventListener('abort', onAbort, { once: true })
                await waitForFile(readyFile, child, policy.observationIntervalMs)
                fs.writeFileSync(startFile, 'start\n', { encoding: 'utf8', mode: 0o600 })
                await waitForFile(assignedFile, child, policy.observationIntervalMs)
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
                    lifecycle: ['created', 'running', ...(result.cancelled ? ['mark-cancelling', 'stop-new-spawns', 'forward-graceful-signal', 'wait-grace-period'] : []), ...(result.forced ? ['force-kill-remaining-tree'] : []), 'post-observe-zero-members', result.cancelled || result.parentResidual || result.exitCode !== 0 ? 'seal-cancelled-or-failed-receipt' : 'seal-completed-receipt'],
                    termination: result.cancelled ? [{ phase: result.forced ? 'forced' : 'graceful', signal: result.forced ? 'TerminateJobObject' : 'CTRL_BREAK', reason: 'cancel', observedAt: new Date().toISOString() }] : [],
                    postObservation: result.empty ? 'zero-members' : 'unverifiable',
                    processInventory: [...inventory.values()],
                    stdout: capturedStdout,
                    stderr: capturedStderr
                }
                if (!result.empty) throw Object.assign(new Error('Windows Job post-observe did not prove zero members'), { physicalExecution: evidence })
                if (result.cancelled) {
                    const error = signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('physical execution cancelled'), { name: 'AbortError' })
                    error.physicalExecution = evidence
                    throw error
                }
                if (result.parentResidual) throw Object.assign(new Error('physical execution parent exited before its Windows Job became empty'), { physicalExecution: evidence })
                if (result.exitCode !== 0) throw Object.assign(new Error(`command failed (exit ${result.exitCode}): ${command.join(' ')}`), { exitCode: result.exitCode, physicalExecution: evidence })
                return evidence
            } finally {
                signal?.removeEventListener('abort', onAbort)
                if (child.exitCode == null && child.signalCode == null) {
                    child.kill()
                    await new Promise((resolve) => child.once('exit', resolve))
                }
                fs.rmSync(controlRoot, { recursive: true, force: true })
            }
        }
    }
}
