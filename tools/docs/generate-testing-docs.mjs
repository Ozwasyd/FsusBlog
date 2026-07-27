#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { loadMatrix, relative, root } from './lib/matrix.mjs'
import { buildAggregatePlan, buildReceiptPlan } from '../test-matrix/aggregate-plan.mjs'

const groupDefinitions = [
  {
    title: 'Primary Release Tiers',
    match: (tier) => new Set([
      'validate-matrix',
      'frontend-build',
      'frontend-unit-shard',
      'frontend-runtime-contracts',
      'frontend-static-governance',
      'frontend-fast-summary',
      'backend-fast',
      'static-governance',
      'fast',
      'bootstrap',
      'integration',
      'ci',
      'release',
      'security',
      'frontend-render-structure',
      'resilience',
      'load',
      'release-evidence',
      'production-correctness',
      'production'
    ]).has(tier.id)
  },
  {
    title: 'Browser Release And Diagnostics',
    match: (tier) => tier.resourceClass === 'browser'
  },
  {
    title: 'Coverage Tiers',
    match: (tier) => tier.id.startsWith('coverage-')
  },
  {
    title: 'Backend Specialty Tiers',
    match: (tier) => tier.id.startsWith('backend-') || tier.id.startsWith('data-scale-') || tier.id === 'endpoint-depth'
  },
  {
    title: 'Cross-Stack And Fuzz Tiers',
    match: (tier) => ['cross-stack-contract', 'wasm-fuzz-regression', 'csrf-browser-matrix', 'security-authenticated-dast'].includes(tier.id)
  },
  {
    title: 'Performance And Resilience Depth Tiers',
    match: (tier) => tier.id.startsWith('load-') || tier.id.startsWith('aeds-') || [
      'backend-benchmark-regression',
      'browser-performance-regression',
      'fault-injection',
      'soak-short-runtime',
      'soak-long-scheduled',
      'soak-long-evidence-import',
      'ux-viewport-visual',
      'ux-viewport-boundaries'
    ].includes(tier.id)
  },
  {
    title: 'Manual Closeout Tiers',
    match: (tier) => tier.id === 'release-closeout'
  }
]

function cell(value) {
  return value
}

function evidenceCell(tier) {
  return tier.evidence.length > 0 ? tier.evidence.map((item) => `\`${item}\``).join('<br>') : '-'
}

function artifactsCell(tier) {
  return tier.artifacts.length > 0 ? tier.artifacts.map((item) => `\`${item}\``).join('<br>') : '-'
}

function localTierCommand(tier) {
  return `\`./tools/test.sh ci-tier ${tier.id}\``
}

function playwrightWorkersForTier(tier) {
  if (tier.id === 'browser-contract') return '1'
  return tier.requiresPlaywright === 'none' ? '-' : 'machine'
}

function tierSmartGateMode(tier) {
  if (tier.smartGateMode) return tier.smartGateMode
  if (tier.prDefault === true || tier.requiredFor === 'fast') return 'always'
  if (
    tier.localOnly === true
    || tier.nightlyOnly === true
    || tier.manualOnly === true
    || tier.cadence === 'nightly'
    || tier.cadence === 'release-manual'
    || tier.requiredFor === 'production'
    || tier.requiredFor === 'release-final'
  ) {
    return 'full-only'
  }
  return 'conditional'
}

function executionContractCell(tier) {
  const mode = tier.executionMode ?? 'execute'
  const fields = [`mode=${mode}`]
  if (mode === 'summary') {
    if (tier.summaryAuthority) fields.push(`authority=${tier.summaryAuthority}`)
    if (tier.summaryInputs?.length) fields.push(`receiptInputs=${tier.summaryInputs.join(',')}`)
  }
  if (mode === 'projection') {
    const producers = Array.isArray(tier.projectFrom) ? tier.projectFrom : [tier.projectFrom]
    fields.push(`canonicalProducer=${producers.filter(Boolean).join(',') || '-'}`)
  }
  if (tier.outputReceiptSchema) fields.push(`output=${tier.outputReceiptSchema}`)
  return fields.map((field) => `\`${field}\``).join('<br>')
}

