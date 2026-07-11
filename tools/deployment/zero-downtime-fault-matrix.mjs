#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'

const schema = 'fsusblog.zero-downtime-fault-matrix.v1'
const planSchema = 'fsusblog.zero-downtime-fault-plan.v1'
const requiredCases = Object.freeze([
  'manifest-digest-mismatch',
  'capacity-insufficient',
  'expand-failure',
  'candidate-readiness',
  'asset-hash-mismatch',
  'gateway-reload-failure',
  'active-fence-failure',
  'public-probe-failure',
  'drain-timeout',
  'source-stop-failure',
  'host-interruption',
  'redis-disconnect',
  'postgres-disconnect'
])
const allowedExecutables = new Set(['bash', 'curl', 'docker', 'dotnet', 'node'])

try {
  const options = parseArgs(process.argv.slice(2))
  const plan = readPlan(options.plan)
  const results = []
  for (const definition of plan.cases) {
    results.push(await runCase(definition, plan, options))
  }
  const report = {
    schema,
    status: results.every(item => item.status === 'pass') ? 'pass' : 'fail',
    rolloutId: plan.rolloutId,
    target: plan.target,
    caseCount: results.length,
    cases: results,
    generatedAtUtc: new Date().toISOString(),
    errors: results.filter(item => item.status !== 'pass').flatMap(item => item.errors.map(error => `${item.case}: ${error}`))
  }
  writeJsonAtomic(options.out, report)
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (report.status !== 'pass') process.exitCode = 1
} catch (error) {
  process.stderr.write(`[zero-downtime-fault-matrix] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

async function runCase(definition, plan, options) {
  const startedAtUtc = new Date().toISOString()
  const timeline = []
  const errors = []
  const caseDirectory = path.join(options.workDir, definition.case)
  fs.rmSync(caseDirectory, { recursive: true, force: true })
  fs.mkdirSync(caseDirectory, { recursive: true, mode: 0o700 })
  let rolloutProcess = null
  let injectionRecovery = null
  let before = null
  let after = null
  let rolloutExit = null
  try {
    await runCommandList(definition.setup, plan, caseDirectory, timeline, 'setup')
    before = observe(plan, definition)
    rolloutProcess = startCommand(definition.rollout, plan, caseDirectory, 'rollout')
    timeline.push(event('rollout-started', { pid: rolloutProcess.child.pid }))
    if (definition.waitFor) {
      await waitForRollout(definition.waitFor, definition.rolloutState, definition.timeoutMs)
      timeline.push(event('fault-stage-reached', definition.waitFor))
    }
    injectionRecovery = await inject(definition.inject, rolloutProcess.child, caseDirectory)
    timeline.push(event('fault-injected', { action: definition.inject.action }))
    rolloutExit = await rolloutProcess.completed(definition.timeoutMs)
    timeline.push(event('rollout-exited', rolloutExit))
    if (Array.isArray(definition.recover)) {
      await runCommandList(definition.recover, plan, caseDirectory, timeline, 'recover')
    }
    if (injectionRecovery) await injectionRecovery()
    injectionRecovery = null
    after = observe(plan, definition)
    evaluate(definition, before, after, rolloutExit, errors)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  } finally {
    if (rolloutProcess?.child && rolloutExit === null) {
      rolloutProcess.child.kill('SIGKILL')
      await rolloutProcess.completed(10_000).catch(() => {})
    }
    if (injectionRecovery) await injectionRecovery().catch(() => {})
    try {
      await runCommandList(definition.teardown, plan, caseDirectory, timeline, 'teardown')
    } catch (error) {
      errors.push(`teardown: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    case: definition.case,
    status: errors.length === 0 ? 'pass' : 'fail',
    automated: true,
    actionStatus: 'executed',
    injection: definition.inject.action,
    expected: definition.expect,
    before,
    after,
    rolloutExit,
    timeline,
    startedAtUtc,
    completedAtUtc: new Date().toISOString(),
    errors
  }
}

async function inject(injection, rolloutChild, workDirectory) {
  switch (injection.action) {
    case 'none':
      return null
    case 'signal-process': {
      const signal = injection.signal ?? 'SIGKILL'
      rolloutChild.kill(signal)
      return null
    }
    case 'docker-stop': {
      checkedSpawn('docker', ['stop', '--time', '1', safeName(injection.container)])
      return timedRecovery(async () => { checkedSpawn('docker', ['start', safeName(injection.container)]) }, injection.restoreAfterMs)
    }
    case 'docker-pause': {
      checkedSpawn('docker', ['pause', safeName(injection.container)])
      return timedRecovery(async () => { checkedSpawn('docker', ['unpause', safeName(injection.container)]) }, injection.restoreAfterMs)
    }
    case 'docker-network-disconnect': {
      const network = safeName(injection.network)
      const container = safeName(injection.container)
      checkedSpawn('docker', ['network', 'disconnect', network, container])
      return timedRecovery(async () => { checkedSpawn('docker', ['network', 'connect', network, container]) }, injection.restoreAfterMs)
    }
    case 'replace-file': {
      const target = safeCasePath(injection.target, workDirectory, injection.allowOutsideWorkDir === true)
      const replacement = path.resolve(injection.replacement)
      const backup = `${target}.fault-backup-${process.pid}`
      fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL)
      fs.copyFileSync(replacement, target)
      return async () => {
        fs.copyFileSync(backup, target)
        fs.rmSync(backup, { force: true })
      }
    }
    case 'chmod': {
      const target = safeCasePath(injection.target, workDirectory, injection.allowOutsideWorkDir === true)
      const before = fs.statSync(target).mode & 0o777
      const mode = Number.parseInt(String(injection.mode), 8)
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('chmod injection mode is invalid')
      fs.chmodSync(target, mode)
      return async () => { fs.chmodSync(target, before) }
    }
    case 'hold-http': {
      const url = new URL(injection.url)
      if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('hold-http must target local rehearsal')
      const child = spawn('curl', ['-fsS', '--no-buffer', '--max-time', String(injection.maxSeconds ?? 120), url.toString()], { stdio: 'ignore' })
      return async () => { child.kill('SIGTERM') }
    }
    default:
      throw new Error(`unsupported fault injection action: ${injection.action}`)
  }
}

