import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const project = path.join(repoRoot, 'tools/security/FsusBlog.SecuritySourceAnalyzer/FsusBlog.SecuritySourceAnalyzer.csproj')
const policy = path.join(repoRoot, 'security/backend-source-policy.json')

function runAnalyzer(args, extra = []) {
  return spawnSync('dotnet', [
    'run',
    '--project', project,
    '--verbosity', 'quiet',
    ...extra,
    '--',
    '--root', repoRoot,
    '--policy', policy,
    ...args
  ], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
}

function parseReport(result) {
  assert.ok(result.stdout.trim(), result.stderr)
  const start = result.stdout.indexOf('{')
  assert.notEqual(start, -1, result.stdout)
  return JSON.parse(result.stdout.slice(start))
}

test('security source analyzer accepts repository policy and rejects negative Roslyn fixture', () => {
  const repository = runAnalyzer([])
  assert.equal(repository.status, 0, repository.stderr || repository.stdout)
  const repositoryReport = parseReport(repository)
  assert.equal(repositoryReport.status, 'passed')
  assert.deepEqual(repositoryReport.diagnostics, [])

  const fixtures = runAnalyzer([
    '--fixture',
    '--source', 'tests/backend/Fixtures/security-source-analysis/positive.cs',
    '--source', 'tests/backend/Fixtures/security-source-analysis/negative.cs'
  ], ['--no-build', '--no-restore'])
  assert.equal(fixtures.status, 1, fixtures.stderr || fixtures.stdout)
  const fixtureReport = parseReport(fixtures)
  assert.equal(fixtureReport.status, 'failed')
  assert.ok(fixtureReport.diagnostics.length >= 8)
  assert.ok(fixtureReport.diagnostics.every(item => item.path.endsWith('/negative.cs')))
  assert.deepEqual(
    new Set(fixtureReport.diagnostics.map(item => item.ruleId)),
    new Set([
      'FSUSBLOGSEC001',
      'FSUSBLOGSEC002',
      'FSUSBLOGSEC003',
      'FSUSBLOGSEC004',
      'FSUSBLOGSEC005',
      'FSUSBLOGSEC006',
      'FSUSBLOGSEC007',
      'FSUSBLOGSEC008'
    ])
  )
})
