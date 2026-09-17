import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  PublicAssetMigrationError,
  inventoryTree,
  migratePublicAssets
} from '../../tools/storage/migrate-public-assets.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-public-asset-migration-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'legacy', 'illustration')
  const publicRoot = path.join(root, 'shared', 'assets', 'public')
  const sessionRoot = path.join(root, 'legacy', '.upload-sessions')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true })
  fs.mkdirSync(path.join(source, '.incoming'), { recursive: true })
  fs.mkdirSync(sessionRoot, { recursive: true })
  fs.writeFileSync(path.join(source, 'a.png'), Buffer.from([1, 2, 3, 4]))
  fs.writeFileSync(path.join(source, 'nested', 'b.webp'), Buffer.from([9, 8, 7]))
  fs.writeFileSync(path.join(source, '.incoming', 'tmp.bin'), Buffer.from([0]))
  fs.writeFileSync(path.join(sessionRoot, 'stale-session'), 'session')
  return { root, source, publicRoot, sessionRoot }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

test('migratePublicAssets succeeds with count relative-path length and sha256 checks', (t) => {
  const { source, publicRoot, sessionRoot } = fixture(t)
  const report = migratePublicAssets({
    source,
    publicRoot,
    legacySessionRoot: sessionRoot,
    confirmStopWrites: true
  })

  assert.equal(report.status, 'migrated')
  assert.equal(report.count, 2)
  assert.equal(report.target, path.join(publicRoot, 'illustration'))
  assert.deepEqual(
    report.files.map((entry) => entry.path),
    ['a.png', 'nested/b.webp'])
  assert.equal(sha256(path.join(report.target, 'a.png')), sha256(path.join(source, 'a.png')))
  assert.equal(
    sha256(path.join(report.target, 'nested', 'b.webp')),
    sha256(path.join(source, 'nested', 'b.webp')))
  assert.equal(fs.existsSync(path.join(source, '.incoming')), false)
  assert.equal(fs.existsSync(sessionRoot), false)
  assert.equal(fs.existsSync(path.join(publicRoot, '.public-assets-migration.lock')), false)
})

test('migratePublicAssets fails closed when source is missing', (t) => {
  const { publicRoot } = fixture(t)
  assert.throws(
    () => migratePublicAssets({
      source: path.join(publicRoot, 'missing-source'),
      publicRoot,
      confirmStopWrites: true
    }),
    (error) => error instanceof PublicAssetMigrationError && error.code === 'source_missing')
})

test('migratePublicAssets fails closed on target conflict with different content', (t) => {
  const { source, publicRoot, sessionRoot } = fixture(t)
  const target = path.join(publicRoot, 'illustration')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'a.png'), Buffer.from([9, 9, 9, 9]))

  assert.throws(
    () => migratePublicAssets({
      source,
      publicRoot,
      legacySessionRoot: sessionRoot,
      confirmStopWrites: true
    }),
    (error) => error instanceof PublicAssetMigrationError && error.code === 'target_conflict')
})

test('migratePublicAssets fails closed when staged hash diverges', (t) => {
  const { source, publicRoot, sessionRoot } = fixture(t)
  assert.throws(
    () => migratePublicAssets({
      source,
      publicRoot,
      legacySessionRoot: sessionRoot,
      confirmStopWrites: true,
      afterCopy(staging) {
        fs.writeFileSync(path.join(staging, 'a.png'), Buffer.from([5, 5, 5, 5]))
      }
    }),
    (error) => error instanceof PublicAssetMigrationError && error.code === 'hash_mismatch')
  assert.equal(fs.existsSync(path.join(publicRoot, 'illustration')), false)
})

test('migratePublicAssets re-run is already-complete when inventories match', (t) => {
  const { source, publicRoot, sessionRoot } = fixture(t)
  const first = migratePublicAssets({
    source,
    publicRoot,
    legacySessionRoot: sessionRoot,
    confirmStopWrites: true
  })
  assert.equal(first.status, 'migrated')

  // recreate source inventory for a second invocation against installed target
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(source, 'a.png'), Buffer.from([1, 2, 3, 4]))
  fs.writeFileSync(path.join(source, 'nested', 'b.webp'), Buffer.from([9, 8, 7]))

  const second = migratePublicAssets({
    source,
    publicRoot,
    legacySessionRoot: sessionRoot,
    confirmStopWrites: true
  })
  assert.equal(second.status, 'already-complete')
  assert.equal(second.count, first.count)
  assert.deepEqual(second.files, first.files)
  assert.equal(
    inventoryTree(path.join(publicRoot, 'illustration')).length,
    2)
})

test('migratePublicAssets requires explicit stop-writes confirmation', (t) => {
  const { source, publicRoot } = fixture(t)
  assert.throws(
    () => migratePublicAssets({ source, publicRoot }),
    (error) => error instanceof PublicAssetMigrationError
      && error.code === 'stop_writes_confirmation_required')
})

test('production compose bans legacy wwwroot uploads mount', () => {
  const compose = fs.readFileSync(
    path.join(repositoryRoot, 'ops/docker/docker-compose.production.yml'),
    'utf8')
  assert.doesNotMatch(compose, /\/app\/wwwroot\/uploads/u)
  assert.doesNotMatch(compose, /FSUSBLOG_SHARED_UPLOADS_VOLUME/u)
  assert.match(compose, /FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME/u)
  assert.match(compose, /FSUSBLOG_SHARED_STORAGE_ROOT=\/app\/storage\/shared/u)
  assert.match(compose, /FSUSBLOG_INSTANCE_STORAGE_ROOT=\/app\/storage\/instances/u)
  assert.match(compose, /fsus-storage:\/app\/storage/u)
})
