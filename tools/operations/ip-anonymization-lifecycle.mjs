#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const CONFIG_SCHEMA = 'fsusblog.ip-anonymization-lifecycle.v1'
const INVENTORY_SCHEMA = 'fsusblog.ip-anonymization-inventory.v1'
const REPORT_SCHEMA = 'fsusblog.ip-anonymization-report.v1'
const MEDIA = Object.freeze(['backup', 'wal', 'log', 'etl'])
const DEFAULT_RETENTION = Object.freeze({ backupDays: 90, walDays: 30, logDays: 30, etlDays: 7, redisGraceHours: 1 })
const DEFAULT_INVENTORY_MAX_AGE_HOURS = 24
const IPV4 = /(?<![0-9.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![0-9.])/gu
const IP_TOKEN = /[0-9A-Fa-f:.%]{2,}/gu

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.now && process.env.FSUSBLOG_IP_ANONYMIZATION_ALLOW_TEST_CLOCK !== '1') {
    throw new Error('--now is reserved for the isolated lifecycle fixture')
  }
  if (options.requestRefFile) options.requestRef = readPrivateReference(options.requestRefFile, 'request reference')
  if (options.actorRefFile) options.actorRef = readPrivateReference(options.actorRefFile, 'actor reference')
  const configPath = path.resolve(options.config)
  const configDir = path.dirname(configPath)
  const config = readJson(configPath)
  validateConfig(config)
  validateRoots(config, configDir)
  const inventory = readJson(resolveFrom(configDir, config.inventory))
  validateInventory(inventory)
  const now = options.now ? parseUtc(options.now, '--now') : new Date()
  const context = { config, inventory, options, now, configDir }
  const report = options.command === 'dsr-export'
    ? runDsrExport(context)
    : runLifecycle(context)
  writeEvidence(options.output, report)
  if (options.command === 'apply' || options.command.startsWith('dsr-')) appendAudit(context, report)
  process.stdout.write(`${JSON.stringify({ status: report.status, command: report.command, output: path.resolve(options.output) })}\n`)
  if (report.status !== 'pass') process.exitCode = 1
} catch (error) {
  process.stderr.write(`[ip-anonymization-lifecycle] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

function parseArgs(argv) {
  const command = argv.shift()
  if (!['plan', 'apply', 'verify', 'dsr-export', 'dsr-delete'].includes(command)) {
    throw new Error('command must be plan, apply, verify, dsr-export, or dsr-delete')
  }
  const parsed = { command }
  const allowed = new Set(['config', 'output', 'now', 'request-ref-file', 'actor-ref-file', 'allow-live-mutation'])
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!name?.startsWith('--')) throw new Error(`invalid argument: ${name ?? '<end>'}`)
    const key = name.slice(2)
    if (!allowed.has(key)) throw new Error(`unsupported argument: ${name}`)
    const property = key.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
    if (Object.hasOwn(parsed, property)) throw new Error(`duplicate argument: ${name}`)
    if (key === 'allow-live-mutation') {
      parsed.allowLiveMutation = true
      continue
    }
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${name}`)
    parsed[property] = value
  }
  if (!parsed.config || !parsed.output) throw new Error('--config and --output are required')
  if (command.startsWith('dsr-') && !parsed.requestRefFile) throw new Error('--request-ref-file is required for DSR commands')
  if ((command === 'apply' || command.startsWith('dsr-')) && !parsed.actorRefFile) {
    throw new Error('--actor-ref-file is required for mutation and DSR commands')
  }
  if ((command === 'apply' || command === 'dsr-delete') && !parsed.allowLiveMutation) {
    throw new Error(`${command} requires --allow-live-mutation`)
  }
  return parsed
}

function readPrivateReference(file, label) {
  const target = path.resolve(file)
  const stat = fs.lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} file must be a regular non-symlink file`)
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error(`${label} file permissions must be 0600 or stricter`)
  const value = fs.readFileSync(target, 'utf8').trim()
  if (value.length === 0 || value.length > 256 || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a single value up to 256 characters`)
  return value
}

