import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { checkSecurityDomainLayout } from '../../tools/security/check-security-domain-layout.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')
const temporaryRoots = []

function readJson(relative, base = root) {
  return JSON.parse(readFileSync(path.join(base, relative), 'utf8'))
}

function writeJson(relative, value, base) {
  const file = path.join(base, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'fsusblog-security-domain-'))
  temporaryRoots.push(directory)
  cpSync(path.join(root, 'security'), path.join(directory, 'security'), { recursive: true })
  for (const relative of [
    'src/backend/appsettings.json',
    'src/backend/appsettings.Production.json'
  ]) {
    const destination = path.join(directory, relative)
    mkdirSync(path.dirname(destination), { recursive: true })
    cpSync(path.join(root, relative), destination)
  }
  return directory
}

test.after(() => {
  for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true })
})

test('canonical security domain is partitioned and fail-closed', () => {
  assert.deepEqual(checkSecurityDomainLayout({ root }), [])
  const catalog = readJson('security/catalog/security-domain.json')
  assert.equal(catalog.failClosed, true)
  assert.deepEqual(catalog.domains.map(domain => domain.id), [
    'matrices',
    'policies',
    'zk-contracts',
    'zk-provenance',
    'evidence-contracts'
  ])
})

test('governance aggregates flat files, weak policies, ZK drift, false evidence and runtime legacy paths', () => {
  const directory = fixture()
  writeJson('security/rogue.json', { schema: 'flat-root-file' }, directory)

  const policy = readJson('security/policies/backend-source-policy.json', directory)
  policy.rules[0].severity = 'warning'
  policy.rules[0].rationale = ''
  policy.rules[0].include = ['../outside/**/*.cs']
  writeJson('security/policies/backend-source-policy.json', policy, directory)

  const circuitPath = 'security/zk/contracts/comment-v5-circuit.manifest.json'
  const circuit = readJson(circuitPath, directory)
  circuit.artifact_class = 'provenance-in-contracts'
  writeJson(circuitPath, circuit, directory)

  const setupPath = 'security/zk/provenance/comment-v5-trusted-setup.manifest.json'
  const setup = readJson(setupPath, directory)
  setup.circuit_id = 'fsus.anonymous.comment.retired'
  writeJson(setupPath, setup, directory)

  const evidencePath = 'security/evidence-contracts/comment-privacy-credential-vault.release-plan.json'
  const evidence = readJson(evidencePath, directory)
  evidence.freshExecution = true
  writeJson(evidencePath, evidence, directory)

  const settingsPath = path.join(directory, 'src/backend/appsettings.json')
  writeFileSync(settingsPath, readFileSync(settingsPath, 'utf8').replace(
    'security/zk/contracts/comment-v5-circuit.manifest.json',
    'security/zk/comment-v5-circuit.manifest.json'
  ))

  const errors = checkSecurityDomainLayout({ root: directory })
  assert.ok(errors.some(error => error.includes('flat or undeclared security root entry')))
  assert.ok(errors.some(error => error.includes('security root files are forbidden')))
  assert.ok(errors.some(error => error.includes('lacks severity, rationale, or safe path scope')))
  assert.ok(errors.some(error => error.includes('artifact_class must identify a contract')))
  assert.ok(errors.some(error => error.includes('trusted setup must select fsus.anonymous.comment.v5 layout 6')))
  assert.ok(errors.some(error => error.includes('cannot claim freshExecution')))
  assert.ok(errors.some(error => error.includes('must select a ZK contract manifest')))
  assert.ok(errors.some(error => error.includes('legacy flat security path remains')))
})
