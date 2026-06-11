#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const matrixFile = path.join(root, 'tests/matrix.yml')
const schemaFile = path.join(root, 'tests/matrix.schema.json')
const preflightLogFile = path.join(root, '.tmp/gate-logs/preflight.json')
const aliases = new Map([
  ['coverage', 'coverage-gate'],
  ['backend-qps-runtime', 'backend-qps'],
  ['endpoint-depth-matrix-generate', 'endpoint-depth'],
  ['endpoint-depth-runtime-smoke', 'endpoint-depth'],
  ['endpoint-depth-runtime-full', 'endpoint-depth']
])

const requiredFields = [
  'id',
  'owner',
  'command',
  'dependsOn',
  'services',
  'parallelizable',
  'exclusiveResources',
  'phase',
  'cost',
  'resourceClass',
  'maxParallel',
  'requiresBootstrap',
  'timeoutMinutes',
  'shardable',
  'defaultShards',
  'risk',
  'coverage',
  'artifacts',
  'evidence',
  'ciJob',
  'localOnly',
  'nightlyOnly'
]

function parseValue(raw) {
  const value = String(raw ?? '').trim()
  if (value === '[]') return []
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((item) => parseValue(item))
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function parseMatrix(text) {
  const matrix = { tiers: [] }
  let current = null
  let inTiers = false

  for (const rawLine of text.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '')
    if (!withoutComment.trim()) continue

    const topMatch = withoutComment.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (topMatch && !rawLine.startsWith(' ')) {
      const [, key, value] = topMatch
      if (key === 'tiers') {
        inTiers = true
        current = null
        continue
      }
      matrix[key] = parseValue(value)
      continue
    }

    if (!inTiers) continue

    const itemMatch = withoutComment.match(/^\s{2}-\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (itemMatch) {
      current = {}
      matrix.tiers.push(current)
      current[itemMatch[1]] = parseValue(itemMatch[2])
      continue
    }

    const fieldMatch = withoutComment.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (fieldMatch && current) {
      current[fieldMatch[1]] = parseValue(fieldMatch[2])
    }
  }

  return matrix
}

function loadMatrix() {
  if (!fs.existsSync(matrixFile)) {
    throw new Error(`missing ${path.relative(root, matrixFile)}`)
  }
  return parseMatrix(fs.readFileSync(matrixFile, 'utf8'))
}

function relativeToRoot(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/')
}

function tierMap(matrix) {
  return new Map(matrix.tiers.map((tier) => [tier.id, tier]))
}

function normalizeTierId(id) {
  return aliases.get(id) ?? id
}

function pathExistsForCommand(command) {
  const [first] = String(command).split(/\s+/)
  if (!first || !/^(tools|tests|src|\.\/tools|\.\/tests|\.\/src)\//.test(first)) return true
  const rel = first.replace(/^\.\//, '')
  return fs.existsSync(path.join(root, rel))
}

function isExecutableCommand(command) {
  const [first] = String(command).split(/\s+/)
  if (!first || !/^(tools|tests|src|\.\/tools|\.\/tests|\.\/src)\//.test(first)) return true
  const rel = first.replace(/^\.\//, '')
  try {
    return (fs.statSync(path.join(root, rel)).mode & 0o111) !== 0
  } catch {
    return false
  }
}

function validateMatrix(matrix) {
  const errors = []
  const ids = new Set()
  const byId = tierMap(matrix)

  if (matrix.version !== 'fsusblog-test-matrix-v2') {
    errors.push(`version must be fsusblog-test-matrix-v2, got ${matrix.version ?? 'missing'}`)
  }
  if (!fs.existsSync(schemaFile)) {
    errors.push('missing tests/matrix.schema.json')
  }
  if (!Array.isArray(matrix.tiers) || matrix.tiers.length === 0) {
    errors.push('tiers must be a non-empty list')
  }

  for (const tier of matrix.tiers) {
    if (!tier.id) {
      errors.push('tier missing id')
      continue
    }
    if (ids.has(tier.id)) errors.push(`duplicate tier id: ${tier.id}`)
    ids.add(tier.id)

    for (const field of requiredFields) {
      if (!(field in tier)) errors.push(`${tier.id} missing ${field}`)
    }
    for (const field of ['dependsOn', 'services', 'exclusiveResources', 'coverage', 'artifacts', 'evidence']) {
      if (!Array.isArray(tier[field])) errors.push(`${tier.id}.${field} must be an array`)
    }
    for (const field of ['parallelizable', 'shardable', 'localOnly', 'nightlyOnly']) {
      if (typeof tier[field] !== 'boolean') errors.push(`${tier.id}.${field} must be boolean`)
    }
    if ('manualOnly' in tier && typeof tier.manualOnly !== 'boolean') {
      errors.push(`${tier.id}.manualOnly must be boolean`)
    }
    for (const field of ['timeoutMinutes', 'defaultShards', 'maxParallel']) {
      if (typeof tier[field] !== 'number' || tier[field] < 1) errors.push(`${tier.id}.${field} must be a positive number`)
    }
    if (typeof tier.phase === 'number' && tier.phase < 0) errors.push(`${tier.id}.phase must be zero or greater`)
    if (!['low', 'medium', 'high', 'critical'].includes(tier.risk)) {
      errors.push(`${tier.id}.risk is invalid: ${tier.risk}`)
    }
    if (!['low', 'medium', 'high', 'very-high'].includes(tier.cost)) {
      errors.push(`${tier.id}.cost is invalid: ${tier.cost}`)
    }
    if (!['cpu', 'io', 'browser', 'network', 'benchmark', 'database'].includes(tier.resourceClass)) {
      errors.push(`${tier.id}.resourceClass is invalid: ${tier.resourceClass}`)
    }
    if (!['none', 'frontend', 'backend', 'full'].includes(tier.requiresBootstrap)) {
      errors.push(`${tier.id}.requiresBootstrap is invalid: ${tier.requiresBootstrap}`)
    }
    if (tier.parallelizable === false && Number(tier.maxParallel) !== 1) {
      errors.push(`${tier.id} is not parallelizable but maxParallel is ${tier.maxParallel}`)
    }
    for (const dep of tier.dependsOn ?? []) {
      if (!byId.has(dep)) errors.push(`${tier.id} depends on missing tier ${dep}`)
    }
    if (!pathExistsForCommand(tier.command)) {
      errors.push(`${tier.id} command path does not exist: ${tier.command}`)
    } else if (!isExecutableCommand(tier.command)) {
      errors.push(`${tier.id} command path is not executable: ${tier.command}`)
    }
    if (tier.shardable === false && Number(tier.defaultShards) !== 1) {
      errors.push(`${tier.id} is not shardable but defaultShards is ${tier.defaultShards}`)
    }
  }

  const visiting = new Set()
  const visited = new Set()
  function visit(id, stack = []) {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      errors.push(`cycle detected: ${[...stack, id].join(' -> ')}`)
      return
    }
    visiting.add(id)
    const tier = byId.get(id)
    for (const dep of tier?.dependsOn ?? []) visit(dep, [...stack, id])
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of ids) visit(id)

  return errors
}

function planTier(matrix, requestedId) {
  const byId = tierMap(matrix)
  const targetId = normalizeTierId(requestedId)
  if (!byId.has(targetId)) throw new Error(`unknown tier: ${requestedId}`)

  const planned = []
  const visited = new Set()

  function visit(id) {
    if (visited.has(id)) return
    const tier = byId.get(id)
    if (!tier) throw new Error(`missing dependency: ${id}`)
    for (const dep of tier.dependsOn) visit(dep)
    visited.add(id)
    planned.push(tier)
  }

  visit(targetId)
  return planned
}

function printPlan(tiers) {
  for (const [index, tier] of tiers.entries()) {
    const deps = tier.dependsOn.length > 0 ? ` deps=${tier.dependsOn.join(',')}` : ''
    const shard = tier.shardable ? ` shards=${tier.defaultShards}` : ''
    console.log(`${index + 1}. ${tier.id} [job=${tier.ciJob} phase=${tier.phase} resource=${tier.resourceClass} cost=${tier.cost} timeout=${tier.timeoutMinutes}m risk=${tier.risk}${shard}]${deps}`)
    console.log(`   ${tier.command}`)
  }
}

function namespaceFor(tier, shard) {
  if (process.env.FSUSBLOG_TEST_NAMESPACE) return namespaceSlug(process.env.FSUSBLOG_TEST_NAMESPACE)
  const runId = process.env.GITHUB_RUN_ID || 'local'
  const attempt = process.env.GITHUB_RUN_ATTEMPT || '0'
  const job = process.env.MATRIX_JOB || tier.ciJob || tier.id
  const shardValue = shard ?? process.env.MATRIX_SHARD ?? '0'
  return namespaceSlug(`${runId}-${attempt}-${job}-${shardValue}`)
}

function namespaceSlug(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '-')
}

function loadNamespaceEnv(namespace) {
  const envFile = path.join(root, '.tmp/env', `${namespaceSlug(namespace)}.env`)
  if (!fs.existsSync(envFile)) return {}
  const values = {}
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    values[match[1]] = match[2]
  }
  return values
}

function parseRunOptions(args) {
  const options = { planOnly: false, shard: null, noDeps: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--plan-only') options.planOnly = true
    else if (arg === '--no-deps') options.noDeps = true
    else if (arg === '--shard') options.shard = args[++index]
    else if (arg.startsWith('--shard=')) options.shard = arg.slice('--shard='.length)
    else throw new Error(`unknown run option: ${arg}`)
  }
  return options
}

function tierReproductionCommand(tier, options = {}) {
  const args = [`./tools/test.sh ci-tier ${tier.id}`]
  if (options.noDeps) args.push('--no-deps')
  if (options.shard) args.push(`--shard ${options.shard}`)
  return args.join(' ')
}

function ciJobReproductionCommand(jobId) {
  return `./tools/test.sh ci-job ${jobId}`
}

function jobSummaryPath(jobId) {
  return path.join(root, '.tmp/release-evidence/jobs', `${jobId}.json`)
}

function readExistingJobSummary(jobId) {
  const file = jobSummaryPath(jobId)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJobSummary(matrix, tier, status, startedAt, details = {}) {
  const jobId = details.jobId ?? tier.ciJob
  const existing = readExistingJobSummary(jobId)
  const jobTiers = matrix.tiers
    .filter((item) => item.ciJob === tier.ciJob && item.localOnly !== true && item.nightlyOnly !== true && item.manualOnly !== true)
    .map((item) => item.id)
  const tierIds = [...new Set([...(existing?.tierIds ?? []), ...jobTiers.filter((id) => id === tier.id), tier.id])].filter(Boolean)
  const artifacts = [...new Set([
    ...(existing?.artifacts ?? []),
    ...(tier.artifacts ?? []),
    ...(tier.evidence ?? []).filter((item) => String(item).startsWith('.tmp/'))
  ])].sort()
  const durationMs = Math.max(0, Number(existing?.durationMs ?? 0)) + Math.max(0, Date.now() - startedAt)
  const summary = {
    schema: 'fsusblog.ci.job-result.v1',
    jobId,
    ciJob: tier.ciJob,
    tierIds,
    status,
    failureStage: status === 'success' ? null : (details.failureStage ?? tier.id),
    rootCause: status === 'success' ? null : (details.rootCause ?? `${tier.id} exited non-zero`),
    durationMs,
    artifacts,
    localReproduction: ciJobReproductionCommand(tier.ciJob),
    commit: git(['rev-parse', 'HEAD']) ?? 'unknown',
    runId: process.env.GITHUB_RUN_ID ?? 'local',
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? '0',
    generatedAt: new Date().toISOString()
  }
  const outFile = jobSummaryPath(jobId)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
}

function emitTierReproductionHint(tier, options) {
  console.error(`[matrix:${tier.id}] To reproduce tier locally: ${tierReproductionCommand(tier, options)}`)
  console.error(`[matrix:${tier.id}] To reproduce CI job locally: ${ciJobReproductionCommand(tier.ciJob)}`)
}

function runTier(matrix, tierId, args) {
  const options = parseRunOptions(args)
  const all = options.noDeps ? [tierMap(matrix).get(normalizeTierId(tierId))] : planTier(matrix, tierId)
  if (all.some((tier) => !tier)) throw new Error(`unknown tier: ${tierId}`)

  if (options.shard) {
    const target = all[all.length - 1]
    if (!target.shardable) throw new Error(`${target.id} is not shardable`)
    if (!/^\d+\/\d+$/.test(options.shard)) throw new Error('--shard must use i/n format')
  }

  if (options.planOnly) {
    printPlan(all)
    return
  }

  const target = all[all.length - 1]
  const runNamespace = namespaceFor(target, options.shard)

  for (const tier of all) {
    const startedAt = Date.now()
    const namespaceEnv = loadNamespaceEnv(runNamespace)
    const env = {
      ...process.env,
      ...namespaceEnv,
      CURRENT_TIER: tier.id,
      MATRIX_JOB: tier.ciJob,
      FSUSBLOG_TEST_NAMESPACE: runNamespace
    }
    if (options.shard) {
      const [index, total] = options.shard.split('/')
      env.MATRIX_SHARD = options.shard
      env.FSUSBLOG_TEST_SHARD_INDEX = index
      env.FSUSBLOG_TEST_SHARD_TOTAL = total
    }

    emitTierReproductionHint(tier, options)
    console.error(`[matrix:${tier.id}] ${tier.command}`)
    const result = spawnSync(tier.command, {
      cwd: root,
      env,
      shell: true,
      stdio: 'inherit'
    })
    if (result.status !== 0) {
      writeJobSummary(matrix, tier, 'failure', startedAt, {
        failureStage: tier.id,
        rootCause: `${tier.command} exited ${result.status ?? 1}`
      })
      process.exit(result.status ?? 1)
    }
    writeJobSummary(matrix, tier, 'success', startedAt)
  }
}

function parseCiJobOptions(args) {
  const options = { planOnly: false, shard: null }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--plan-only') options.planOnly = true
    else if (arg === '--shard') options.shard = args[++index]
    else if (arg.startsWith('--shard=')) options.shard = arg.slice('--shard='.length)
    else throw new Error(`unknown ci-job option: ${arg}`)
  }
  return options
}

function ciJobTiers(matrix, jobId) {
  return matrix.tiers.filter((tier) => tier.ciJob === jobId && tier.localOnly !== true && tier.nightlyOnly !== true && tier.manualOnly !== true)
}

function printCiJobPlan(matrix, jobId) {
  const tiers = ciJobTiers(matrix, jobId)
  if (tiers.length === 0) throw new Error(`unknown CI job or no required tiers: ${jobId}`)
  console.log(`To reproduce GitHub Actions job "${jobId}" locally:`)
  console.log(`  ${ciJobReproductionCommand(jobId)}`)
  console.log('')
  for (const tier of tiers) {
    const shard = tier.shardable ? ` --shard 1/${tier.defaultShards}` : ''
    console.log(`- ${tier.id}: ${tierReproductionCommand(tier, { noDeps: true })}${shard}`)
    console.log(`  matrix command: ${tier.command}`)
  }
}

function runCiJob(matrix, jobId, args) {
  const options = parseCiJobOptions(args)
  const tiers = ciJobTiers(matrix, jobId)
  if (tiers.length === 0) throw new Error(`unknown CI job or no required tiers: ${jobId}`)
  if (options.planOnly) {
    printCiJobPlan(matrix, jobId)
    return
  }

  for (const tier of tiers) {
    const runArgs = ['--no-deps']
    if (options.shard && tier.shardable) runArgs.push('--shard', options.shard)
    runTier(matrix, tier.id, runArgs)
  }
}

function listTiers(matrix) {
  for (const tier of matrix.tiers) {
    const tags = [
      `job=${tier.ciJob}`,
      `risk=${tier.risk}`,
      tier.parallelizable ? 'parallel' : 'serial',
      tier.shardable ? `shardable:${tier.defaultShards}` : 'single'
    ]
    console.log(`${tier.id}\t${tags.join(' ')}`)
  }
}

function ensureOutputDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function writeTextOutput(text, outFile, label) {
  if (!outFile) {
    process.stdout.write(text)
    return
  }

  const abs = path.resolve(root, outFile)
  ensureOutputDirectory(abs)
  fs.writeFileSync(abs, text)
  console.log(`[${label}] wrote ${relativeToRoot(abs)}`)
}

function buildCiPlan(matrix, format) {
  const jobs = new Map()
  for (const tier of matrix.tiers) {
    const job = jobs.get(tier.ciJob) ?? {
      id: tier.ciJob,
      tiers: [],
      timeoutMinutes: 0,
      needs: new Set(),
      artifacts: new Set(),
      evidence: new Set()
    }
      job.tiers.push(tier.id)
      job.timeoutMinutes = Math.max(job.timeoutMinutes, tier.timeoutMinutes)
      job.phase = Math.max(job.phase ?? 0, tier.phase)
      job.maxParallel = Math.max(job.maxParallel ?? 1, tier.maxParallel)
    for (const artifact of tier.artifacts) job.artifacts.add(artifact)
    for (const evidence of tier.evidence) job.evidence.add(evidence)
    jobs.set(tier.ciJob, job)
  }
  const byId = tierMap(matrix)
  for (const tier of matrix.tiers) {
    const job = jobs.get(tier.ciJob)
    for (const dep of tier.dependsOn) {
      const depJob = byId.get(dep)?.ciJob
      if (depJob && depJob !== tier.ciJob) job.needs.add(depJob)
    }
  }
  return {
    format,
    generatedAt: new Date().toISOString(),
    jobs: [...jobs.values()].map((job) => ({
      id: job.id,
      tiers: job.tiers,
      timeoutMinutes: job.timeoutMinutes,
      phase: job.phase ?? 0,
      maxParallel: job.maxParallel ?? 1,
      needs: [...job.needs].sort(),
      artifacts: [...job.artifacts].sort(),
      evidence: [...job.evidence].sort()
    })).sort((a, b) => a.id.localeCompare(b.id))
  }
}

function ciPlan(matrix, format, outFile) {
  writeTextOutput(`${JSON.stringify(buildCiPlan(matrix, format), null, 2)}\n`, outFile, 'matrix:ci-plan')
}

function docs(matrix, outFile) {
  const lines = [
    '# Generated Test Matrix',
    '',
    '<!-- generated by tools/run-test-matrix.mjs docs; do not edit by hand -->',
    '',
    `Version: \`${matrix.version}\``,
    '',
    '| Tier | CI job | Local command | Phase | Resource | Cost | Max parallel | Depends on | Services | Shards | Timeout | Artifacts | Evidence |',
    '|---|---|---|---:|---|---|---:|---|---|---:|---:|---|---|'
  ]
  for (const tier of matrix.tiers) {
    lines.push([
      `\`${tier.id}\``,
      `\`${tier.ciJob}\``,
      `\`./tools/test.sh ci-tier ${tier.id}\``,
      String(tier.phase),
      tier.resourceClass,
      tier.cost,
      String(tier.maxParallel),
      tier.dependsOn.length > 0 ? tier.dependsOn.map((id) => `\`${id}\``).join(', ') : '-',
      tier.services.length > 0 ? tier.services.join(', ') : '-',
      tier.shardable ? String(tier.defaultShards) : '1',
      `${tier.timeoutMinutes}m`,
      tier.artifacts.length > 0 ? tier.artifacts.map((item) => `\`${item}\``).join('<br>') : '-',
      tier.evidence.length > 0 ? tier.evidence.map((item) => `\`${item}\``).join('<br>') : '-'
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }
  const jobs = new Map()
  for (const tier of matrix.tiers.filter((item) => item.localOnly !== true && item.nightlyOnly !== true && item.manualOnly !== true)) {
    const job = jobs.get(tier.ciJob) ?? []
    job.push(tier.id)
    jobs.set(tier.ciJob, job)
  }
  lines.push('')
  lines.push('## CI Job Reproduction Commands')
  lines.push('')
  lines.push('| CI job | Local reproduction command | Matrix tiers |')
  lines.push('|---|---|---|')
  for (const [jobId, tiers] of [...jobs.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`| \`${jobId}\` | \`./tools/test.sh ci-job ${jobId}\` | ${tiers.map((id) => `\`${id}\``).join(', ')} |`)
  }
  lines.push('')
  const text = `${lines.join('\n')}\n`
  writeTextOutput(text, outFile, 'matrix:docs')
}

function evidencePlan(matrix, outFile) {
  const plan = {
    schema: 'fsusblog.release-evidence.test-plan.v1',
    generatedAt: new Date().toISOString(),
    commit: git(['rev-parse', 'HEAD']),
    namespace: process.env.FSUSBLOG_TEST_NAMESPACE ?? null,
    tiers: matrix.tiers.map((tier) => ({
      id: tier.id,
      ciJob: tier.ciJob,
      command: tier.command,
      dependsOn: tier.dependsOn,
      timeoutMinutes: tier.timeoutMinutes,
      phase: tier.phase,
      cost: tier.cost,
      resourceClass: tier.resourceClass,
      maxParallel: tier.maxParallel,
      requiresBootstrap: tier.requiresBootstrap,
      shardable: tier.shardable,
      defaultShards: tier.defaultShards,
      artifacts: tier.artifacts,
      evidence: tier.evidence,
      risk: tier.risk,
      nightlyOnly: tier.nightlyOnly
    }))
  }
  const abs = path.resolve(root, outFile ?? '.tmp/release-evidence/test-plan.json')
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `${JSON.stringify(plan, null, 2)}\n`)
  console.log(`[matrix:evidence] wrote ${path.relative(root, abs)}`)
}

function preflight(matrix) {
  const checkedDirectories = [
    '.tmp',
    '.tmp/release-evidence',
    '.tmp/gate-logs',
    '.tmp/env',
    '.tmp/docs'
  ]
  const checkedFiles = [
    'tests/matrix.yml',
    'tests/matrix.schema.json',
    '.github/workflows/quality-gate.yml',
    'tools/run-test-matrix.mjs',
    'tools/check-workflow-matrix-sync.mjs',
    'tools/test.sh'
  ]
  const errors = []

  for (const rel of checkedDirectories) {
    const abs = path.join(root, rel)
    try {
      fs.mkdirSync(abs, { recursive: true })
      fs.accessSync(abs, fs.constants.W_OK)
    } catch (error) {
      errors.push(`${rel} is not writable: ${error.message}`)
    }
  }

  for (const rel of checkedFiles) {
    if (!fs.existsSync(path.join(root, rel))) {
      errors.push(`missing required file: ${rel}`)
    }
  }

  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
    errors.push(`Node.js 20 or newer is required, got ${process.versions.node}`)
  }

  const gitRoot = git(['rev-parse', '--show-toplevel'])
  if (!gitRoot) {
    errors.push('git metadata is unavailable; run from a checked-out repository')
  } else if (path.resolve(gitRoot) !== root) {
    errors.push(`git root mismatch: expected ${root}, got ${gitRoot}`)
  }

  for (const matrixError of validateMatrix(matrix)) {
    errors.push(`matrix validation: ${matrixError}`)
  }

  const writeChecks = [
    '.tmp/ci-plan.json',
    '.tmp/release-evidence/test-plan.json',
    '.tmp/gate-logs/preflight.json'
  ]
  for (const rel of writeChecks) {
    const abs = path.join(root, rel)
    try {
      ensureOutputDirectory(abs)
      const probe = `${abs}.write-check`
      fs.writeFileSync(probe, 'ok\n')
      fs.unlinkSync(probe)
    } catch (error) {
      errors.push(`cannot write ${rel}: ${error.message}`)
    }
  }

  const log = {
    schema: 'fsusblog.ci-preflight.v1',
    generatedAt: new Date().toISOString(),
    ok: errors.length === 0,
    node: process.versions.node,
    gitHead: git(['rev-parse', 'HEAD']),
    checkedDirectories,
    checkedFiles,
    writeChecks,
    errors
  }

  try {
    ensureOutputDirectory(preflightLogFile)
    fs.writeFileSync(preflightLogFile, `${JSON.stringify(log, null, 2)}\n`)
  } catch (error) {
    errors.push(`cannot write ${relativeToRoot(preflightLogFile)}: ${error.message}`)
  }

  if (errors.length > 0) {
    writeJobSummary(matrix, tierMap(matrix).get('validate-matrix'), 'failure', Date.now(), {
      failureStage: 'preflight',
      rootCause: errors[0],
      jobId: 'validate-matrix'
    })
    for (const error of errors) console.error(`[matrix:preflight] ${error}`)
    process.exit(1)
  }

  writeJobSummary(matrix, tierMap(matrix).get('validate-matrix'), 'success', Date.now(), {
    failureStage: null,
    rootCause: null,
    jobId: 'validate-matrix'
  })
  console.log(`[matrix:preflight] ok (${checkedDirectories.length} directories, ${checkedFiles.length} files)`)
  console.log(`[matrix:preflight] wrote ${relativeToRoot(preflightLogFile)}`)
  console.log('[matrix:preflight] To reproduce locally: ./tools/test.sh ci-tier validate-matrix')
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function usage() {
  console.log(`Usage:
  node tools/run-test-matrix.mjs validate
  node tools/run-test-matrix.mjs preflight
  node tools/run-test-matrix.mjs list
  node tools/run-test-matrix.mjs plan <tier>
  node tools/run-test-matrix.mjs run <tier> [--plan-only] [--no-deps] [--shard i/n]
  node tools/run-test-matrix.mjs ci-tier <tier> [--plan-only] [--no-deps] [--shard i/n]
  node tools/run-test-matrix.mjs ci-job <job> [--plan-only] [--shard i/n]
  node tools/run-test-matrix.mjs ci-fast [--plan-only]
  node tools/run-test-matrix.mjs ci-production [--plan-only]
  node tools/run-test-matrix.mjs ci-plan [--format github-actions] [--out .tmp/ci-plan.json]
  node tools/run-test-matrix.mjs docs [--out docs/testing.generated.md]
  node tools/run-test-matrix.mjs evidence-plan [--out .tmp/release-evidence/test-plan.json]

Compatibility:
  ./tools/test.sh <tier> delegates to "run <tier>".
  "./tools/test.sh production --plan-only" prints the DAG without executing it.
  "./tools/test.sh production" is the production-ci-gate: release evidence may be schema-valid collected-blocked.
  "./tools/test.sh release-closeout" is the release-closeout-gate: it requires check-release-evidence-manifest.mjs --require-ok.
`)
}

function optionValue(args, name, fallback = null) {
  const flag = `--${name}`
  const inline = args.find((arg) => arg.startsWith(`${flag}=`))
  if (inline) return inline.slice(flag.length + 1)
  const index = args.indexOf(flag)
  if (index >= 0) return args[index + 1]
  return fallback
}

function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage()
    return
  }

  const matrix = loadMatrix()
  if (command === 'validate') {
    const errors = validateMatrix(matrix)
    if (errors.length > 0) {
      for (const error of errors) console.error(`[matrix] ${error}`)
      process.exit(1)
    }
    console.log(`[matrix] ok (${matrix.tiers.length} tiers)`)
    return
  }
  if (command === 'preflight') {
    preflight(matrix)
    return
  }
  if (command === 'list') {
    listTiers(matrix)
    return
  }
  if (command === 'plan') {
    printPlan(planTier(matrix, args[0]))
    return
  }
  if (command === 'run') {
    runTier(matrix, args[0], args.slice(1))
    return
  }
  if (command === 'ci-tier') {
    runTier(matrix, args[0], args.slice(1))
    return
  }
  if (command === 'ci-job') {
    runCiJob(matrix, args[0], args.slice(1))
    return
  }
  if (command === 'ci-fast') {
    runTier(matrix, 'fast', args)
    return
  }
  if (command === 'ci-production') {
    runTier(matrix, 'production', args)
    return
  }
  if (command === 'ci-plan') {
    ciPlan(matrix, optionValue(args, 'format', 'json'), optionValue(args, 'out'))
    return
  }
  if (command === 'docs') {
    docs(matrix, optionValue(args, 'out'))
    return
  }
  if (command === 'evidence-plan') {
    evidencePlan(matrix, optionValue(args, 'out'))
    return
  }

  throw new Error(`unknown command: ${command}`)
}

try {
  main()
} catch (error) {
  console.error(`[matrix] ${error.message}`)
  process.exit(1)
}