function validateConfig(config) {
  if (config?.schema !== CONFIG_SCHEMA) throw new Error(`config schema must be ${CONFIG_SCHEMA}`)
  if (!config.inventory || !config.auditLog) throw new Error('config inventory and auditLog are required')
  if (!config.roots || typeof config.roots !== 'object') throw new Error('config roots are required')
  for (const medium of MEDIA) {
    const roots = config.roots[medium]
    if (!Array.isArray(roots) || roots.length === 0) throw new Error(`config roots.${medium} must be a non-empty array`)
  }
  const retention = { ...DEFAULT_RETENTION, ...config.retention }
  for (const name of Object.keys(config.retention ?? {})) {
    if (!Object.hasOwn(DEFAULT_RETENTION, name)) throw new Error(`unsupported retention setting: ${name}`)
  }
  for (const [name, value] of Object.entries(retention)) {
    if (!Number.isInteger(value) || value <= 0 || value > DEFAULT_RETENTION[name]) {
      throw new Error(`retention ${name} must be a positive integer no greater than ${DEFAULT_RETENTION[name]}`)
    }
  }
  const inventoryMaxAgeHours = config.inventoryMaxAgeHours ?? DEFAULT_INVENTORY_MAX_AGE_HOURS
  if (!Number.isInteger(inventoryMaxAgeHours) || inventoryMaxAgeHours <= 0 || inventoryMaxAgeHours > 168) {
    throw new Error('inventoryMaxAgeHours must be a positive integer no greater than 168')
  }
  if (config.redis?.required && (!Array.isArray(config.redis.legacyPrefixes) || config.redis.legacyPrefixes.length === 0)) {
    throw new Error('required Redis cleanup needs at least one legacyPrefixes entry')
  }
  for (const prefix of config.redis?.legacyPrefixes ?? []) {
    if (!/^[0-9A-Za-z_-]+(?::[0-9A-Za-z_-]+){2,}:$/u.test(prefix) || !prefix.split(':').includes('legacy')) {
      throw new Error(`unsafe Redis legacy prefix: ${prefix}`)
    }
  }
  for (const [medium, prefixes] of Object.entries(config.s3Prefixes ?? {})) {
    if (!MEDIA.includes(medium) || !Array.isArray(prefixes)) throw new Error(`invalid S3 prefix group: ${medium}`)
    for (const prefix of prefixes) validateS3Location(prefix, `S3 prefix ${medium}`)
  }
}

function validateInventory(inventory) {
  if (inventory?.schema !== INVENTORY_SCHEMA) throw new Error(`inventory schema must be ${INVENTORY_SCHEMA}`)
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u.test(inventory.inventoryId ?? '')) throw new Error('inventoryId is invalid')
  parseUtc(inventory.cutoverAtUtc, 'inventory cutoverAtUtc')
  if (!inventory.coverage || typeof inventory.coverage !== 'object') throw new Error('inventory coverage is required')
  for (const medium of MEDIA) {
    const coverage = inventory.coverage[medium]
    if (coverage?.complete !== true) throw new Error(`inventory coverage ${medium} must be explicitly complete`)
    parseUtc(coverage.scannedAtUtc, `inventory coverage ${medium} scannedAtUtc`)
  }
  if (!Array.isArray(inventory.artifacts)) throw new Error('inventory artifacts must be an array')
  const ids = new Set()
  for (const artifact of inventory.artifacts) {
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u.test(artifact?.id ?? '')) throw new Error('artifact id is invalid')
    if (ids.has(artifact.id)) throw new Error(`duplicate artifact id: ${artifact.id}`)
    ids.add(artifact.id)
    if (!MEDIA.includes(artifact.media)) throw new Error(`unsupported artifact media: ${artifact.media}`)
    if (!['present', 'absent', 'unknown'].includes(artifact.rawIpState)) throw new Error(`invalid rawIpState for ${artifact.id}`)
    if (!['local', 's3'].includes(artifact.storage)) throw new Error(`invalid storage for ${artifact.id}`)
    parseUtc(artifact.capturedAtUtc, `artifact ${artifact.id} capturedAtUtc`)
    if (artifact.storage === 'local' && !artifact.path) throw new Error(`local artifact ${artifact.id} needs path`)
    if (artifact.storage === 's3' && !/^s3:\/\/[a-z0-9][a-z0-9.-]+\/.+/u.test(artifact.uri ?? '')) {
      throw new Error(`S3 artifact ${artifact.id} needs an object URI`)
    }
    if (artifact.storage === 's3') validateS3Location(artifact.uri, `S3 artifact ${artifact.id}`)
  }
}

