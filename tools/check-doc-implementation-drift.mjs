#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { loadMatrix, planTier, relative, root } from './docs/lib/matrix.mjs'
import { tierExecutionDependencies } from './test-matrix/parse-matrix.mjs'

const outFile = path.join(root, '.tmp/docs/doc-implementation-drift.json')
const releaseSummaryFile = path.join(root, '.tmp/release-evidence/doc-sync-summary.json')

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function readJson(rel) {
  return JSON.parse(read(rel))
}

function major(raw) {
  return String(raw ?? '').replace(/^[~^]/u, '').split('.')[0]
}

function minorLine(raw) {
  const [majorPart, minorPart] = String(raw ?? '').replace(/^[~^]/u, '').split('.')
  return majorPart && minorPart ? `${majorPart}.${minorPart}.x` : null
}

function majorLine(raw) {
  const majorPart = major(raw)
  return majorPart ? `${majorPart}.x` : null
}

function depVersion(pkg, name) {
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? null
}

function runNodeScript(script, args = []) {
  const result = spawnSync('node', [script, ...args], {
    cwd: root,
    encoding: 'utf8'
  })
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  }
}

const checks = []

function add(scope, label, predicate) {
  checks.push({ scope, label, predicate })
}

add('test-matrix', 'README and docs/testing do not hard-code a 10-tier test system', () => {
  const text = `${read('README.md')}\n${read('docs/testing.md')}`
  return !/10\s*级|10\s*tier/iu.test(text)
})

add('test-matrix', 'docs/testing.generated.md is generated from tests/matrix.yml', () => {
  return runNodeScript('tools/docs/generate-testing-docs.mjs', ['--check']).ok
})

add('coverage', 'README names coverage-gate as an independent required check', () => {
  const readme = read('README.md')
  return readme.includes('coverage-gate') && readme.includes('independent required')
})

add('production-order', 'production plan keeps release evidence as CI schema gate, not closeout gate', () => {
  const matrix = loadMatrix()
  const production = matrix.tiers.find((tier) => tier.id === 'production-correctness')
  return tierExecutionDependencies(production).includes('release-evidence')
    && !tierExecutionDependencies(production).includes('release-closeout')
})

add('production-order', 'production DAG includes browserless runtime and frontend structure tiers', () => {
  const ids = planTier(loadMatrix(), 'production').map((tier) => tier.id)
  return ['fast', 'bootstrap', 'release', 'integration', 'security', 'frontend-render-structure', 'release-evidence', 'production-correctness', 'production']
    .every((id) => ids.includes(id))
    && !ids.includes('acceptance')
    && !ids.includes('browser-contract')
})

add('release-evidence', 'docs distinguish production-ci-gate from release-closeout-gate', () => {
  const text = `${read('README.md')}\n${read('docs/testing.md')}\n${read('docs/operations.md')}`
  return text.includes('production-ci-gate') && text.includes('release-closeout-gate') && text.includes('--require-ok')
})

add('release-evidence', 'release evidence manifest checker self-test passes', () => {
  return runNodeScript('tools/operations/check-release-evidence-manifest.mjs', ['--self-test']).ok
})

add('aeds', 'AEDS header docs match aeds-protocol.json', () => {
  const protocol = readJson('src/shared/Contracts/Validation/aeds-protocol.json')
  const docs = `${read('docs/api.md')}\n${read('docs/api/schemas-and-errors.md')}`
  return docs.includes(protocol.header.magic)
    && docs.includes(`Version (${protocol.header.version})`)
    && docs.includes(`Header Length (${protocol.header.size})`)
    && !docs.includes('0x53455341')
})

add('api', 'docs/api.md is an overview, not a hand-written all-endpoints catalog', () => {
  const api = read('docs/api.md')
  return api.includes('API overview / selected quick reference') && !api.includes('所有公开 API 端点')
})

add('api', 'docs/api.md presents current binary API before legacy aliases', () => {
  const api = read('docs/api.md')
  return api.indexOf('## Current Binary API') > -1
    && api.indexOf('## Current Binary API') < api.indexOf('## Legacy Aliases')
})

add('api', 'generated API docs summary matches OpenAPI and AEDS sources', () => {
  return runNodeScript('tools/contracts/generate-api-docs.mjs', ['--check']).ok
})

add('auth-docs', 'API auth legend uses HttpOnly Cookie session / AEDS auth frame, not Bearer JWT', () => {
  const text = `${read('docs/api.md')}\n${read('docs/api/quick-reference.md')}`
  return text.includes('HttpOnly Cookie session / AEDS auth frame') && !text.includes('Bearer JWT')
})

add('anonymous-identity', 'anonymous identity smoke runbook covers the physical projection operator flow', () => {
  const smoke = read('docs/anonymous-identity-smoke-flow.md')
  return [
    'physical account-subject projection',
    'bootstrap admin',
    'Passkey registration/login',
    'Recovery Key creation/recovery',
    'anonymous default comment submission',
    'public opt-in comment submission',
    'moderation review',
    "account_subject_hash IS NULL OR account_subject_hash = ''",
    'accountSubjectHashInvariant=ok'
  ].every((token) => smoke.includes(token))
})

