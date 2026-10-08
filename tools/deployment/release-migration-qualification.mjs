#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { readReleaseManifest } from '../release/release-manifest.mjs'
import { readRolloutState } from './release-rollout-lib.mjs'

export const MIGRATION_QUALIFICATION_SCENARIO_SCHEMA = 'fsusblog.release-migration-qualification-scenario.v1'
export const MIGRATION_QUALIFICATION_EVIDENCE_SCHEMA = 'fsusblog.release-migration-qualification-evidence.v1'

export const REQUIRED_MIGRATION_CASES = Object.freeze([
  ['expand-with-old-active', [['source-before-expand', 'http'], ['expand', 'command'], ['source-after-expand-read', 'http']]],
  ['blue-green-concurrent-read-write', [['source-read', 'http'], ['source-write', 'http'], ['target-read', 'http'], ['target-write', 'http']]],
  ['backfill-checkpoint-resume', [['backfill-start', 'command'], ['checkpoint-paused', 'command'], ['backfill-resume', 'command'], ['checkpoint-completed', 'command']]],
  ['missing-expand-candidate-not-ready', [
    ['prepare-missing-expand', 'command'],
    ['candidate-check', 'command'],
    ['candidate-readiness', 'http'],
    ['expand-recover', 'command']
  ]],
  ['contract-rollback-window-rejected', [['contract-rejected', 'command']]],
  ['contract-applied-non-rollback-compatible', [['contract-apply', 'command'], ['rollback-marker', 'command']]],
  ['advisory-lock-timeout', [['advisory-lock-timeout', 'command']]],
  ['database-disconnect', [['database-disconnect', 'command']]],
  ['partial-failure-recovery', [['partial-failure', 'command'], ['checkpoint-failed', 'command'], ['partial-recovery', 'command'], ['checkpoint-recovered', 'command']]],
  ['history-integrity-rejected', [['history-check', 'command']]]
])

class QualificationError extends Error {
  constructor(errors) {
    const values = unique(errors.map(String).filter(Boolean))
    super(values.join('; ') || 'migration qualification failed')
    this.name = 'QualificationError'
    this.errors = values
  }
}

export async function runMigrationQualification(options, dependencies = {}) {
  const deps = { spawn, fetch, now: () => new Date(), ...dependencies }
  if (fs.existsSync(options.out)) throw new QualificationError([`output already exists: ${options.out}`])
  if (fs.existsSync(options.workDir)) throw new QualificationError([`work directory already exists: ${options.workDir}`])
  const rollout = readRolloutState(options.rolloutState)
  const manifest = readReleaseManifest(options.releaseManifest, {
    requireRegistryDigest: true,
    requireConcreteRuntimeProfile: true
  })
  const immutableInputs = {
    rolloutState: fileBinding(options.rolloutState, 'rollout state'),
    releaseManifest: fileBinding(options.releaseManifest, 'release manifest'),
    scenario: fileBinding(options.scenario, 'qualification scenario')
  }
  const identityErrors = []
  if (manifest.releaseId !== rollout.target.releaseId) identityErrors.push('release manifest releaseId does not match rollout target')
  if (manifest.imageDigest !== rollout.target.imageDigest) identityErrors.push('release manifest imageDigest does not match rollout target')
  if (identityErrors.length > 0) throw new QualificationError(identityErrors)
  const scenario = normalizeMigrationScenario(readJson(options.scenario))
  fs.mkdirSync(options.workDir, { recursive: false, mode: 0o700 })
  const context = {
    options,
    rollout,
    manifest,
    scenario,
    variables: buildVariables(options, rollout, manifest, scenario),
    deps
  }
  const caseReports = []
  const errors = []
  for (const scenarioCase of scenario.cases) {
    const report = await executeCase(scenarioCase, context)
    caseReports.push(report)
    for (const error of report.errors) errors.push(`${scenarioCase.id}:${error}`)
  }
  const finalInputs = {
    rolloutState: fileBinding(options.rolloutState, 'rollout state'),
    releaseManifest: fileBinding(options.releaseManifest, 'release manifest'),
    scenario: fileBinding(options.scenario, 'qualification scenario')
  }
  for (const name of ['releaseManifest', 'scenario']) {
    if (immutableInputs[name].sha256 !== finalInputs[name].sha256) errors.push(`${name} drifted during qualification`)
  }
  const report = {
    schema: MIGRATION_QUALIFICATION_EVIDENCE_SCHEMA,
    contractVersion: 1,
    status: errors.length === 0 ? 'pass' : 'fail',
    runId: options.runId,
    rolloutId: rollout.rolloutId,
    source: rollout.source,
    target: rollout.target,
    releaseManifest: {
      releaseId: manifest.releaseId,
      commitSha: manifest.commitSha,
      imageDigest: manifest.imageDigest,
      currentSchema: manifest.currentSchema,
      binding: immutableInputs.releaseManifest
    },
    rolloutState: { start: immutableInputs.rolloutState, end: finalInputs.rolloutState },
    scenario: immutableInputs.scenario,
    topology: scenario.topology,
    startedAtUtc: caseReports[0]?.startedAtUtc ?? deps.now().toISOString(),
    completedAtUtc: deps.now().toISOString(),
    cases: caseReports,
    errors: unique(errors)
  }
  report.evidenceSha256 = sha256Value({ ...report, evidenceSha256: undefined })
  writeJsonExclusiveAtomic(options.out, report)
  if (report.status !== 'pass') process.exitCode = 1
  return report
}

