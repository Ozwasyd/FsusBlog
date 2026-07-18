import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const script = path.join(root, 'tools/security/check-supply-chain-audit.sh')
const source = fs.readFileSync(script, 'utf8')

test('supply-chain audit batches every NuGet project into one solution evaluation', () => {
  assert.match(source, /local auditSolution="\$OUT_DIR\/\.nuget-audit\.slnx"/u)
  assert.match(source, /dotnet list "\$auditSolution" package --vulnerable --include-transitive/u)
  assert.doesNotMatch(source, /dotnet list "\$project" package --vulnerable/u)
  assert.match(source, /project missing from batched NuGet audit output/u)
  assert.match(source, /unexpected project in batched NuGet audit output/u)
  assert.match(source, /fs\.writeFileSync\(path\.join\(dir, `\$\{safeName\}\.json`\)/u)
})

test('supply-chain audit parallelizes independent checks with dynamic resource bounds', () => {
  assert.match(source, /FSUSBLOG_STEP_CPU_BUDGET/u)
  assert.match(source, /FSUSBLOG_STEP_MEMORY_GIB/u)
  assert.match(source, /os\.availableParallelism/u)
  assert.match(source, /os\.totalmem/u)

  const preflight = source.indexOf('RunCheckGroup preflight')
  const audits = source.indexOf('RunCheckGroup ecosystem-audits')
  const aggregate = source.indexOf('if ((${#SUPPLY_CHAIN_FAILURES[@]} > 0)); then')
  assert.ok(preflight >= 0)
  assert.ok(audits > preflight)
  assert.ok(aggregate > audits)
  assert.match(source.slice(preflight, audits), /dependency-locks::CheckDependencyLocks[\s\S]*dependency-docs::CheckDependencyDocs/u)
  assert.match(source.slice(audits, aggregate), /nuget::RunNugetAudit[\s\S]*npm::RunNpmAudit/u)
  assert.match(source, /SUPPLY_CHAIN_FAILURES\+=\("\$label:\$status"\)/u)
})

test('supply-chain audit remains valid bash', () => {
  const result = spawnSync('bash', ['-n', script], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
