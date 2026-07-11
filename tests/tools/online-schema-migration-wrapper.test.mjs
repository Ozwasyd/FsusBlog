import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const wrapper = path.join(root, 'tools/db/run-online-migrations.sh')

test('wrapper forwards expand dry-run as an argv array and emits server machine JSON', (t) => {
  const fixture = createFixture(t)
  const result = run(fixture, [
    '--release-manifest', fixture.manifest,
    '--env-file', fixture.envFile,
    '--phase', 'expand',
    '--dry-run'
  ])

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [
    'migrate',
    '--phase', 'expand',
    '--release-manifest', fixture.manifest,
    '--env-file', fixture.envFile,
    '--dry-run'
  ])
})

test('wrapper requires a resume id for backfill and forwards it without evaluation', (t) => {
  const fixture = createFixture(t)
  const missing = run(fixture, [
    '--release-manifest', fixture.manifest,
    '--env-file', fixture.envFile,
    '--phase', 'backfill-resume'
  ])
  assert.equal(missing.status, 2)
  assert.equal(JSON.parse(missing.stdout).code, 'schema_wrapper_backfill_id_required')

  const migrationId = '20260712-post-example-backfill'
  const resumed = run(fixture, [
    '--release-manifest', fixture.manifest,
    '--env-file', fixture.envFile,
    '--phase', 'backfill-resume',
    '--id', migrationId
  ])
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.deepEqual(JSON.parse(resumed.stdout), [
    'migrate',
    '--phase', 'backfill-resume',
    '--release-manifest', fixture.manifest,
    '--env-file', fixture.envFile,
    '--id', migrationId
  ])
})

test('wrapper gates mutating Contract confirmation separately from evidence', (t) => {
  const fixture = createFixture(t)
  const missingConfirmation = run(fixture, [
    '--release-manifest', fixture.manifest,
    '--env-file', fixture.envFile,
    '--phase', 'contract',
    '--evidence', fixture.evidence
  ])
  assert.equal(missingConfirmation.status, 2)
  assert.equal(JSON.parse(missingConfirmation.stdout).code, 'schema_wrapper_contract_confirmation_required')

  const dryRun = run(fixture, [
    '--release-manifest', fixture.manifest,
    '--env-file', fixture.envFile,
    '--phase', 'contract',
    '--evidence', fixture.evidence,
    '--dry-run'
  ])
  assert.equal(dryRun.status, 0, dryRun.stderr)
  assert.ok(JSON.parse(dryRun.stdout).includes('--dry-run'))

  const confirmed = run(fixture, [
    '--release-manifest', fixture.manifest,
    '--env-file', fixture.envFile,
    '--phase', 'contract',
    '--evidence', fixture.evidence,
    '--confirm-destructive'
  ])
  assert.equal(confirmed.status, 0, confirmed.stderr)
  assert.ok(JSON.parse(confirmed.stdout).includes('--confirm-destructive'))
})

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-online-schema-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const server = path.join(directory, 'fake-server.mjs')
  const manifest = path.join(directory, 'release.json')
  const envFile = path.join(directory, 'server.env')
  const evidence = path.join(directory, 'contract-evidence.json')
  fs.writeFileSync(server, 'console.log(JSON.stringify(process.argv.slice(2)))\n')
  fs.writeFileSync(manifest, '{"schema":"fsusblog.release-manifest.v1","releaseId":"20260720-current"}\n')
  fs.writeFileSync(envFile, 'ConnectionStrings__DefaultConnection=redacted\n')
  fs.writeFileSync(evidence, '{"rollbackManifestSealed":true}\n')
  return { directory, server, manifest, envFile, evidence }
}

function run(fixture, args) {
  return spawnSync('bash', [
    wrapper,
    '--server-dll', fixture.server,
    ...args
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DOTNET_BIN: process.execPath
    }
  })
}
