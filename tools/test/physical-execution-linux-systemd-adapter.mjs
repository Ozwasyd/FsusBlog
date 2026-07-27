import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { collectProcessIdentity } from './process-identity.mjs'

const bootstrap = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'physical-execution-linux-systemd-bootstrap.mjs'
)

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function systemctl(args) {
  return spawnSync('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
}

function requireSystemdAuthority() {
  const result = systemctl(['show-environment'])
  if (result.status !== 0) {
    throw new Error(
      `physical execution Linux cgroup authority is unavailable: ${
        String(result.stderr ?? result.stdout ?? '').trim() || `exit ${result.status}`
      }`
    )
  }
}

function unitProperties(unitName) {
  const result = systemctl([
    'show',
    unitName,
    '--property=LoadState',
    '--property=ActiveState',
    '--property=ControlGroup',
    '--property=MainPID',
    '--no-pager'
  ])
  if (result.status !== 0) {
    return { status: 'unverifiable', reason: String(result.stderr ?? result.stdout ?? '').trim() }
  }
  const values = Object.fromEntries(String(result.stdout).trim().split(/\r?\n/u)
    .map((line) => line.split(/=(.*)/su).slice(0, 2)))
  return { status: 'verified', values }
}

function cgroupMemberPids(controlGroup) {
  if (!controlGroup) return []
  const file = path.join('/sys/fs/cgroup', controlGroup.replace(/^\/+/u, ''), 'cgroup.procs')
  try {
    return fs.readFileSync(file, 'utf8').trim().split(/\s+/u)
      .filter(Boolean)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0)
      .sort((left, right) => left - right)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function waitForFile(file, child, intervalMs) {
  return new Promise((resolve, reject) => {
    const inspect = () => {
      if (fs.existsSync(file)) {
        resolve()
        return
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(new Error('physical execution systemd supervisor exited before its handshake completed'))
        return
      }
      setTimeout(inspect, intervalMs)
    }
    inspect()
  })
}

async function observeStableEmpty({
  unitName,
  controlGroup,
  supervisorPid,
  inventory,
  policy,
  deadlineAt
}) {
  let zeroObservations = 0
  while (Date.now() <= deadlineAt) {
    const properties = unitProperties(unitName)
    const pids = cgroupMemberPids(controlGroup).filter((pid) => pid !== supervisorPid)
    for (const pid of pids) {
      const identity = collectProcessIdentity(pid)
      if (identity.status !== 'verified') {
        throw new Error(`physical execution cgroup member ${pid} identity is unverifiable: ${identity.reason}`)
      }
      inventory.set(`${pid}:${identity.processStartIdentity}`, identity)
    }
    const inactive = properties.status === 'verified' &&
      ['inactive', 'failed'].includes(properties.values.ActiveState)
    if (pids.length === 0 && (inactive || properties.values?.LoadState === 'not-found')) {
      zeroObservations += 1
      if (zeroObservations >= policy.zeroMemberObservations) return true
    } else {
      zeroObservations = 0
    }
    await delay(policy.observationIntervalMs)
  }
  return false
}

export function createPhysicalExecutionLinuxSystemdAdapter({
  spawnProcess = spawn
} = {}) {
  return {
    async run({
      command,
      cwd,
      env,
      signal,
      policy,
      stdout,
      stderr,
      schema
    }) {
      requireSystemdAuthority()
      const authorityId = randomUUID()
      const unitName = `fsusblog-physical-${authorityId.replaceAll('-', '')}`
      const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-physical-systemd-'))
      const encodedCommand = Buffer.from(JSON.stringify(command), 'utf8').toString('base64url')
      const readyFile = path.join(controlRoot, 'ready')
      const startFile = path.join(controlRoot, 'start')
      const childFile = path.join(controlRoot, 'child.json')
      const resultFile = path.join(controlRoot, 'result.json')
      const finalizeFile = path.join(controlRoot, 'finalize')
      const setEnvironment = Object.entries(env).map(([key, value]) => {
        const normalized = String(value)
        if (normalized.includes('\0') || normalized.includes('\n')) {
          throw new Error(`physical execution cannot encode environment variable ${key}`)
        }
        return `--setenv=${key}=${normalized}`
      })
      const child = spawnProcess('systemd-run', [
        '--user',
        '--quiet',
        '--wait',
        '--pipe',
        '--collect',
        '--service-type=exec',
        '--property=KillMode=control-group',
        '--property=ExitType=cgroup',
        `--working-directory=${cwd}`,
        `--unit=${unitName}`,
        ...setEnvironment,
        process.execPath,
        bootstrap,
        controlRoot,
        encodedCommand
      ], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
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
      const lifecycle = ['created']
      const termination = []
      let properties
      let supervisorPid
      let controlGroup
      let commandPid
      const finishChild = () => new Promise((resolve, reject) => {
        if (child.exitCode !== null) {
          resolve({ exitCode: child.exitCode, signal: child.signalCode })
          return
        }
        child.once('error', reject)
        child.once('exit', (exitCode, childSignal) => resolve({ exitCode, signal: childSignal }))
      })
      const terminate = async (reason) => {
        lifecycle.push('mark-cancelling', 'stop-new-spawns', 'forward-graceful-signal')
        for (const pid of cgroupMemberPids(controlGroup)) {
          const identity = collectProcessIdentity(pid)
          if (identity.status !== 'verified') {
            throw new Error(`physical execution cgroup member ${pid} identity is unverifiable: ${identity.reason}`)
          }
          inventory.set(`${pid}:${identity.processStartIdentity}`, identity)
        }
        systemctl(['kill', '--kill-who=all', '--signal=SIGTERM', unitName])
        termination.push({ phase: 'graceful', signal: 'SIGTERM', reason, observedAt: new Date().toISOString() })
        lifecycle.push('wait-grace-period')
        if (!await observeStableEmpty({
          unitName,
          controlGroup,
          supervisorPid,
          inventory,
          policy,
          deadlineAt: Date.now() + policy.gracefulTerminationMs
        })) {
          lifecycle.push('force-kill-remaining-tree')
          systemctl(['kill', '--kill-who=all', '--signal=SIGKILL', unitName])
          systemctl(['stop', unitName])
          termination.push({ phase: 'forced', signal: 'SIGKILL', reason, observedAt: new Date().toISOString() })
        }
        lifecycle.push('post-observe-zero-members')
        return await observeStableEmpty({
          unitName,
          controlGroup,
          supervisorPid,
          inventory,
          policy,
          deadlineAt: Date.now() + policy.forceTerminationMs
        })
      }
      try {
        await waitForFile(readyFile, child, policy.observationIntervalMs)
        properties = unitProperties(unitName)
        if (properties.status !== 'verified' || !properties.values.ControlGroup) {
          throw new Error(
            `physical execution systemd authority is unverifiable: ${
              properties.reason ?? `missing cgroup ${JSON.stringify(properties.values)}`
            }`
          )
        }
        supervisorPid = Number(fs.readFileSync(readyFile, 'utf8').trim())
        controlGroup = properties.values.ControlGroup
        const supervisorIdentity = collectProcessIdentity(supervisorPid)
        if (supervisorIdentity.status !== 'verified') {
          throw new Error(`physical execution supervisor identity is unverifiable: ${supervisorIdentity.reason}`)
        }
        inventory.set(`${supervisorPid}:${supervisorIdentity.processStartIdentity}`, supervisorIdentity)
        fs.writeFileSync(startFile, 'start\n', { mode: 0o600 })
        await waitForFile(childFile, child, policy.observationIntervalMs)
        commandPid = Number(JSON.parse(fs.readFileSync(childFile, 'utf8')).pid)
        const commandIdentity = collectProcessIdentity(commandPid)
        if (commandIdentity.status !== 'verified') {
          throw new Error(`physical execution command identity is unverifiable: ${commandIdentity.reason}`)
        }
        inventory.set(`${commandPid}:${commandIdentity.processStartIdentity}`, commandIdentity)
        lifecycle.push('running')
        let abortResolve
        const abortPromise = new Promise((resolve) => { abortResolve = resolve })
        const onAbort = () => abortResolve({ kind: 'cancel' })
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })
        const resultPromise = waitForFile(resultFile, child, policy.observationIntervalMs)
          .then(() => ({ kind: 'result', value: JSON.parse(fs.readFileSync(resultFile, 'utf8')) }))
        const first = await Promise.race([abortPromise, resultPromise])
        signal?.removeEventListener('abort', onAbort)
        let failure = null
        if (first.kind === 'cancel') {
          if (!await terminate('cancel')) failure = new Error('physical execution cgroup is not empty')
          else failure = signal?.reason instanceof Error ? signal.reason : new Error('physical execution cancelled')
        } else {
          const members = cgroupMemberPids(controlGroup)
            .filter((pid) => pid !== supervisorPid && pid !== commandPid)
          if (members.length > 0) {
            if (!await terminate('parent-exited-with-live-descendants')) {
              failure = new Error('physical execution cgroup is not empty')
            } else {
              failure = new Error('physical execution parent exited before its process group became empty (cgroup still live)')
            }
          } else {
            fs.writeFileSync(finalizeFile, 'finalize\n', { mode: 0o600 })
            await finishChild()
            lifecycle.push('post-observe-zero-members')
            if (!await observeStableEmpty({
              unitName,
              controlGroup,
              supervisorPid,
              inventory,
              policy,
              deadlineAt: Date.now() + policy.forceTerminationMs
            })) {
              failure = new Error('physical execution cgroup post-observation failed')
            } else if (first.value.exitCode !== 0 || first.value.signal) {
              failure = Object.assign(
                new Error(`command failed (${first.value.signal ? `signal ${first.value.signal}` : `exit ${first.value.exitCode}`}): ${command.join(' ')}`),
                { exitCode: first.value.exitCode, signal: first.value.signal }
              )
            }
          }
        }
        lifecycle.push(failure ? 'seal-cancelled-or-failed-receipt' : 'seal-completed-receipt')
        const authority = {
          schema: 'fsusblog.physical-execution-authority.v1',
          platform: 'linux',
          kind: 'linux-cgroup-process-group',
          authorityId,
          unitName,
          controlGroup,
          supervisorPid,
          killPolicy: 'control-group'
        }
        const evidence = {
          schema,
          platform: 'linux',
          policy,
          authority,
          lifecycle,
          termination,
          postObservation: failure && !lifecycle.includes('post-observe-zero-members')
            ? 'unverifiable'
            : 'zero-members',
          processInventory: [...inventory.values()].map((identity) => ({
            pid: identity.pid,
            startIdentity: identity.processStartIdentity,
            ppid: null,
            pgid: null,
            jobId: unitName,
            executableDigest: identity.executableDigest,
            commandDigest: identity.commandDigest,
            role: identity.pid === commandPid
              ? 'direct-child'
              : identity.pid === supervisorPid
                ? 'containment-supervisor'
                : 'descendant',
            observedAt: new Date().toISOString(),
            exitCode: identity.pid === commandPid && first.kind === 'result'
              ? first.value.exitCode
              : null,
            signal: termination.some((entry) => entry.phase === 'forced')
              ? 'SIGKILL'
              : termination.some((entry) => entry.phase === 'graceful')
                ? 'SIGTERM'
                : null
          })),
          stdout: capturedStdout,
          stderr: capturedStderr
        }
        if (failure) {
          failure.physicalExecution = evidence
          throw failure
        }
        return evidence
      } catch (error) {
        if (!error.physicalExecution) {
          const authority = {
            schema: 'fsusblog.physical-execution-authority.v1',
            platform: 'linux',
            kind: 'linux-cgroup-process-group',
            authorityId,
            unitName,
            controlGroup: controlGroup ?? null,
            supervisorPid: supervisorPid ?? null,
            killPolicy: 'control-group'
          }
          error.physicalExecution = {
            schema,
            platform: 'linux',
            policy,
            authority,
            lifecycle: [...lifecycle, 'post-observation-unverifiable', 'seal-cancelled-or-failed-receipt'],
            termination,
            postObservation: 'unverifiable',
            processInventory: [...inventory.values()].map((identity) => ({
              pid: identity.pid,
              startIdentity: identity.processStartIdentity,
              ppid: null,
              pgid: null,
              jobId: unitName,
              executableDigest: identity.executableDigest,
              commandDigest: identity.commandDigest,
              role: identity.pid === commandPid
                ? 'direct-child'
                : identity.pid === supervisorPid
                  ? 'containment-supervisor'
                  : 'descendant',
              observedAt: new Date().toISOString(),
              exitCode: null,
              signal: null
            })),
            stdout: capturedStdout,
            stderr: capturedStderr
          }
        }
        throw error
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          systemctl(['kill', '--kill-who=all', '--signal=SIGKILL', unitName])
          systemctl(['stop', unitName])
          child.kill('SIGKILL')
          await finishChild().catch(() => {})
        }
        fs.rmSync(controlRoot, { recursive: true, force: true })
      }
    }
  }
}