add('anonymous-identity', 'migration and security docs pin account subject expand, backfill, and fail-closed reads', () => {
  const migration = read('docs/database-migration.md')
  const security = read('docs/security.md')

  return migration.includes('20260711-pre-account-subject-hash-expand')
    && migration.includes('20260711-post-account-subject-hash-backfill')
    && migration.includes("account_subject_hash IS NULL OR account_subject_hash = ''")
    && migration.includes('accountSubjectHashInvariant=ok')
    && security.includes('sys_user.account_subject_hash')
    && security.includes('不得按账号 id 重新派生')
    && security.includes('永久启动门禁')
})

add('notification-transport', 'notification transport docs consistently name WebSocket binary stream', () => {
  const text = `${read('README.md')}\n${read('docs/api.md')}\n${read('docs/testing.md')}\n${read('docs/operations.md')}`
  return text.includes('WebSocket binary notification stream') && !text.includes('Server-Sent Events 增量事件流')
})

add('load', 'load docs match perf policy baseline and WebSocket pressure defaults', () => {
  const docs = read('docs/testing.md')
  return docs.includes('concurrency=10')
    && docs.includes('rounds=6')
    && docs.includes('connections=50')
    && docs.includes('durationMs=30000')
    && docs.includes('tests/performance/perf-policy.yml')
})

add('viewport', 'viewport docs are synchronized with viewport registry', () => {
  return runNodeScript('tools/docs/check-viewport-doc-sync.mjs').ok
})

add('version-table', 'README technology version table matches package metadata', () => {
  return runNodeScript('tools/docs/check-version-table.mjs').ok
})

add('time-budget', 'time budgets are sourced from tests/matrix.yml timeoutMinutes', () => {
  return runNodeScript('tools/docs/check-time-budget-sync.mjs').ok
})

add('backend-perf', 'backend-perf native P99 and BenchmarkDotNet regression responsibilities are documented separately', () => {
  const testingDocs = read('docs/testing.md')
  const backendDocs = read('tests/backend/TESTING.md')
  return testingDocs.includes('native verifier P99')
    && testingDocs.includes('machine-quiet `benchmark-window`')
    && backendDocs.includes('native verifier P99')
    && backendDocs.includes('backend-benchmark-regression')
})

add('ports', 'testing docs describe fixed local default ports with environment overrides', () => {
  const docs = read('docs/testing.md')
  return docs.includes('默认固定本地端口') && docs.includes('3000/7568/8080/5432/6379') && !docs.includes('无硬编码端口')
})

add('version-table', 'README major/minor lines avoid patch drift', () => {
  const pkg = readJson('src/frontend/package.json')
  const readme = read('README.md')
  const expected = [
    ['Vue', minorLine(depVersion(pkg, 'vue'))],
    ['Vite', majorLine(depVersion(pkg, 'vite'))],
    ['TypeScript', majorLine(depVersion(pkg, 'typescript'))],
    ['Tailwind CSS', minorLine(depVersion(pkg, 'tailwindcss'))]
  ]
  return expected.every(([label, value]) => value && readme.includes(`| ${label} | ${value} |`))
})

function selectedScopes(args) {
  const scopes = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--scope') scopes.push(args[++index])
    else if (arg.startsWith('--scope=')) scopes.push(arg.slice('--scope='.length))
  }
  return scopes.length > 0 ? new Set(scopes.flatMap((item) => item.split(',').map((value) => value.trim()).filter(Boolean))) : null
}

function writeSummaries(summary) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
  fs.mkdirSync(path.dirname(releaseSummaryFile), { recursive: true })
  fs.writeFileSync(releaseSummaryFile, `${JSON.stringify({
    status: summary.status,
    generatedAt: summary.generatedAt,
    checkCount: summary.checks.length,
    failedCount: summary.failed.length,
    artifact: relative(outFile)
  }, null, 2)}\n`)
}

const scopes = selectedScopes(process.argv.slice(2))
const activeChecks = scopes ? checks.filter((check) => scopes.has(check.scope)) : checks
const results = activeChecks.map((check) => {
  let ok = false
  let error = ''
  try {
    ok = check.predicate()
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  return { scope: check.scope, label: check.label, status: ok ? 'ok' : 'failed', error }
})

const failed = results.filter((result) => result.status !== 'ok')
const summary = {
  status: failed.length === 0 ? 'ok' : 'failed',
  generatedAt: new Date().toISOString(),
  scopes: scopes ? [...scopes] : ['all'],
  checks: results,
  failed
}
writeSummaries(summary)

if (failed.length > 0) {
  for (const item of failed) {
    console.error(`[doc-drift] ${item.scope}: ${item.label}${item.error ? ` (${item.error})` : ''}`)
  }
  process.exit(1)
}

console.log(`[doc-drift] ok checks=${results.length}`)
