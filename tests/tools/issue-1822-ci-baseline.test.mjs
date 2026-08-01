import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const fixtureRoot = resolve(root, 'tests/fixtures/issue-orchestration')
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const readJson = (name) => JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8'))
const acceptance = readJson('ci-baseline-acceptance-map.json')
const expected = readJson('ci-baseline-expected-initial-failures.json')
const mutations = readJson('ci-baseline-mutation-controls.json')
const runtime = readJson('ci-baseline-runtime-probes.json')
const contract = readJson('ci-baseline-test-contract.json')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}
const digest = (value) => sha256(JSON.stringify(canonical(value)))

test('frozen #1822 corrective CI-baseline contract is self-consistent', () => {
  assert.equal(contract.testOwnerId, 'test-owner-1822-ci-baseline-r10')
  assert.equal(contract.correctiveRevision, 8)
  assert.equal(contract.baseSha, '9a8ab8cd80a4cdc7f76866f0c475b8fa64218731')
  assert.equal(runtime.run.id, 30683846973)
  assert.deepEqual(expected.expectedFailingTests, ['R10CI09', 'R10CI10', 'R10CI11', 'R10CI12'])
  assert.equal(expected.behaviorStatus, 'red')
  assert.equal(expected.documentationStatus, 'blocked-until-behavior-green')
  assert.deepEqual(runtime.correctiveRevision5.behaviorProof, {
    matrixSchema: 'green',
    preflight: 'green',
    tierCount: 135,
    workflowSyncRequiredJobs: 29
  })
  assert.deepEqual(runtime.correctiveRevision5.combinedBehaviorContract, { passed: 54, failed: 0 })
  assert.deepEqual(runtime.correctiveRevision8.focusedFrontendUnit, {
    files: 2,
    tests: 80,
    passed: 80,
    failed: 0
  })
  assert.deepEqual(
    acceptance.acceptance.flatMap(({ mutations: ids }) => ids).sort(),
    mutations.controls.map(({ id }) => id).sort()
  )
  for (const [relative, expectedHash] of Object.entries(contract.fileHashes)) {
    assert.equal(sha256(readFileSync(resolve(root, relative))), expectedHash, `${relative} drifted`)
  }
  assert.equal(digest(contract.fileHashes), contract.frozenTreeDigest)
  const unsigned = structuredClone(contract)
  delete unsigned.contractDigest
  assert.equal(digest(unsigned), contract.contractDigest)
})

