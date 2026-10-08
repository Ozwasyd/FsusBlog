import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseMatrix, parseMatrixValue } from '../../tools/test-matrix/parse-matrix.mjs'
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

test('structured YAML parser preserves ordinary block scalar semantics', () =>
{
    const fixtures = [
        ['adjacent folded lines', 'run: >\n  first\n  second\n', 'first second\n'],
        ['interior blank line', 'run: >\n  first\n\n  second\n', 'first\nsecond\n'],
        ['multiple interior blanks', 'run: >\n  first\n\n\n  second\n', 'first\n\nsecond\n'],
        ['leading blank', 'run: >\n\n  first\n', '\nfirst\n'],
        ['folded shell comment', 'run: >\n  # disabled owner\n  first\n', '# disabled owner first\n'],
        ['inline shell comment', 'run: >\n  first # shell comment\n  second\n', 'first # shell comment second\n'],
        ['literal shell comment', 'run: |\n  # disabled owner\n  first\n', '# disabled owner\nfirst\n'],
        ['document markers in scalar', 'run: >\n  ---\n  ...\n', '--- ...\n'],
        ['more-indented folded line', 'run: >\n  first\n    second\n  third\n', 'first\n  second\nthird\n'],
        ['blanks around more-indented line', 'run: >\n  first\n\n    second\n\n  third\n', 'first\n\n  second\n\nthird\n'],
        ['scalar trailing spaces', 'run: >\n  first  \n  second\n', 'first   second\n'],
        ['tab inside scalar content', 'run: |\n  first\tsecond\n', 'first\tsecond\n'],
        ['folded scalar without final break', 'run: >\n  first\n  second', 'first second'],
        ['literal scalar without final break', 'run: |\n  first\n  second', 'first\nsecond'],
        ['CRLF block breaks', 'run: >\r\n  first\r\n\r\n  second\r\n', 'first\nsecond\n'],
        ['folded clip', 'run: >\n  first\n  second\n\n', 'first second\n'],
        ['folded strip', 'run: >-\n  first\n  second\n\n', 'first second'],
        ['folded keep', 'run: >+\n  first\n  second\n\n', 'first second\n\n'],
        ['literal clip', 'run: |\n  first\n  second\n\n', 'first\nsecond\n'],
        ['literal strip', 'run: |-\n  first\n  second\n\n', 'first\nsecond'],
        ['literal keep', 'run: |+\n  first\n  second\n\n', 'first\nsecond\n\n'],
        ['empty clip', 'run: >\n\n', ''],
        ['empty strip', 'run: |-\n\n', ''],
        ['empty keep', 'run: |+\n\n\n', '\n\n'],
        ['single quoted value', "run: 'first # literal' # YAML comment\n", 'first # literal'],
        ['double quoted value', 'run: "first # literal" # YAML comment\n', 'first # literal'],
        ['plain trailing comment', 'run: first # YAML comment\n', 'first'],
        ['plain non-comment hash', 'run: first#literal\n', 'first#literal']
    ];
    assert.equal(fixtures.length, 28);
    for (const [name, yaml, expected] of fixtures)
    {
        assert.equal(parseYamlDocument(yaml).run, expected, name);
    }
    const refusals = [
        ['over-indented leading blank', 'run: >\n    \n  first\n', /leading empty line is over-indented/u],
        ['decreased scalar indentation', 'run: >\n    first\n  second\n', /block scalar indentation decreased/u],
        ['structural tab indentation', 'jobs:\n\tjob: value\n', /indentation must not contain tabs/u],
        ['unsupported numeric indicator', 'run: >2\n  first\n', /unsupported YAML block scalar/u]
    ];
    assert.equal(refusals.length, 4);
    for (const [name, yaml, expected] of refusals)
    {
        assert.throws(() => parseYamlDocument(yaml), expected, name);
    }
});

test('matrix parser preserves ordinary folded command values', () =>
{
    const owner = 'tools/test/run-matrix-governance-once.sh validate-matrix';
    const fixtures = [
        ['adjacent folded command', '>\n      tools/test/run-matrix-governance-once.sh\n      validate-matrix\n', `${owner}\n`],
        ['stripped folded command', '>-\n      tools/test/run-matrix-governance-once.sh\n      validate-matrix\n', owner],
        ['separate folded commands', '>\n      tools/test/run-matrix-governance-once.sh\n\n      validate-matrix\n', 'tools/test/run-matrix-governance-once.sh\nvalidate-matrix\n'],
        ['folded shell comment', `>\n      # disabled canonical owner\n      ${owner}\n`, `# disabled canonical owner ${owner}\n`],
        ['literal command', `|\n      ${owner}\n`, `${owner}\n`],
        ['quoted command', `'${owner}' # YAML comment\n`, owner],
        ['plain command', `${owner} # YAML comment\n`, owner]
    ];
    assert.equal(fixtures.length, 7);
    for (const [name, value, expected] of fixtures)
    {
        const matrix = parseMatrix(`tiers:\n  - id: validate-matrix\n    command: ${value}    executionDependsOn: []\n# structural comment\n`);
        assert.equal(matrix.tiers[0].command, expected, name);
        assert.deepEqual(matrix.tiers[0].executionDependsOn, [], name);
    }
    const refusals = [
        ['sequence root', '- value\n', /root must be a YAML mapping/u],
        ['non-mapping profiles', 'localProfiles: []\n', /localProfiles must be a YAML mapping/u],
        ['non-sequence tiers', 'tiers: value\n', /tiers must be a YAML sequence/u],
        ['non-sequence evidence', 'tiers:\n  - id: one\n    executionDependsOn: []\n    requiresEvidenceFrom: producer\n', /requiresEvidenceFrom as an array/u]
    ];
    assert.equal(refusals.length, 4);
    for (const [name, yaml, expected] of refusals)
    {
        assert.throws(() => parseMatrix(yaml), expected, name);
    }
    assert.equal(parseMatrixValue("'first # literal'"), 'first # literal');
    assert.deepEqual(parseMatrixValue('[first, second]'), ['first', 'second']);
    assert.equal(parseMatrixValue('false'), false);
});

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