function validateRoots(config, configDir) {
  for (const medium of MEDIA) {
    for (const configuredRoot of config.roots[medium]) {
      const root = path.resolve(configDir, configuredRoot)
      const stat = fs.lstatSync(root)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`config root ${medium} must be a non-symlink directory`)
    }
  }
}

function runDsrExport(context) {
  const requestRefHash = opaqueHash(context.options.requestRef)
  return baseReport(context, 'dsr-export', 'pass', {
    dataSubjectRequest: {
      requestRefHash,
      scope: 'unlinked-visit-telemetry',
      result: 'not-individually-addressable',
      exportedRows: 0,
      exportedRawIpValues: 0,
      explanation: 'Visit telemetry has no account or data-subject linkage; no linkage is created for export.'
    },
    media: [],
    violations: []
  })
}

function runLifecycle(context) {
  const { command } = context.options
  const immediate = command === 'dsr-delete'
  const mutate = command === 'apply' || immediate
  const retention = { ...DEFAULT_RETENTION, ...context.config.retention }
  const coverage = inspectCoverage(context)
  const media = context.inventory.artifacts.map(artifact => inspectArtifact(context, artifact, retention, immediate, mutate))
  const redis = inspectRedis(context, retention.redisGraceHours, immediate, mutate)
  const postgres = inspectPostgres(context, mutate)
  const violations = []

  for (const item of coverage) {
    if (item.status !== 'pass') violations.push(`coverage:${item.media}:${item.status}`)
  }

  for (const item of media) {
    if (item.finalState === 'present' || item.finalState === 'unknown') {
      if (item.finalState === 'unknown' || command === 'verify' || item.cleanupDue) violations.push(`${item.id}:${item.finalState}`)
    }
    if (item.finalState !== 'absent' && item.scan?.status !== 'pass') violations.push(`${item.id}:content-scan-${item.scan?.status}`)
    if (item.action === 'failed') violations.push(`${item.id}:cleanup-failed`)
  }
  if (redis.required && redis.status !== 'pass') violations.push(`redis:${redis.status}`)
  if (postgres.required && postgres.status !== 'pass') violations.push(`postgres:${postgres.status}`)

  const status = violations.length === 0 ? 'pass' : 'fail'
  const extra = { retention, coverage, media, redis, postgres, violations }
  if (immediate) {
    extra.dataSubjectRequest = {
      requestRefHash: opaqueHash(context.options.requestRef),
      scope: 'site-wide-unlinked-visit-telemetry',
      result: status === 'pass' ? 'erasure-propagated' : 'erasure-incomplete',
      accountLinkageUsed: false
    }
  }
  return baseReport(context, command, status, extra)
}

function inspectCoverage(context) {
  const maxAgeMs = (context.config.inventoryMaxAgeHours ?? DEFAULT_INVENTORY_MAX_AGE_HOURS) * 3_600_000
  return MEDIA.map(media => {
    const scannedAt = parseUtc(context.inventory.coverage[media].scannedAtUtc, `${media} scannedAtUtc`)
    const ageMs = context.now.getTime() - scannedAt.getTime()
    const status = ageMs < 0 ? 'future' : ageMs > maxAgeMs ? 'stale' : 'pass'
    return { media, status, scannedAtUtc: scannedAt.toISOString() }
  })
}