function timedRecovery(action, restoreAfterMs) {
  let completed = false
  let promise = null
  const run = async () => {
    if (completed) return
    if (!promise) promise = Promise.resolve().then(action).finally(() => { completed = true })
    await promise
  }
  const delayMs = Number(restoreAfterMs ?? 0)
  if (Number.isFinite(delayMs) && delayMs > 0) setTimeout(() => { void run() }, delayMs).unref?.()
  return run
}

function evaluate(definition, before, after, rolloutExit, errors) {
  const expected = definition.expect
  if (expected.rolloutExit === 'nonzero' && rolloutExit?.code === 0) errors.push('rollout unexpectedly succeeded')
  if (expected.rolloutExit === 'zero' && rolloutExit?.code !== 0) errors.push(`rollout exited ${rolloutExit?.code ?? 'unknown'}`)
  if (expected.activeSlot === 'unchanged' && after.slotState?.activeSlot !== before.slotState?.activeSlot) errors.push('active slot changed')
  if (expected.activeSlot === 'source' && after.slotState?.activeSlot !== before.slotState?.activeSlot) errors.push('source slot was not restored')
  if (expected.activeSlot === 'target' && after.slotState?.activeSlot !== before.rolloutState?.target?.slot) errors.push('target slot is not active')
  if (expected.publicRelease === 'unchanged' && after.public?.releaseId !== before.public?.releaseId) errors.push('public release changed')
  if (expected.publicRelease === 'source' && after.public?.releaseId !== before.public?.releaseId) errors.push('public source was not preserved/restored')
  if (expected.publicRelease === 'target' && after.public?.releaseId !== before.rolloutState?.target?.releaseId) errors.push('public target is not serving')
  if (expected.recoveryAction) {
    const current = after.rolloutState?.recovery?.action
    const last = after.rolloutState?.recoveries?.at(-1)?.action
    if (current !== expected.recoveryAction && last !== expected.recoveryAction) errors.push(`recovery action mismatch: ${current ?? last ?? 'missing'}`)
  }
  if (expected.rolloutStatus && after.rolloutState?.status !== expected.rolloutStatus) errors.push(`rollout status is ${after.rolloutState?.status ?? 'missing'}`)
  if (expected.sourceContainerRetained === true && after.sourceContainer?.exists !== true) errors.push('source container was not retained')
  if (expected.sourceHealthy === true && after.sourceContainer?.healthy !== true) errors.push('source container is not healthy')
  if (expected.targetHealthy === true && after.targetContainer?.healthy !== true) errors.push('target container is not healthy')
}

function observe(plan, definition) {
  const slotState = readOptionalJson(definition.slotState)
  const rolloutState = readOptionalJson(definition.rolloutState)
  return {
    observedAtUtc: new Date().toISOString(),
    slotState,
    rolloutState,
    public: publicIdentity(definition.publicUrl),
    sourceContainer: containerStatus(plan.sourceContainer),
    targetContainer: containerStatus(plan.targetContainer)
  }
}

function publicIdentity(urlValue) {
  const result = spawnSync('curl', ['-sS', '--max-time', '5', '-D', '-', '-o', '/dev/null', urlValue], { encoding: 'utf8', timeout: 10_000 })
  if (result.status !== 0) return { reachable: false, releaseId: null, slot: null, error: clean(result) }
  return {
    reachable: true,
    releaseId: header(result.stdout, 'x-fsus-release-id'),
    slot: header(result.stdout, 'x-fsus-release-slot'),
    error: null
  }
}

function containerStatus(container) {
  const result = spawnSync('docker', ['inspect', safeName(container), '--format', '{{json .State}}'], { encoding: 'utf8', timeout: 10_000 })
  if (result.status !== 0) return { exists: false, running: false, healthy: false }
  const state = JSON.parse(result.stdout.trim())
  return { exists: true, running: state.Running === true, healthy: state.Running === true && (!state.Health || state.Health.Status === 'healthy') }
}