export function normalizeMigrationScenario(value) {
  const errors = []
  if (!isObject(value)) throw new QualificationError(['scenario must be a JSON object'])
  if (value.schema !== MIGRATION_QUALIFICATION_SCENARIO_SCHEMA) errors.push(`scenario.schema must be ${MIGRATION_QUALIFICATION_SCENARIO_SCHEMA}`)
  const topology = normalizeTopology(value.topology, errors)
  if (!Array.isArray(value.cases)) errors.push('scenario.cases must be an array')
  const cases = []
  const seenCaseIds = new Set()
  for (let index = 0; index < REQUIRED_MIGRATION_CASES.length; index += 1) {
    const [requiredId, requiredRoles] = REQUIRED_MIGRATION_CASES[index]
    const candidate = value.cases?.[index]
    if (!isObject(candidate)) {
      errors.push(`scenario.cases[${index}] must be ${requiredId}`)
      continue
    }
    if (candidate.id !== requiredId) errors.push(`scenario.cases[${index}].id must be ${requiredId}`)
    if (seenCaseIds.has(candidate.id)) errors.push(`duplicate case id: ${candidate.id}`)
    seenCaseIds.add(candidate.id)
    const actions = normalizeActions(candidate.actions, requiredId, requiredRoles, topology, errors)
    cases.push({ id: requiredId, actions })
  }
  if (Array.isArray(value.cases) && value.cases.length !== REQUIRED_MIGRATION_CASES.length) {
    errors.push(`scenario.cases must contain exactly ${REQUIRED_MIGRATION_CASES.length} cases`)
  }
  if (errors.length > 0) throw new QualificationError(errors)
  return { schema: MIGRATION_QUALIFICATION_SCENARIO_SCHEMA, topology, cases }
}

function normalizeTopology(value, errors) {
  if (!isObject(value)) {
    errors.push('scenario.topology must be an object')
    return null
  }
  if (value.environment !== 'Test') errors.push('scenario.topology.environment must be Test')
  if (value.destructiveFaultsAgainstProduction !== false) errors.push('scenario.topology.destructiveFaultsAgainstProduction must be false')
  const databaseIsolationId = String(value.databaseIsolationId ?? '')
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/u.test(databaseIsolationId) || /prod(?:uction)?/iu.test(databaseIsolationId)) {
    errors.push('scenario.topology.databaseIsolationId must identify a non-production isolated database')
  }
  const origins = {}
  for (const name of ['source', 'target']) {
    try {
      const origin = new URL(String(value.origins?.[name] ?? ''))
      if (!['http:', 'https:'].includes(origin.protocol)
        || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(origin.hostname)
        || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
        throw new Error('must be an exact loopback HTTP(S) origin')
      }
      origins[name] = origin.origin
    } catch (error) { errors.push(`scenario.topology.origins.${name} ${message(error)}`) }
  }
  if (origins.source && origins.target && origins.source === origins.target) errors.push('source and target origins must differ')
  return { environment: 'Test', destructiveFaultsAgainstProduction: false, databaseIsolationId, origins }
}