function tierRow(tier) {
  return [
    `\`${tier.id}\``,
    `\`${tier.ciJob}\``,
    localTierCommand(tier),
    String(tier.phase),
    tier.risk,
    tier.cadence,
    tier.requiredFor,
    tier.evidenceClass ?? 'correctness',
    tierSmartGateMode(tier),
    tier.prDefault === true ? 'yes' : 'no',
    tier.retentionClass ?? '-',
    tier.triggerReason ?? '-',
    `${tier.resourceClass} cpu=${tier.cpuWeight} memory=${tier.memoryWeight} minCpu=${tier.minCpuUnits}`,
    tier.cost,
    tier.parallelizable ? 'machine' : 'serial',
    playwrightWorkersForTier(tier),
    tier.requiresBootstrap,
    tier.requiresNode ? 'yes' : 'no',
    tier.requiresDotnet ? 'yes' : 'no',
    tier.requiresPlaywright,
    tier.cacheProfile,
    executionContractCell(tier),
    (tier.executionDependsOn?.length ?? 0) > 0 ? tier.executionDependsOn.map((id) => `\`${id}\``).join(', ') : '-',
    (tier.requiresEvidenceFrom?.length ?? 0) > 0 ? tier.requiresEvidenceFrom.map((id) => `\`${id}\``).join(', ') : '-',
    tier.services.length > 0 ? tier.services.join(', ') : '-',
    tier.shardable ? 'machine' : 'single',
    `${tier.timeoutMinutes}m`,
    artifactsCell(tier),
    evidenceCell(tier)
  ].map(cell).join(' | ').replace(/^/u, '| ').replace(/$/u, ' |')
}

function tableFor(tiers) {
  const lines = [
    '| Tier | CI job | Local command | Phase | Risk | Cadence | Required for | Evidence class | Smart gate | PR default | Retention | Trigger reason | Resource weights | Cost | Parallelism | PW workers | Bootstrap | Node | .NET | Playwright | Cache | Execution evidence contract | Execution depends on | Evidence inputs | Services | Sharding | Timeout | Artifacts | Evidence |',
    '|---|---|---|---:|---|---|---|---|---|---|---|---|---|---|---:|---:|---|---|---|---|---|---|---|---|---|---:|---:|---|---|'
  ]
  for (const tier of tiers) {
    lines.push(tierRow(tier))
  }
  return lines
}

function isWorkflowTier(tier) {
  return tier.localOnly !== true && tier.nightlyOnly !== true && tier.manualOnly !== true
}

export function resolveCiJobExecution(matrix, job) {
  const matches = []
  for (const authority of Object.values(matrix.aggregateAuthorities ?? {})) {
    if (authority?.ciJob !== job.id) continue
    const plan = buildAggregatePlan(matrix, authority.id)
    if (plan.errors.length > 0) {
      throw new Error(`${job.id} aggregate authority ${authority.id} is invalid: ${plan.errors.join('; ')}`)
    }
    matches.push({
      mode: 'aggregate',
      authorityId: authority.id,
      command: `node tools/run-test-matrix.mjs aggregate ${authority.id}`
    })
  }
  const tierIds = new Set(job.tiers.map((tier) => tier.id))
  for (const authority of Object.values(matrix.receiptAuthorities ?? {})) {
    if (!(authority?.summaryTierIds ?? []).some((tierId) => tierIds.has(tierId))) continue
    const plan = buildReceiptPlan(matrix, authority.id, { root })
    if (plan.errors.length > 0) {
      throw new Error(`${job.id} receipt authority ${authority.id} is invalid: ${plan.errors.join('; ')}`)
    }
    matches.push({
      mode: 'receipt',
      authorityId: authority.id,
      command: authority.command
    })
  }
  if (matches.length > 1) {
    throw new Error(`${job.id} resolves multiple execution authorities: ${matches.map((entry) => entry.authorityId).join(', ')}`)
  }
  return matches[0] ?? {
    mode: 'test',
    authorityId: null,
    command: `./tools/test.sh ci-job ${job.id}`
  }
}

