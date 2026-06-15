#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { loadMatrix, relative, root } from './lib/matrix.mjs'

const groupDefinitions = [
  {
    title: 'Primary Release Tiers',
    match: (tier) => new Set([
      'validate-matrix',
      'frontend-fast',
      'backend-fast',
      'static-governance',
      'fast',
      'bootstrap',
      'integration',
      'ci',
      'release',
      'security',
      'acceptance',
      'visual',
      'ux-viewport-smoke',
      'frontend-render-pressure',
      'cross-browser-smoke',
      'resilience',
      'load',
      'release-evidence',
      'production'
    ]).has(tier.id)
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
    match: (tier) => ['cross-stack-contract', 'contract-fuzz', 'wasm-fuzz-regression', 'csrf-browser-matrix', 'security-authenticated-dast'].includes(tier.id)
  },
  {
    title: 'Performance And Resilience Depth Tiers',
    match: (tier) => tier.id.startsWith('load-') || tier.id.startsWith('aeds-') || [
      'backend-benchmark-regression',
      'browser-performance-regression',
      'fault-injection',
      'soak',
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
  return tier.requiresPlaywright === 'none' ? '-' : String(tier.playwrightWorkers)
}

function tierRow(tier) {
  return [
    `\`${tier.id}\``,
    `\`${tier.ciJob}\``,
    localTierCommand(tier),
    String(tier.phase),
    tier.resourceClass,
    tier.cost,
    String(tier.maxParallel),
    playwrightWorkersForTier(tier),
    tier.requiresBootstrap,
    tier.requiresNode ? 'yes' : 'no',
    tier.requiresDotnet ? 'yes' : 'no',
    tier.requiresPlaywright,
    tier.cacheProfile,
    tier.dependsOn.length > 0 ? tier.dependsOn.map((id) => `\`${id}\``).join(', ') : '-',
    tier.services.length > 0 ? tier.services.join(', ') : '-',
    tier.shardable ? String(tier.defaultShards) : '1',
    `${tier.timeoutMinutes}m`,
    artifactsCell(tier),
    evidenceCell(tier)
  ].map(cell).join(' | ').replace(/^/u, '| ').replace(/$/u, ' |')
}

function tableFor(tiers) {
  const lines = [
    '| Tier | CI job | Local command | Phase | Resource | Cost | Max parallel | PW workers | Bootstrap | Node | .NET | Playwright | Cache | Depends on | Services | Shards | Timeout | Artifacts | Evidence |',
    '|---|---|---|---:|---|---|---:|---:|---|---|---|---|---|---|---|---:|---:|---|---|'
  ]
  for (const tier of tiers) {
    lines.push(tierRow(tier))
  }
  return lines
}

function isWorkflowTier(tier) {
  return tier.localOnly !== true && tier.nightlyOnly !== true && tier.manualOnly !== true
}

function ciJobExecutionMode(job) {
  if (
    job.id === 'fast-summary'
    &&
    job.tiers.length > 0
    && job.tiers.every((tier) => String(tier.command).startsWith('tools/test/lanes/noop.sh '))
    && job.tiers.some((tier) => (tier.dependsOn?.length ?? 0) > 0)
  ) {
    return 'aggregate'
  }
  return 'test'
}

function ciJobReproductionCommand(job) {
  if (ciJobExecutionMode(job) === 'aggregate') return `node tools/run-test-matrix.mjs aggregate ${job.id}`
  return `./tools/test.sh ci-job ${job.id}`
}

function ciJobRows(matrix) {
  const combineCacheProfile = (left, right) => {
    const frontend = left === 'frontend' || left === 'full' || right === 'frontend' || right === 'full'
    const backend = left === 'backend' || left === 'full' || right === 'backend' || right === 'full'
    return frontend && backend ? 'full' : frontend ? 'frontend' : backend ? 'backend' : 'none'
  }
  const jobs = new Map()
  for (const tier of matrix.tiers.filter(isWorkflowTier)) {
    const job = jobs.get(tier.ciJob) ?? { id: tier.ciJob, tiers: [], timeoutMinutes: 0, shards: 1, requiresPlaywright: 'none', playwrightWorkerValues: new Set(), cacheProfile: 'none' }
    job.tiers.push(tier)
    job.timeoutMinutes = Math.max(job.timeoutMinutes, Number(tier.timeoutMinutes) || 0)
    job.shards = Math.max(job.shards, tier.shardable ? Number(tier.defaultShards) || 1 : 1)
    job.phase = Math.max(job.phase ?? 0, Number(tier.phase) || 0)
    job.maxParallel = Math.max(job.maxParallel ?? 1, Number(tier.maxParallel) || 1)
    job.requiresNode = job.requiresNode || tier.requiresNode === true
    job.requiresDotnet = job.requiresDotnet || tier.requiresDotnet === true
    if (tier.requiresPlaywright === 'all') job.requiresPlaywright = 'all'
    else if (tier.requiresPlaywright === 'chromium' && job.requiresPlaywright === 'none') job.requiresPlaywright = 'chromium'
    if (tier.requiresPlaywright !== 'none') job.playwrightWorkerValues.add(Number(tier.playwrightWorkers))
    job.cacheProfile = combineCacheProfile(job.cacheProfile, tier.cacheProfile)
    jobs.set(job.id, job)
  }

  const lines = [
    '| CI job | Execution | Local reproduction command | Matrix tiers | Phase | Setup/cache | PW workers | Max timeout | Max shards | Max parallel |',
    '|---|---|---|---|---:|---|---:|---:|---:|---:|'
  ]
  for (const job of [...jobs.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push([
      `\`${job.id}\``,
      `\`${ciJobExecutionMode(job)}\``,
      `\`${ciJobReproductionCommand(job)}\``,
      job.tiers.map((tier) => `\`${tier.id}\``).join(', '),
      String(job.phase ?? 0),
      [
        job.requiresNode ? 'node' : null,
        job.requiresDotnet ? 'dotnet' : null,
        job.requiresPlaywright !== 'none' ? `playwright:${job.requiresPlaywright}` : null,
        job.cacheProfile !== 'none' ? `cache:${job.cacheProfile}` : null
      ].filter(Boolean).join(', ') || 'none',
      job.playwrightWorkerValues.size > 0 ? [...job.playwrightWorkerValues].sort((left, right) => left - right).join(', ') : '-',
      `${job.timeoutMinutes}m`,
      String(job.shards),
      String(job.maxParallel ?? 1)
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
  const summaryFile = path.join(root, '.tmp/docs/generated-testing-docs.json')
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

main()