function inspectArtifact(context, artifact, retention, immediate, mutate) {
  const captured = parseUtc(artifact.capturedAtUtc, artifact.id)
  const cutover = parseUtc(context.inventory.cutoverAtUtc, 'cutoverAtUtc')
  const retentionMs = retention[`${artifact.media}Days`] * 86_400_000
  const postCutoverRawIp = artifact.rawIpState === 'present' && captured.getTime() >= cutover.getTime()
  const cleanupDue = artifact.rawIpState === 'present' && (immediate || postCutoverRawIp || context.now.getTime() - captured.getTime() >= retentionMs)
  let exists = artifact.storage === 'local' ? localExists(context, artifact) : s3Exists(context, artifact)
  let scan
  if (exists && artifact.storage === 'local' && ['log', 'etl'].includes(artifact.media)) {
    scan = scanTextArtifact(resolveLocalArtifact(context, artifact))
  }
  let action = cleanupDue ? 'planned-delete' : 'retained-within-policy'
  if (artifact.rawIpState === 'absent') action = 'none'
  if (artifact.rawIpState === 'unknown') action = 'blocked-unknown-state'
  if (!exists) action = 'already-absent'
  if (mutate && cleanupDue && exists) {
    try {
      if (artifact.storage === 'local') fs.rmSync(resolveLocalArtifact(context, artifact), { force: true })
      else deleteS3(context, artifact)
      exists = artifact.storage === 'local' ? localExists(context, artifact) : s3Exists(context, artifact)
      action = exists ? 'failed' : 'deleted'
    } catch (error) {
      action = 'failed'
      return artifactResult(artifact, cleanupDue, exists ? artifact.rawIpState : 'absent', action, scan, error)
    }
  }
  const finalState = exists ? artifact.rawIpState : 'absent'
  return artifactResult(artifact, cleanupDue, finalState, action, scan)
}

function artifactResult(artifact, cleanupDue, finalState, action, scan, error) {
  return {
    id: artifact.id,
    media: artifact.media,
    storage: artifact.storage,
    capturedAtUtc: artifact.capturedAtUtc,
    cleanupDue,
    finalState,
    action,
    ...(scan ? { scan } : {}),
    ...(error ? { reason: error instanceof Error ? error.message : String(error) } : {})
  }
}

function inspectRedis(context, graceHours, immediate, mutate) {
  const config = context.config.redis ?? {}
  if (!config.required && !config.urlEnv) return { required: false, status: 'not-configured', matchedKeys: 0, deletedKeys: 0 }
  const url = process.env[config.urlEnv ?? 'FSUSBLOG_REDIS_URL']
  if (!url) return { required: Boolean(config.required), status: 'missing-connection', matchedKeys: 0, deletedKeys: 0 }
  const redisBin = process.env.FSUSBLOG_REDIS_CLI_BIN ?? 'redis-cli'
  const redis = redisInvocation(url)
  const cutover = parseUtc(context.inventory.cutoverAtUtc, 'cutoverAtUtc')
  const cleanupDue = immediate || context.now.getTime() - cutover.getTime() >= graceHours * 3_600_000
  const scanKeys = () => {
    const found = []
    for (const prefix of config.legacyPrefixes ?? []) {
      const result = command(redisBin, [...redis.args, '--scan', '--pattern', `${prefix}*`], { env: redis.env })
      for (const key of result.stdout.split(/\r?\n/u).filter(Boolean)) {
        if (!key.startsWith(prefix)) throw new Error('redis-cli returned a key outside the approved legacy prefix')
        found.push(key)
      }
    }
    return [...new Set(found)]
  }
  const keys = scanKeys()
  let deletedKeys = 0
  if (mutate && cleanupDue) {
    for (let index = 0; index < keys.length; index += 100) {
      const batch = keys.slice(index, index + 100)
      if (batch.length === 0) continue
      command(redisBin, [...redis.args, 'UNLINK', ...batch], { env: redis.env, redact: batch })
      deletedKeys += batch.length
    }
  }
  const remaining = mutate && cleanupDue ? scanKeys().length : keys.length
  const status = cleanupDue && remaining > 0 ? 'raw-ip-keys-present' : 'pass'
  return { required: Boolean(config.required), status, cleanupDue, matchedKeys: keys.length, deletedKeys, remainingKeys: remaining }
}