test('R10CI01 binary transport resolves relative routes in browser and Node test runtimes', () => {
  const transport = `${read('src/frontend/src/api/binaryApiClient.ts')}\n${read('src/frontend/src/services/binaryTransport.ts')}`
  const transportTest = read('tests/frontend/unit/services/binaryTransport.test.ts')
  assert.match(transport, /resolveBinaryTransportUrl/u)
  assert.match(transport, /new URL\([^,]+,\s*(?:window\.location|globalThis\.location)/u)
  assert.match(transport, /fetch\(resolveBinaryTransportUrl\(/u)
  assert.match(transportTest, /unexpected-real-fetch/u)
  assert.match(transportTest, /vi\.stubGlobal\(['"]fetch['"]/u)
})

test('R10CI02 a current-run WASM manifest and receipt producer precedes every consumer', () => {
  const workflow = read('.github/workflows/quality-gate.yml')
  assert.match(workflow, /^\s{4}wasm-build-artifacts:\n/mu)
  assert.match(workflow, /name:\s+wasm-build-artifacts/u)
  for (const job of ['production-build-artifacts', 'frontend-build', 'frontend-runtime-contracts']) {
    const start = workflow.indexOf(`    ${job}:\n`)
    assert.ok(start >= 0)
    const nextJob = /^    [a-z][a-z0-9-]*:\s*$/gmu.exec(workflow.slice(start + 1))
    const end = nextJob ? start + 1 + nextJob.index : workflow.length
    const source = workflow.slice(start, end < 0 ? workflow.length : end)
    assert.match(source, /needs:[^\n]*wasm-build-artifacts/u, `${job} must require the producer`)
    assert.match(source, /actions\/download-artifact@[^\n]+[\s\S]*name:\s+wasm-build-artifacts/u, `${job} must consume its current-run artifact`)
  }
})

test('R10CI03 absent published FsusUI surfaces remain an exact remote blocker without fallback', () => {
  const packageJson = JSON.parse(read('src/frontend/package.json'))
  assert.equal(packageJson.dependencies['@ozwasyd/element-plus'], '1.5.1')
  assert.deepEqual(runtime.remoteContractImpacts.R10CI03, {
    disposition: 'possible-remote-contract-impact',
    ownerRepository: 'Ozwasyd/FsusUI',
    publishedVersion: '1.5.1',
    publishedCommit: '94d64b73219e6cb96e8aa8968355b730ea0dfccd',
    exportIndexBlob: '2a2cad96fa46b2aab565b1b0f94ed64ea4cd239a',
    missingExports: ['FsusTaskPageHeader', 'FsusDataList'],
    reproduction: 'npm ci followed by npm run build reports MISSING_EXPORT for both canonical names',
    blockedCriterion: 'a published @ozwasyd/element-plus release exporting both canonical surfaces is required',
    fallbackAllowed: false,
    directEvidenceDigest: '93fd479bb6d3ee3a50c1c9ed0e4f5edfa15e4ddd6d9c2a0ca787efc616b1c5c0'
  })
})

test('R10CI04 authoritative test lifecycle and browser migration inventories reconcile', () => {
  const lifecycle = read('tests/test-retention-replacements.json')
  const migration = read('tests/governance/browser-test-migration.json')
  const persistentProbe = read('tests/frontend/e2e/article-editor-recovery-persistent-probe.mjs')
  assert.doesNotMatch(lifecycle, /tests\/browser-diagnostics-retirement-map\.json/u)
  assert.doesNotMatch(lifecycle, /tests\/lightweight-acceptance-baseline\.json/u)
  assert.doesNotMatch(lifecycle, /tests\/admin-console-behavior-evidence\.json/u)
  assert.doesNotMatch(migration, /round-trips only non-recoverable metadata/u)
  assert.doesNotMatch(persistentProbe, /node:child_process/u)
  assert.doesNotMatch(persistentProbe, /\bspawn\(/u)
  for (const command of ['tools/check-browser-test-migration.mjs', 'tools/check-test-lifecycle.mjs']) {
    const result = spawnSync(process.execPath, [command], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    assert.equal(result.status, 0, `${command} must reconcile without ignored or unowned tests`)
  }
})

test('R10CI05 backend build governance uses the shared repository-root authority', () => {
  const source = read('tests/backend/Unit/SpaAssetManifestServiceTests.cs')
  assert.doesNotMatch(source, /private static string FindRepositoryRoot\(/u)
  assert.doesNotMatch(source, /AppContext\.BaseDirectory/u)
  assert.match(source, /BackendTestPaths\.RepositoryRoot/u)
})

test('R10CI06 downstream summaries require only current-run producer evidence', () => {
  assert.equal(runtime.downstream.disposition, 'consequence-of-primary-failures')
  assert.equal(runtime.downstream.fallbackAllowed, false)
  assert.deepEqual(runtime.downstream.missingArtifacts, ['fast-summary', 'integration-runtime'])
})

test('R10CI07 the standalone WASM producer is declared by canonical matrix ciJob authority', () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'fsusblog-1822-matrix-sync-'))
  try {
    const plan = spawnSync(process.execPath, ['tools/run-test-matrix.mjs', 'ci-plan', '--format', 'github-actions'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    assert.equal(plan.status, 0, plan.stderr.trim())
    const planPath = resolve(temporaryRoot, 'ci-plan.json')
    writeFileSync(planPath, plan.stdout)
    const sync = spawnSync(process.execPath, [
      'tools/check-workflow-matrix-sync.mjs',
      planPath,
      '.github/workflows/quality-gate.yml'
    ], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    assert.equal(sync.status, 0, sync.stderr.trim())
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('R10CI08 only the generated testing docs projection remains for the documentation stage', () => {
  const result = spawnSync(process.execPath, ['tools/docs/generate-testing-docs.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  const diagnostic = '[testing-docs] docs/testing.generated.md is not in sync with tests/matrix.yml'
  assert.ok([0, 1].includes(result.status))
  if (result.status === 0) {
    assert.equal(result.stdout.trim(), '[testing-docs] ok docs/testing.generated.md')
    assert.equal(result.stderr.trim(), '')
  } else {
    assert.equal(result.stderr.trim(), diagnostic)
  }
  assert.equal(runtime.correctiveRevision5.documentationStage.requiredPath, 'docs/testing.generated.md')
  assert.equal(runtime.correctiveRevision5.documentationStage.writerStartCondition, 'behavior-green')
  assert.equal(runtime.correctiveRevision5.documentationStage.implementerAuthorized, false)
})

test('R10CI09 PostgreSQL collection estimated facts match their canonical manifest', () => {
  const result = spawnSync(process.execPath, ['tools/check-postgres-test-collections.mjs'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  assert.equal(result.status, 0, result.stderr.trim())
})

test('R10CI10 retention consumers fetch the historical before-snapshot source commit', () => {
  const workflow = read('.github/workflows/quality-gate.yml')
  const start = workflow.indexOf('    fast-static-governance:\n')
  assert.ok(start >= 0)
  const nextJob = /^    [a-z][a-z0-9-]*:\s*$/gmu.exec(workflow.slice(start + 1))
  const end = nextJob ? start + 1 + nextJob.index : workflow.length
  const source = workflow.slice(start, end)
  assert.match(source, /actions\/checkout@[^\n]+\n\s+with:\n\s+fetch-depth:\s+0/u)
  assert.match(read('tests/test-retention-before.json'), /"matrix":\s*"sha256:[a-f0-9]{64}"/u)
})

test('R10CI11 process-group disappearance races do not invalidate a successful producer seal', () => {
  const source = read('tools/test/process-identity.mjs')
  const start = source.indexOf('export function processGroupMemberIdentities(')
  assert.ok(start >= 0)
  const implementation = source.slice(start)
  assert.match(
    implementation,
    /catch \(error\) \{\s*if \(\['ENOENT', 'ESRCH'\]\.includes\(error\?\.code\) && raceRetries > 0\)/u
  )
})

test('R10CI12 frontend unit isolation and decoder cardinality do not depend on global or stale state', () => {
  assert.doesNotMatch(read('tests/frontend/unit/services/binaryTransport.test.ts'), /vi\.resetModules\(\)/u)
  assert.doesNotMatch(read('tests/frontend/unit/adapters/binary/index.test.ts'), /toHaveLength\(132\)/u)
})

test('mutation controls keep every primary repair fail closed', () => {
  assert.equal(new Set(mutations.controls.map(({ id }) => id)).size, mutations.controls.length)
  assert.ok(mutations.controls.every(({ consequence }) => consequence === 'required-job-red'))
})