export function ciJobRows(matrix) {
  const combineCacheProfile = (left, right) => {
    const frontend = left === 'frontend' || left === 'full' || right === 'frontend' || right === 'full'
    const backend = left === 'backend' || left === 'full' || right === 'backend' || right === 'full'
    return frontend && backend ? 'full' : frontend ? 'frontend' : backend ? 'backend' : 'none'
  }
  const jobs = new Map()
  for (const tier of matrix.tiers.filter(isWorkflowTier)) {
    const job = jobs.get(tier.ciJob) ?? { id: tier.ciJob, tiers: [], timeoutMinutes: 0, shards: 1, requiresPlaywright: 'none', cacheProfile: 'none', evidenceClasses: new Set() }
    job.tiers.push(tier)
    job.timeoutMinutes = Math.max(job.timeoutMinutes, Number(tier.timeoutMinutes) || 0)
    job.dynamicShards = job.dynamicShards || tier.shardable === true
    job.phase = Math.max(job.phase ?? 0, Number(tier.phase) || 0)
    job.dynamicParallel = job.dynamicParallel || tier.parallelizable === true
    job.requiresNode = job.requiresNode || tier.requiresNode === true
    job.requiresDotnet = job.requiresDotnet || tier.requiresDotnet === true
    if (tier.requiresPlaywright === 'all') job.requiresPlaywright = 'all'
    else if (tier.requiresPlaywright === 'chromium' && job.requiresPlaywright === 'none') job.requiresPlaywright = 'chromium'
    job.cacheProfile = combineCacheProfile(job.cacheProfile, tier.cacheProfile)
    job.evidenceClasses.add(tier.evidenceClass ?? (tier.ciJob === 'browser-diagnostics' ? 'diagnostic' : 'correctness'))
    jobs.set(job.id, job)
  }

  const lines = [
    '| CI job | Execution | Local reproduction command | Matrix tiers | Evidence class | Phase | Setup/cache | PW workers | Max timeout | Sharding | Parallelism |',
    '|---|---|---|---|---|---:|---|---:|---:|---:|---:|'
  ]
  for (const job of [...jobs.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const execution = resolveCiJobExecution(matrix, job)
    lines.push([
      `\`${job.id}\``,
      `\`${execution.mode}\``,
      `\`${execution.command}\``,
      job.tiers.map((tier) => `\`${tier.id}\``).join(', '),
      [...job.evidenceClasses].sort().join(', '),
      String(job.phase ?? 0),
      [
        job.requiresNode ? 'node' : null,
        job.requiresDotnet ? 'dotnet' : null,
        job.requiresPlaywright !== 'none' ? `playwright:${job.requiresPlaywright}` : null,
        job.cacheProfile !== 'none' ? `cache:${job.cacheProfile}` : null
      ].filter(Boolean).join(', ') || 'none',
      job.id === 'browser-contract' ? '1' : job.requiresPlaywright === 'none' ? '-' : 'machine',
      `${job.timeoutMinutes}m`,
      job.dynamicShards ? 'machine' : 'single',
      job.dynamicParallel ? 'machine' : 'serial'
    ].join(' | ').replace(/^/u, '| ').replace(/$/u, ' |'))
  }
  return lines
}

export function renderTestingDocs(matrix) {
  const assigned = new Set()
  const sections = []

  for (const group of groupDefinitions) {
    const tiers = matrix.tiers.filter((tier) => !assigned.has(tier.id) && group.match(tier))
    if (tiers.length === 0) continue
    for (const tier of tiers) assigned.add(tier.id)
    sections.push(`## ${group.title}`)
    sections.push('')
    sections.push(...tableFor(tiers))
    sections.push('')
  }

  const remaining = matrix.tiers.filter((tier) => !assigned.has(tier.id))
  if (remaining.length > 0) {
    sections.push('## Other Governed Tiers')
    sections.push('')
    sections.push(...tableFor(remaining))
    sections.push('')
  }

  sections.push('## CI Job Reproduction Commands')
  sections.push('')
  sections.push(...ciJobRows(matrix))
  sections.push('')

  return [
    '# Generated Test Matrix',
    '',
    '<!-- generated by tools/docs/generate-testing-docs.mjs; do not edit by hand -->',
    '',
    `Version: \`${matrix.version}\``,
    '',
    ...sections
  ].join('\n').replace(/\n+$/u, '\n')
}

function writeSummary(status, outFile, errors = []) {
  const summaryFile = path.join(path.resolve(process.env.FSUSBLOG_DOCS_EVIDENCE_DIR || path.join(root, '.tmp/docs')), 'generated-testing-docs.json')
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true })
  fs.writeFileSync(summaryFile, `${JSON.stringify({
    status,
    generatedAt: new Date().toISOString(),
    source: 'tests/matrix.yml',
    output: relative(outFile),
    errors
  }, null, 2)}\n`)
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
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const outFile = path.resolve(root, optionValue(args, 'out', 'docs/testing.generated.md'))
  const rendered = renderTestingDocs(loadMatrix())
  if (/\b(?:undefined|NaN)\b/u.test(rendered)) {
    throw new Error('generated testing docs contain an unresolved dynamic value')
  }

  if (check) {
    const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
    if (current !== rendered) {
      const error = `${relative(outFile)} is not in sync with tests/matrix.yml`
      writeSummary('failed', outFile, [error])
      console.error(`[testing-docs] ${error}`)
      process.exit(1)
    }
    writeSummary('ok', outFile)
    console.log(`[testing-docs] ok ${relative(outFile)}`)
    return
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, rendered)
  writeSummary('ok', outFile)
  console.log(`[testing-docs] wrote ${relative(outFile)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