function inspectPostgres(context, mutate) {
  const config = context.config.postgres ?? {}
  if (!config.required && !config.connectionEnv) return { required: false, status: 'not-configured', walSwitched: false }
  const connection = process.env[config.connectionEnv ?? 'FSUSBLOG_DATABASE_URL']
  if (!connection) return { required: Boolean(config.required), status: 'missing-connection', walSwitched: false }
  const psql = process.env.FSUSBLOG_PSQL_BIN ?? 'psql'
  const postgres = postgresInvocation(connection)
  const legacyColumnCheck = command(psql, [
    '-X', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-Atqc',
    "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_name = 'sys_visit_log';"
  ], { env: postgres.env })
  const legacyColumns = Number.parseInt(legacyColumnCheck.stdout.trim(), 10)
  if (!Number.isInteger(legacyColumns)) throw new Error('PostgreSQL legacy-column probe returned a non-integer result')
  if (legacyColumns !== 0) return { required: Boolean(config.required), status: 'legacy-columns-present', legacyColumns, walSwitched: false }
  if (!mutate) return { required: Boolean(config.required), status: 'pass', legacyColumns, walSwitched: false }
  command(psql, ['-X', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-Atqc', "SELECT pg_switch_wal();"], { env: postgres.env })
  return { required: Boolean(config.required), status: 'pass', legacyColumns, walSwitched: true }
}

function localExists(context, artifact) {
  try {
    const stat = fs.lstatSync(resolveLocalArtifact(context, artifact))
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`artifact ${artifact.id} must be a regular non-symlink file`)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function resolveLocalArtifact(context, artifact) {
  const value = path.resolve(context.configDir, artifact.path)
  const roots = context.config.roots[artifact.media].map(root => path.resolve(context.configDir, root))
  const realParent = fs.realpathSync(path.dirname(value))
  const realValue = path.join(realParent, path.basename(value))
  if (!roots.some(root => {
    const realRoot = fs.realpathSync(root)
    return isWithin(realRoot, realValue)
  })) throw new Error(`artifact ${artifact.id} escapes approved ${artifact.media} roots`)
  return value
}

function s3Exists(context, artifact) {
  assertApprovedS3(context, artifact)
  const { bucket, key } = parseS3(artifact.uri)
  const aws = process.env.FSUSBLOG_AWS_BIN ?? 'aws'
  const result = spawnSync(aws, ['s3api', 'head-object', '--bucket', bucket, '--key', key], { encoding: 'utf8', env: process.env })
  if (result.status === 0) return true
  if (/Not Found|404|NoSuchKey/iu.test(`${result.stdout}\n${result.stderr}`)) return false
  throw new Error(`S3 head-object failed for ${artifact.id}`)
}

function deleteS3(context, artifact) {
  assertApprovedS3(context, artifact)
  const { bucket, key } = parseS3(artifact.uri)
  command(process.env.FSUSBLOG_AWS_BIN ?? 'aws', ['s3api', 'delete-object', '--bucket', bucket, '--key', key])
}

function assertApprovedS3(context, artifact) {
  const approved = context.config.s3Prefixes?.[artifact.media] ?? []
  if (!approved.some(prefix => artifact.uri.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))) {
    throw new Error(`S3 artifact ${artifact.id} escapes approved ${artifact.media} prefixes`)
  }
}

function parseS3(uri) {
  const parsed = new URL(uri)
  return { bucket: parsed.hostname, key: decodeURIComponent(parsed.pathname.slice(1)) }
}

function validateS3Location(value, label) {
  const parsed = new URL(value)
  const decodedPath = decodeURIComponent(parsed.pathname)
  if (parsed.protocol !== 's3:' || !parsed.hostname || decodedPath === '/' || parsed.search || parsed.hash || decodedPath.split('/').includes('..')) {
    throw new Error(`${label} is invalid`)
  }
}

function scanTextArtifact(file) {
  const stat = fs.statSync(file)
  if (stat.size > 16 * 1024 * 1024) return { status: 'unknown-too-large', rawIpMatches: 0 }
  const content = fs.readFileSync(file, 'utf8')
  const matches = new Set(content.match(IPV4) ?? [])
  for (const token of content.match(IP_TOKEN) ?? []) {
    const candidate = token.replace(/^\[|\]$/gu, '').split('%')[0]
    if (candidate.includes(':') && net.isIP(candidate) === 6) matches.add(candidate)
  }
  return { status: matches.size === 0 ? 'pass' : 'raw-ip-found', rawIpMatches: matches.size }
}

function command(binary, args, { redact = [], env = process.env } = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0) {
    let detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim()
    for (const secret of redact) detail = detail.split(secret).join('[redacted]')
    throw new Error(`${path.basename(binary)} failed: ${detail}`)
  }
  return result
}

function redisInvocation(value) {
  const parsed = new URL(value)
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) throw new Error('Redis admin URL must use redis:// or rediss://')
  if (!parsed.hostname || parsed.search || parsed.hash) throw new Error('Redis admin URL has unsupported components')
  const database = parsed.pathname === '' || parsed.pathname === '/' ? '0' : parsed.pathname.slice(1)
  if (!/^\d+$/u.test(database)) throw new Error('Redis admin URL database must be numeric')
  const args = ['-h', parsed.hostname, '-p', parsed.port || (parsed.protocol === 'rediss:' ? '6380' : '6379'), '-n', database]
  if (parsed.protocol === 'rediss:') args.push('--tls')
  if (parsed.username) args.push('--user', decodeURIComponent(parsed.username))
  return {
    args,
    env: { ...process.env, ...(parsed.password ? { REDISCLI_AUTH: decodeURIComponent(parsed.password) } : {}) }
  }
}