async function waitForRollout(waitFor, stateFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = readOptionalJson(stateFile)
    if (state && (!waitFor.stage || state.currentStage === waitFor.stage || state.completedStages?.includes(waitFor.stage))
      && (!waitFor.status || state.status === waitFor.status)) return
    await delay(50)
  }
  throw new Error(`timeout waiting for rollout ${waitFor.stage ?? waitFor.status}`)
}

async function runCommandList(commands = [], plan, directory, timeline, phase) {
  for (const command of commands ?? []) {
    const running = startCommand(command, plan, directory, phase)
    const result = await running.completed(command.timeoutMs ?? 300_000)
    timeline.push(event(`${phase}-command`, { commandId: command.id, exitCode: result.code }))
    if (result.code !== 0) throw new Error(`${phase} command failed: ${command.id} (${result.code})`)
  }
}

function startCommand(spec, plan, directory, phase) {
  validateCommand(spec)
  const stdout = fs.openSync(path.join(directory, `${phase}-${spec.id}.stdout`), 'a', 0o600)
  const stderr = fs.openSync(path.join(directory, `${phase}-${spec.id}.stderr`), 'a', 0o600)
  const child = spawn(spec.executable, spec.args ?? [], {
    cwd: spec.cwd ? path.resolve(spec.cwd) : process.cwd(),
    env: { ...process.env, ...plan.environment, ...spec.environment },
    stdio: ['ignore', stdout, stderr],
    detached: false
  })
  const completed = timeoutMs => waitChild(child, timeoutMs).finally(() => {
    fs.closeSync(stdout)
    fs.closeSync(stderr)
  })
  return { child, completed }
}

function validateCommand(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('command specification is invalid')
  if (!/^[a-z][a-z0-9._-]{2,63}$/u.test(String(spec.id ?? ''))) throw new Error('command id is invalid')
  const executable = path.basename(String(spec.executable ?? ''))
  if (!allowedExecutables.has(executable) && !path.resolve(spec.executable).startsWith(`${process.cwd()}${path.sep}`)) {
    throw new Error(`command executable is outside the repository allowlist: ${spec.executable}`)
  }
  if (!Array.isArray(spec.args) || spec.args.some(value => typeof value !== 'string')) throw new Error(`${spec.id}: args must be strings`)
}

function waitChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false
    const timeout = setTimeout(() => {
      if (done) return
      child.kill('SIGKILL')
      reject(new Error(`process timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('error', error => {
      done = true
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      done = true
      clearTimeout(timeout)
      resolve({ code: code ?? (signal ? 128 : 1), signal: signal ?? null })
    })
  })
}

function readPlan(file) {
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (plan.schema !== planSchema) throw new Error(`plan schema must be ${planSchema}`)
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/u.test(String(plan.rolloutId ?? ''))) throw new Error('plan rolloutId is invalid')
  if (!Array.isArray(plan.cases) || plan.cases.map(item => item.case).join('\n') !== requiredCases.join('\n')) {
    throw new Error(`fault plan must contain the exact ordered case set: ${requiredCases.join(', ')}`)
  }
  for (const definition of plan.cases) validateDefinition(definition)
  return plan
}

function validateDefinition(definition) {
  if (!requiredCases.includes(definition.case)) throw new Error(`unknown fault case: ${definition.case}`)
  if (!definition.rolloutState || !definition.slotState || !definition.publicUrl) throw new Error(`${definition.case}: state/public paths are required`)
  if (!definition.inject?.action || !definition.expect) throw new Error(`${definition.case}: injection and expectation are required`)
  definition.timeoutMs = Number(definition.timeoutMs ?? 300_000)
  if (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 1_000 || definition.timeoutMs > 1_800_000) throw new Error(`${definition.case}: timeout is invalid`)
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${name ?? '<end>'}`)
    parsed[name.slice(2)] = value
  }
  if (!parsed.plan || !parsed.out) throw new Error('--plan and --out are required')
  return {
    plan: path.resolve(parsed.plan),
    out: path.resolve(parsed.out),
    workDir: path.resolve(parsed['work-dir'] ?? path.join(process.cwd(), '.tmp/zero-downtime-fault-matrix'))
  }
}

function readOptionalJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, file)
}

function safeCasePath(value, workDirectory, allowOutside) {
  const resolved = path.resolve(value)
  if (!allowOutside && !resolved.startsWith(`${workDirectory}${path.sep}`)) throw new Error(`fault path escapes case directory: ${resolved}`)
  return resolved
}

function safeName(value) {
  const result = String(value ?? '')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(result)) throw new Error(`unsafe Docker identifier: ${result}`)
  return result
}

function checkedSpawn(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 60_000 })
  if (result.status !== 0) throw new Error(`${executable} ${args[0] ?? ''} failed: ${clean(result)}`)
}

function header(text, name) {
  const match = text.match(new RegExp(`^${name}:\\s*(.+?)\\r?$`, 'imu'))
  return match?.[1]?.trim() ?? null
}

function clean(result) {
  return String(result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 500)
}

function event(name, detail = {}) {
  return { event: name, observedAtUtc: new Date().toISOString(), ...detail }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