function normalizeActions(value, caseId, requiredRoles, topology, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${caseId}.actions must be an array`)
    return []
  }
  if (value.length !== requiredRoles.length) errors.push(`${caseId}.actions must contain exactly ${requiredRoles.length} actions`)
  const actions = []
  const ids = new Set()
  for (let index = 0; index < requiredRoles.length; index += 1) {
    const [role, type] = requiredRoles[index]
    const action = value[index]
    if (!isObject(action)) {
      errors.push(`${caseId}.actions[${index}] must be ${role}`)
      continue
    }
    if (action.role !== role) errors.push(`${caseId}.actions[${index}].role must be ${role}`)
    if (action.type !== type) errors.push(`${caseId}.${role}.type must be ${type}`)
    const id = String(action.id ?? '')
    if (!/^[a-z][a-z0-9._-]{2,63}$/u.test(id)) errors.push(`${caseId}.${role}.id is invalid`)
    if (ids.has(id)) errors.push(`${caseId} duplicate action id: ${id}`)
    ids.add(id)
    if (type === 'command') actions.push(normalizeCommandAction(action, caseId, role, errors))
    else actions.push(normalizeHttpAction(action, caseId, role, topology, errors))
  }
  if (caseId === 'blue-green-concurrent-read-write') {
    const groups = new Set(actions.map(item => item.parallelGroup))
    if (groups.size !== 1 || groups.has(null)) errors.push(`${caseId} actions must share one parallelGroup`)
  }
  return actions
}

function normalizeCommandAction(action, caseId, role, errors) {
  if (!Array.isArray(action.argv) || action.argv.length < 1 || action.argv.some(value => typeof value !== 'string' || !value || /[\r\n\0]/u.test(value))) {
    errors.push(`${caseId}.${role}.argv must be a non-empty string array`)
  }
  if (!Array.isArray(action.inputFiles) || action.inputFiles.length < 1 || action.inputFiles.some(value => typeof value !== 'string' || !value)) {
    errors.push(`${caseId}.${role}.inputFiles must bind at least one file`)
  }
  if (!isObject(action.expect) || !Array.isArray(action.expect.exitCodes) || action.expect.exitCodes.length < 1) {
    errors.push(`${caseId}.${role}.expect.exitCodes is required`)
  }
  return {
    id: String(action.id ?? role), role, type: 'command',
    argv: Array.isArray(action.argv) ? [...action.argv] : [],
    inputFiles: Array.isArray(action.inputFiles) ? [...action.inputFiles] : [],
    cwd: action.cwd ?? '.',
    timeoutMs: normalizeTimeout(action.timeoutMs, `${caseId}.${role}`, errors),
    parallelGroup: action.parallelGroup ?? null,
    expect: isObject(action.expect) ? structuredClone(action.expect) : {}
  }
}

function normalizeHttpAction(action, caseId, role, topology, errors) {
  if (!['source', 'target'].includes(action.origin)) errors.push(`${caseId}.${role}.origin must be source or target`)
  const requestPath = String(action.path ?? '')
  if (!requestPath.startsWith('/') || requestPath.startsWith('//') || requestPath.includes('\\') || /[\r\n]/u.test(requestPath)
    || requestPath.split(/[?#]/u)[0].split('/').includes('..') || /[?&](?:token|secret|password|credential)=/iu.test(requestPath)) {
    errors.push(`${caseId}.${role}.path must be a safe origin-relative path without credentials`)
  }
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(action.method)) errors.push(`${caseId}.${role}.method is invalid`)
  if (!isObject(action.expect) || !Array.isArray(action.expect.statusCodes) || action.expect.statusCodes.length < 1) {
    errors.push(`${caseId}.${role}.expect.statusCodes is required`)
  }
  if (action.bodyFile !== undefined && typeof action.bodyFile !== 'string') errors.push(`${caseId}.${role}.bodyFile is invalid`)
  if (action.headerFile !== undefined && typeof action.headerFile !== 'string') errors.push(`${caseId}.${role}.headerFile is invalid`)
  return {
    id: String(action.id ?? role), role, type: 'http',
    origin: action.origin,
    path: requestPath,
    method: action.method,
    bodyFile: action.bodyFile ?? null,
    headerFile: action.headerFile ?? null,
    contentType: action.contentType ?? 'application/json',
    timeoutMs: normalizeTimeout(action.timeoutMs, `${caseId}.${role}`, errors),
    parallelGroup: action.parallelGroup ?? null,
    expect: isObject(action.expect) ? structuredClone(action.expect) : {}
  }
}

function normalizeTimeout(value, label, errors) {
  const parsed = Number(value ?? 120_000)
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 900_000) {
    errors.push(`${label}.timeoutMs must be 1000..900000`)
    return 120_000
  }
  return parsed
}

async function executeCase(scenarioCase, context) {
  const startedAt = context.deps.now()
  const reports = []
  for (let index = 0; index < scenarioCase.actions.length;) {
    const action = scenarioCase.actions[index]
    if (!action.parallelGroup) {
      reports.push(await executeAction(action, scenarioCase.id, context))
      index += 1
      continue
    }
    const group = []
    while (index < scenarioCase.actions.length && scenarioCase.actions[index].parallelGroup === action.parallelGroup) {
      group.push(scenarioCase.actions[index++])
    }
    reports.push(...await Promise.all(group.map(item => executeAction(item, scenarioCase.id, context))))
  }
  const errors = reports.flatMap(report => report.errors.map(error => `${report.role}:${error}`))
  const semantic = evaluateMigrationCase(scenarioCase.id, reports)
  errors.push(...semantic.errors)
  const completedAt = context.deps.now()
  return {
    id: scenarioCase.id,
    status: errors.length === 0 ? 'pass' : 'fail',
    startedAtUtc: startedAt.toISOString(),
    completedAtUtc: completedAt.toISOString(),
    durationMs: Math.max(0, completedAt - startedAt),
    ...(semantic.overlapMs !== null ? { overlapMs: semantic.overlapMs } : {}),
    actions: reports,
    errors: unique(errors)
  }
}

async function executeAction(action, caseId, context) {
  try {
    return action.type === 'command'
      ? await executeCommand(action, caseId, context)
      : await executeHttp(action, context)
  } catch (error) {
    const now = context.deps.now().toISOString()
    return { id: action.id, role: action.role, type: action.type, status: 'fail', startedAtUtc: now, completedAtUtc: now, durationMs: 0, parsed: null, errors: errorList(error) }
  }
}

async function executeCommand(action, caseId, context) {
  const startedAt = context.deps.now()
  const directory = path.join(context.options.workDir, caseId)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stdoutFile = path.join(directory, `${action.id}.stdout`)
  const stderrFile = path.join(directory, `${action.id}.stderr`)
  const argv = action.argv.map(value => expand(value, context.variables))
  const executable = resolveExecutable(argv[0])
  const args = argv.slice(1)
  const cwd = resolveScenarioPath(expand(action.cwd, context.variables), context.options.scenario)
  const inputBindings = action.inputFiles.map(file => fileBinding(resolveScenarioPath(expand(file, context.variables), context.options.scenario), `${action.role} input`))
  const stdoutFd = fs.openSync(stdoutFile, 'wx', 0o600)
  const stderrFd = fs.openSync(stderrFile, 'wx', 0o600)
  let result
  try {
    result = await spawnAndWait(context.deps.spawn, executable, args, { cwd, stdoutFd, stderrFd, timeoutMs: action.timeoutMs })
  } finally {
    fs.closeSync(stdoutFd)
    fs.closeSync(stderrFd)
  }
  const parsed = parseMachineJson(stdoutFile)
  const errors = evaluateCommandExpectation(action.expect, result, parsed, context.variables)
  const completedAt = context.deps.now()
  return {
    id: action.id, role: action.role, type: 'command', status: errors.length === 0 ? 'pass' : 'fail',
    startedAtUtc: startedAt.toISOString(), completedAtUtc: completedAt.toISOString(), durationMs: Math.max(0, completedAt - startedAt),
    command: { executable: fileBinding(executable, `${action.role} executable`), argvSha256: sha256Value(argv), cwd, inputFiles: inputBindings },
    exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
    stdout: fileBinding(stdoutFile, `${action.role} stdout`), stderr: fileBinding(stderrFile, `${action.role} stderr`),
    parsed: sanitizeParsed(parsed), errors
  }
}

async function executeHttp(action, context) {
  const startedAt = context.deps.now()
  const url = new URL(action.path, context.scenario.topology.origins[action.origin])
  const headers = { Accept: action.expect.accept ?? 'application/json' }
  const inputBindings = {}
  if (action.headerFile) {
    const file = resolveScenarioPath(expand(action.headerFile, context.variables), context.options.scenario)
    const header = readPrivateHeader(file)
    headers[header.name] = header.value
    inputBindings.headerFile = fileBinding(file, `${action.role} header file`)
  }
  let body
  if (action.bodyFile) {
    const file = resolveScenarioPath(expand(action.bodyFile, context.variables), context.options.scenario)
    body = fs.readFileSync(file)
    headers['Content-Type'] = action.contentType
    inputBindings.bodyFile = fileBinding(file, `${action.role} body file`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), action.timeoutMs)
  let response
  let bytes
  try {
    response = await context.deps.fetch(url, { method: action.method, headers, body, redirect: 'manual', signal: controller.signal })
    bytes = Buffer.from(await response.arrayBuffer())
  } finally { clearTimeout(timer) }
  let parsed = null
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch {}
  const observed = {
    status: response.status,
    contentType: response.headers.get('content-type'),
    releaseId: response.headers.get('x-fsus-release-id'),
    releaseSlot: response.headers.get('x-fsus-release-slot'),
    bytes: bytes.length,
    sha256: sha256(bytes)
  }
  const errors = evaluateHttpExpectation(action.expect, observed, parsed, context.variables)
  const completedAt = context.deps.now()
  return {
    id: action.id, role: action.role, type: 'http', status: errors.length === 0 ? 'pass' : 'fail',
    startedAtUtc: startedAt.toISOString(), completedAtUtc: completedAt.toISOString(), durationMs: Math.max(0, completedAt - startedAt),
    request: { method: action.method, origin: action.origin, path: action.path, inputBindings },
    response: observed, parsed: sanitizeParsed(parsed), errors
  }
}

function evaluateCommandExpectation(expect, result, parsed, variables) {
  const errors = []
  if (result.spawnError) errors.push(`spawn failed: ${result.spawnError}`)
  if (!expect.exitCodes?.includes(result.exitCode)) errors.push(`exit code ${result.exitCode} not in ${JSON.stringify(expect.exitCodes)}`)
  if (result.timedOut) errors.push('command exceeded process timeout')
  if (!isObject(parsed)) errors.push('stdout must be one machine JSON object')
  if (expect.status && !(Array.isArray(expect.status) ? expect.status : [expect.status]).includes(parsed?.status)) errors.push(`status mismatch: ${parsed?.status ?? 'missing'}`)
  if (expect.phase && String(parsed?.phase ?? '').toLowerCase() !== String(expect.phase).toLowerCase()) errors.push(`phase mismatch: ${parsed?.phase ?? 'missing'}`)
  if (expect.release && parsed?.releaseId !== variables[`${expect.release}.releaseId`]) errors.push(`releaseId mismatch for ${expect.release}`)
  const codes = resultCodes(parsed)
  for (const code of expect.codesInclude ?? []) if (!codes.includes(code)) errors.push(`missing code: ${code}`)
  const issueCodes = resultIssueCodes(parsed)
  for (const code of expect.issueCodesInclude ?? []) if (!issueCodes.includes(code)) errors.push(`missing issue code: ${code}`)
  if (expect.rollbackCompatible !== undefined && parsed?.rollbackCompatible !== expect.rollbackCompatible) errors.push('rollbackCompatible mismatch')
  if (expect.contractApplied !== undefined && parsed?.contractApplied !== expect.contractApplied) errors.push('contractApplied mismatch')
  if (expect.historyHashRequired && !isSha256(parsed?.historyHash)) errors.push('historyHash is missing')
  if (expect.checkpoint) errors.push(...evaluateCheckpoint(expect.checkpoint, parsed))
  for (const assertion of expect.assertions ?? []) errors.push(...evaluateJsonAssertion(parsed, assertion, variables))
  return errors
}

function evaluateHttpExpectation(expect, observed, parsed, variables) {
  const errors = []
  if (!expect.statusCodes?.includes(observed.status)) errors.push(`HTTP ${observed.status} not in ${JSON.stringify(expect.statusCodes)}`)
  if (expect.release) {
    if (observed.releaseId !== variables[`${expect.release}.releaseId`]) errors.push(`response releaseId mismatch for ${expect.release}`)
    if (observed.releaseSlot !== variables[`${expect.release}.slot`]) errors.push(`response releaseSlot mismatch for ${expect.release}`)
  }
  if (expect.contentType && !String(observed.contentType ?? '').toLowerCase().startsWith(String(expect.contentType).toLowerCase())) errors.push('response content-type mismatch')
  if (Number(observed.bytes) < Number(expect.minimumBytes ?? 1)) errors.push('response body is too small')
  for (const assertion of expect.assertions ?? []) errors.push(...evaluateJsonAssertion(parsed, assertion, variables))
  return errors
}

function evaluateCheckpoint(expect, value) {
  const errors = []
  if (expect.status && value?.checkpoint?.status !== expect.status && value?.status !== expect.status) errors.push(`checkpoint status mismatch: ${value?.checkpoint?.status ?? value?.status ?? 'missing'}`)
  const checkpoint = value?.checkpoint ?? value
  if (expect.migrationId && checkpoint?.migrationId !== expect.migrationId) errors.push('checkpoint migrationId mismatch')
  if (expect.resumeTokenHashRequired && !isSha256(checkpoint?.resumeTokenHash)) errors.push('checkpoint resumeTokenHash is missing')
  if (expect.minimumRowsProcessed !== undefined && Number(checkpoint?.rowsProcessed) < expect.minimumRowsProcessed) errors.push('checkpoint rowsProcessed is too small')
  if (expect.minimumFailureCount !== undefined && Number(checkpoint?.failureCount) < expect.minimumFailureCount) errors.push('checkpoint failureCount is too small')
  return errors
}

function evaluateJsonAssertion(value, assertion, variables) {
  const errors = []
  const observed = jsonPointer(value, assertion.pointer)
  const expected = assertion.equalsVariable ? variables[assertion.equalsVariable] : assertion.equals
  if (assertion.includes !== undefined) {
    if (!Array.isArray(observed) || !observed.includes(assertion.includes)) errors.push(`assertion ${assertion.pointer} missing ${assertion.includes}`)
  } else if (!deepEqual(observed, expected)) errors.push(`assertion ${assertion.pointer} mismatch`)
  return errors
}

export function evaluateMigrationCase(caseId, reports) {
  const errors = []
  const byRole = Object.fromEntries(reports.map(report => [report.role, report]))
  let overlapMs = null
  if (caseId === 'expand-with-old-active') {
    if (byRole['source-before-expand']?.response?.releaseId !== byRole['source-after-expand-read']?.response?.releaseId) errors.push('old active source identity changed during Expand')
    if (byRole.expand?.parsed?.status !== 'ok') errors.push('Expand did not complete while old active remained available')
  } else if (caseId === 'blue-green-concurrent-read-write') {
    const starts = reports.map(item => Date.parse(item.startedAtUtc)); const ends = reports.map(item => Date.parse(item.completedAtUtc))
    overlapMs = Math.max(0, Math.min(...ends) - Math.max(...starts))
    if (!(overlapMs > 0)) errors.push('Blue/Green read/write actions did not overlap')
  } else if (caseId === 'backfill-checkpoint-resume') {
    if (byRole['backfill-start']?.parsed?.status !== 'paused') errors.push('Backfill start did not pause with a durable checkpoint')
    const paused = checkpoint(byRole['checkpoint-paused']); const completed = checkpoint(byRole['checkpoint-completed'])
    if (!paused || !completed || !isSha256(paused.resumeTokenHash) || !isSha256(completed.resumeTokenHash)) errors.push('Backfill checkpoint hashes are missing')
    if (Number(completed?.rowsProcessed) < Number(paused?.rowsProcessed)) errors.push('Backfill resume regressed rowsProcessed')
    if (completed?.status !== 'completed') errors.push('Backfill resume did not complete')
  } else if (caseId === 'missing-expand-candidate-not-ready') {
    if (byRole['prepare-missing-expand']?.parsed?.status !== 'prepared') errors.push('missing Expand qualification state was not prepared')
    if (!resultIssueCodes(byRole['candidate-check']?.parsed).includes('schema_expand_pending')) errors.push('missing Expand was not reported')
    if (byRole['candidate-readiness']?.response?.status !== 503 || byRole['candidate-readiness']?.parsed?.code !== 'schema_incompatible') errors.push('candidate readiness did not fail closed for missing Expand')
    if (byRole['expand-recover']?.parsed?.status !== 'ok') errors.push('missing Expand qualification state was not recovered')
  } else if (caseId === 'contract-rollback-window-rejected') {
    const codes = resultCodes(byRole['contract-rejected']?.parsed)
    for (const code of ['schema_contract_previous_release_dependency', 'schema_contract_rollback_manifest_open']) if (!codes.includes(code)) errors.push(`Contract rollback window missing rejection ${code}`)
  } else if (caseId === 'contract-applied-non-rollback-compatible') {
    if (byRole['contract-apply']?.parsed?.status !== 'ok') errors.push('Contract did not apply')
    if (byRole['rollback-marker']?.parsed?.rollbackCompatible !== false || byRole['rollback-marker']?.parsed?.contractApplied !== true) errors.push('post-Contract non-rollback marker is invalid')
  } else if (caseId === 'advisory-lock-timeout') {
    if (!resultCodes(byRole['advisory-lock-timeout']?.parsed).includes('schema_advisory_lock_timeout')) errors.push('advisory lock timeout was not proven')
  } else if (caseId === 'database-disconnect') {
    if (!resultCodes(byRole['database-disconnect']?.parsed).includes('schema_database_unavailable')) errors.push('database disconnect was not proven')
  } else if (caseId === 'partial-failure-recovery') {
    const failed = checkpoint(byRole['checkpoint-failed']); const recovered = checkpoint(byRole['checkpoint-recovered'])
    if (!failed || Number(failed.failureCount) < 1) errors.push('partial failure checkpoint is missing')
    if (!recovered || recovered.status !== 'completed' || Number(recovered.rowsProcessed) < Number(failed?.rowsProcessed)) errors.push('partial failure did not resume from checkpoint')
  } else if (caseId === 'history-integrity-rejected') {
    const issues = resultIssueCodes(byRole['history-check']?.parsed)
    for (const code of ['schema_history_checksum_mismatch', 'schema_history_unknown']) if (!issues.includes(code)) errors.push(`history integrity missing ${code}`)
  }
  return { errors, overlapMs }
}

function checkpoint(report) { return report?.parsed?.checkpoint ?? report?.parsed ?? null }
function resultCodes(value) { return unique([...(Array.isArray(value?.codes) ? value.codes : []), ...(value?.code ? [value.code] : [])].map(String)) }
function resultIssueCodes(value) { return unique((value?.issues ?? []).map(item => String(item?.code ?? '')).filter(Boolean)) }

function sanitizeParsed(value) {
  if (!isObject(value)) return value
  const result = {}
  for (const key of ['status', 'code', 'runId', 'rolloutId', 'releaseId', 'databaseIsolationId', 'schemaCompatibilityCoordinate', 'phase', 'migrationIds', 'codes', 'publicErrorCode', 'rollbackCompatible', 'contractApplied', 'historyHash']) {
    if (value[key] !== undefined) result[key] = value[key]
  }
  if (Array.isArray(value.issues)) result.issues = value.issues.map(item => ({ code: item?.code, severity: item?.severity, migrationId: item?.migrationId }))
  const source = value.checkpoint ?? value
  if (source.migrationId !== undefined || source.resumeTokenHash !== undefined || source.rowsProcessed !== undefined || source.failureCount !== undefined) {
    result.checkpoint = {
      migrationId: source.migrationId ?? null, status: source.status ?? null,
      resumeTokenHash: source.resumeTokenHash ?? null, rowsProcessed: source.rowsProcessed ?? null,
      failureCount: source.failureCount ?? null, updatedAtUtc: source.updatedAtUtc ?? null
    }
  }
  return result
}

function parseMachineJson(file) {
  const stat = fs.statSync(file)
  if (stat.size > 4 * 1024 * 1024) return null
  const text = fs.readFileSync(file, 'utf8').trim()
  try { return JSON.parse(text) } catch { return null }
}

function spawnAndWait(spawnImpl, executable, args, options) {
  return new Promise(resolve => {
    const child = spawnImpl(executable, args, { cwd: options.cwd, env: process.env, detached: process.platform !== 'win32', stdio: ['ignore', options.stdoutFd, options.stderrFd] })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL') } catch {}
    }, options.timeoutMs)
    child.once('error', error => { clearTimeout(timer); resolve({ exitCode: null, signal: null, timedOut, spawnError: message(error) }) })
    child.once('close', (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, timedOut, spawnError: null }) })
  })
}

function buildVariables(options, rollout, manifest, scenario) {
  return {
    releaseManifest: options.releaseManifest, rolloutState: options.rolloutState,
    'source.releaseId': rollout.source.releaseId, 'source.slot': rollout.source.slot,
    'source.generation': String(rollout.source.runtimeGeneration), 'source.imageDigest': rollout.source.imageDigest,
    'target.releaseId': rollout.target.releaseId, 'target.slot': rollout.target.slot,
    'target.generation': String(rollout.target.runtimeGeneration), 'target.imageDigest': rollout.target.imageDigest,
    rolloutId: rollout.rolloutId, runId: options.runId,
    'manifest.releaseId': manifest.releaseId, 'topology.databaseIsolationId': scenario.topology.databaseIsolationId
  }
}

function expand(value, variables) {
  return String(value).replace(/\{\{([A-Za-z0-9_.-]+)\}\}/gu, (_, name) => {
    if (variables[name] === undefined) throw new QualificationError([`unknown scenario variable: ${name}`])
    return String(variables[name])
  })
}

function resolveScenarioPath(value, scenarioFile) { return path.resolve(path.dirname(scenarioFile), value) }

function resolveExecutable(value) {
  if (value.includes(path.sep)) {
    const resolved = path.resolve(value); requireExecutable(resolved); return resolved
  }
  for (const directory of String(process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, value)
    try { requireExecutable(candidate); return fs.realpathSync(candidate) } catch {}
  }
  throw new QualificationError([`command executable not found: ${value}`])
}

function requireExecutable(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) throw new Error('not executable')
}

function readPrivateHeader(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || ![0o400, 0o600].includes(stat.mode & 0o777)) throw new QualificationError(['HTTP header file must be regular non-symlink mode 0400/0600'])
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u).map(item => item.trim()).filter(Boolean)
  const match = lines.length === 1 ? /^(Authorization|Cookie): (\S(?:.*\S)?)$/u.exec(lines[0]) : null
  if (!match || (match[1] === 'Authorization' && !match[2].startsWith('Bearer '))) throw new QualificationError(['HTTP header file must contain exactly one Authorization: Bearer or Cookie line'])
  return { name: match[1], value: match[2] }
}

function jsonPointer(value, pointer) {
  if (pointer === '') return value
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined
  let current = value
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/gu, '/').replace(/~0/gu, '~')
    current = current?.[key]
  }
  return current
}

function deepEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right) }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function unique(values) { return [...new Set(values)] }
function message(error) { return error instanceof Error ? error.message : String(error) }
function errorList(error) { return error instanceof QualificationError ? error.errors : [message(error)] }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')) }
function sha256(value) { return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}` }
function sha256Value(value) { return sha256(JSON.stringify(value)) }
function isSha256(value) { return /^sha256:[0-9a-f]{64}$/u.test(String(value ?? '')) }

