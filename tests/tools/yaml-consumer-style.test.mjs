import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs'
import { parseYamlDocument } from '../../tools/yaml/parse-document.mjs'
import { parseWorkflowJobNeeds } from '../../tools/yaml/workflow-structure.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))

test('matrix parser follows structural indentation and all supported sequence forms', () => {
  const matrix = parseMatrix(`version: fixture-v1
localProfiles:
    production:
        bundles:
            - id: build
              members:
                  - compile
                  - lint
              artifacts:
                  [
                      .tmp/build.json,
                      .tmp/lint.json,
                  ]
tiers:
    - id: compile
      executionDependsOn:
          - bootstrap
      coverage: [native, shell]
    - id: lint
      executionDependsOn: []
`)

  assert.deepEqual(matrix.localProfiles.production.bundles[0], {
    id: 'build',
    members: ['compile', 'lint'],
    artifacts: ['.tmp/build.json', '.tmp/lint.json']
  })
  assert.deepEqual(matrix.tiers, [
    { id: 'compile', executionDependsOn: ['bootstrap'], coverage: ['native', 'shell'] },
    { id: 'lint', executionDependsOn: [] }
  ])

  const narrowWidth = parseMatrix(`tiers:
  - id: narrow
    executionDependsOn:
      - bootstrap
`)
  assert.deepEqual(narrowWidth.tiers[0], { id: 'narrow', executionDependsOn: ['bootstrap'] })
  assert.throws(
    () => parseMatrix('tiers:\n  - id: retired\n    dependsOn: []\n'),
    /tier retired uses retired dependsOn; use executionDependsOn/u
  )
  assert.throws(
    () => parseMatrix('tiers:\n  - id: evidence\n    executionDependsOn: []\n    requiresEvidenceFrom: producer\n'),
    /tier evidence must declare requiresEvidenceFrom as an array/u
  )
})

test('structured YAML parser rejects misalignment, duplicate keys and unfinished flow lists', () => {
  assert.throws(
    () => parseYamlDocument('tiers:\n    - id: one\n       owner: ServerContractAgent\n'),
    /misaligned YAML sequence mapping field/u
  )
  assert.throws(
    () => parseYamlDocument('version: one\nversion: two\n'),
    /duplicate YAML key version/u
  )
  assert.throws(
    () => parseYamlDocument('tiers:\n    [one, two\n'),
    /unterminated YAML flow collection/u
  )
})

test('workflow needs parser accepts inline, block and multiline flow sequences', () => {
  const jobs = parseWorkflowJobNeeds(`jobs:
    inline:
        name: Inline
        needs: [prepare, compile]
    block:
        name: Block
        needs:
            - inline
    flow:
        name: Flow
        needs:
            [
                inline,
                block,
            ]
`)

  assert.deepEqual([...jobs.get('inline')], ['prepare', 'compile'])
  assert.deepEqual([...jobs.get('block')], ['inline'])
  assert.deepEqual([...jobs.get('flow')], ['inline', 'block'])
  assert.throws(
    () => parseWorkflowJobNeeds('jobs:\n    broken:\n        name: Broken\n        needs:\n            invalid: mapping\n'),
    /workflow needs must be a sequence/u
  )
})

test('security matrix checker accepts four-space records and fails closed on malformed fixtures', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-security-yaml-'))
  try {
    fs.mkdirSync(path.join(temp, 'tools/security'), { recursive: true })
    fs.mkdirSync(path.join(temp, 'security/matrices'), { recursive: true })
    fs.mkdirSync(path.join(temp, 'src'), { recursive: true })
    fs.mkdirSync(path.join(temp, 'tests'), { recursive: true })
    fs.writeFileSync(path.join(temp, 'tools/security/check-security-matrices.mjs'), '')
    fs.writeFileSync(path.join(temp, 'src/fixture.cs'), '')
    fs.writeFileSync(path.join(temp, 'tests/fixture.test.mjs'), '')

    const matrixPath = path.join(temp, 'security/matrices/fixture.yml')
    const catalogPath = path.join(temp, 'catalog.json')
    fs.writeFileSync(catalogPath, JSON.stringify({
      schema: 'fsusblog.security-matrix-catalog.v1',
      version: '1.0.0',
      owner: 'ServerContractAgent',
      checker: 'tools/security/check-security-matrices.mjs',
      matrices: [{
        id: 'fixture',
        path: 'security/matrices/fixture.yml',
        family: 'fixture',
        schema: 'fixture.security-matrix.v1',
        version: 'fixture-v1',
        owner: 'ServerContractAgent',
        checker: 'tools/security/check-security-matrices.mjs',
        validation: { entryList: 'requirements', idPattern: '^FIX-[0-9]+$', profile: 'baseline' }
      }]
    }))
    const valid = `schema: fixture.security-matrix.v1
family: fixture
version: fixture-v1
owner: ServerContractAgent
checker: tools/security/check-security-matrices.mjs
requirements:
    - id: FIX-1
      owner: ServerContractAgent
      status: automated
      code:
          - src/fixture.cs
      tests: [tests/fixture.test.mjs]
      evidence:
          - .tmp/security/fixture.json
`
    fs.writeFileSync(matrixPath, valid)
    const args = ['tools/security/check-security-matrices.mjs', '--root', temp, '--catalog', catalogPath]
    const accepted = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
    assert.equal(accepted.status, 0, accepted.stderr)

    fs.writeFileSync(matrixPath, valid.replace('      owner:', '       owner:'))
    const rejected = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /invalid YAML|misaligned YAML sequence mapping field/u)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('ZK privacy checker reads block required cases and rejects a non-sequence contract', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-zk-yaml-'))
  try {
    const matrixPath = path.join(temp, 'privacy.yml')
    const tamperPath = path.join(temp, 'tamper.json')
    fs.writeFileSync(tamperPath, JSON.stringify({
      tamper_cases: [{ id: 'tamper-proof-reject', expected: 'reject' }],
      negative_invariants: [{ id: 'tamper-proof-reject', tamper_cases: ['case-one'] }]
    }))
    const valid = `scenarios:
    - id: PRIVACY-ZK-CIRCUIT-CONTRACT
      requiredCases:
          - tamper-proof-reject
`
    fs.writeFileSync(matrixPath, valid)
    const args = ['tools/verify-zk-privacy-matrix.mjs', '--matrix', matrixPath, '--tamper', tamperPath]
    const accepted = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
    assert.equal(accepted.status, 0, accepted.stderr)

    fs.writeFileSync(matrixPath, valid.replace('requiredCases:\n          - tamper-proof-reject', 'requiredCases:\n          id: tamper-proof-reject'))
    const rejected = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /declares no required negative invariant cases/u)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