function postgresInvocation(value) {
  const parsed = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('PostgreSQL admin URL must use postgresql://')
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/' || parsed.hash) throw new Error('PostgreSQL admin URL is incomplete')
  const allowedParameters = new Set(['sslmode'])
  for (const name of parsed.searchParams.keys()) {
    if (!allowedParameters.has(name)) throw new Error(`PostgreSQL admin URL parameter is unsupported: ${name}`)
  }
  return {
    env: {
      ...process.env,
      PGHOST: parsed.hostname,
      PGPORT: parsed.port || '5432',
      PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
      ...(parsed.username ? { PGUSER: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { PGPASSWORD: decodeURIComponent(parsed.password) } : {}),
      ...(parsed.searchParams.has('sslmode') ? { PGSSLMODE: parsed.searchParams.get('sslmode') } : {})
    }
  }
}

function baseReport(context, commandName, status, extra) {
  return {
    schema: REPORT_SCHEMA,
    status,
    command: commandName,
    generatedAtUtc: context.now.toISOString(),
    hostHash: opaqueHash(os.hostname()),
    cutoverAtUtc: context.inventory.cutoverAtUtc,
    inventoryId: context.inventory.inventoryId,
    ...extra
  }
}

function appendAudit(context, report) {
  const auditPath = resolveFrom(context.configDir, context.config.auditLog)
  fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 })
  if (fs.existsSync(auditPath)) {
    const stat = fs.lstatSync(auditPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('DSR audit log must be a regular non-symlink file')
  }
  const record = {
    schema: report.command.startsWith('dsr-') ? 'fsusblog.data-subject-right-audit.v1' : 'fsusblog.ip-anonymization-operation-audit.v1',
    occurredAtUtc: report.generatedAtUtc,
    action: report.command,
    outcome: report.status,
    requestRefHash: report.dataSubjectRequest?.requestRefHash ?? null,
    actorRefHash: context.options.actorRef ? opaqueHash(context.options.actorRef) : null,
    scope: report.dataSubjectRequest?.scope ?? 'cross-media-retention',
    result: report.dataSubjectRequest?.result ?? (report.status === 'pass' ? 'propagated' : 'incomplete'),
    accountLinkageUsed: false,
    evidencePathHash: opaqueHash(path.resolve(context.options.output))
  }
  fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  fs.chmodSync(auditPath, 0o600)
}

function writeEvidence(file, report) {
  const target = path.resolve(file)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const descriptor = fs.openSync(target, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function resolveFrom(baseDir, value) {
  return path.resolve(baseDir, value)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
}

function parseUtc(value, label) {
  const parsed = new Date(value)
  const expected = typeof value === 'string' && value.endsWith('Z') && !value.includes('.') ? value.replace(/Z$/u, '.000Z') : value
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value ?? '') || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== expected) {
    throw new Error(`${label} must be canonical UTC ISO-8601`)
  }
  return parsed
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function opaqueHash(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`
}