function fileBinding(file, label) {
  const resolved = path.resolve(file)
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new QualificationError([`${label} must be a regular non-symlink file`])
  const bytes = fs.readFileSync(resolved)
  return { path: fs.realpathSync(resolved), bytes: bytes.length, sha256: sha256(bytes) }
}

function writeJsonExclusiveAtomic(file, value) {
  if (fs.existsSync(file)) throw new QualificationError([`output already exists: ${file}`])
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  let fd
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
    fs.linkSync(temporary, file); fs.unlinkSync(temporary)
    const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }) }
}

export function parseMigrationQualificationArgs(argv) {
  const parsed = {}; const errors = []; const allowed = new Set(['scenario', 'rollout-state', 'release-manifest', 'work-dir', 'out', 'run-id'])
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) { errors.push(`invalid argument near ${name ?? '<end>'}`); continue }
    const key = name.slice(2); if (!allowed.has(key)) errors.push(`unknown argument --${key}`); else if (parsed[key]) errors.push(`duplicate argument --${key}`); else parsed[key] = value
  }
  for (const name of allowed) if (!parsed[name]) errors.push(`--${name} is required`)
  if (parsed['run-id'] && !/^[0-9A-Za-z][0-9A-Za-z._:-]{7,127}$/u.test(parsed['run-id'])) errors.push('--run-id is invalid')
  if (errors.length > 0) throw new QualificationError(errors)
  return {
    scenario: path.resolve(parsed.scenario), rolloutState: path.resolve(parsed['rollout-state']),
    releaseManifest: path.resolve(parsed['release-manifest']), workDir: path.resolve(parsed['work-dir']),
    out: path.resolve(parsed.out), runId: parsed['run-id']
  }
}

async function main() {
  let options
  try {
    options = parseMigrationQualificationArgs(process.argv.slice(2))
    const report = await runMigrationQualification(options)
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } catch (error) {
    for (const item of unique(errorList(error))) process.stderr.write(`[release-migration-qualification] ${item}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
