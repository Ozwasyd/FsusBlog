import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  loadRegistry,
  validateOwnershipAgainstBehaviorCatalog,
  root
} from '../../tools/fact-extractors/registry.mjs'
import { loadCatalog } from '../../tools/contracts/behavior-contract-catalog.mjs'
import { runExtractor, assertDeterministicSemanticDigest } from '../../tools/fact-extractors/runner.mjs'
import { semanticDigestFromReceipt } from '../../tools/fact-extractors/receipt.mjs'
import { sealSourceIdentity } from '../../tools/fact-extractors/identity.mjs'
import {
  extract as extractTestMatrix,
  TEST_MATRIX_REQUIRED_FACT_KEYS,
  TEST_MATRIX_DECLARED_FACT_SOURCES,
  TEST_MATRIX_CONSUMER_INPUTS
} from '../../tools/fact-extractors/test-matrix/extract.mjs'
import { produceRuntimeRoleObservation } from '../../tools/contracts/lib/runtime-role-observation.mjs'

const extractorId = 'test-matrix-fact-extractor'
const runtimeRoleBuild = produceRuntimeRoleObservation({ repositoryRoot: root })
const sourceIdentity = sealSourceIdentity(root)

function registryExtractor()
{
  const registry = loadRegistry()
  return registry.extractors.find((entry) => entry.id === extractorId)
}

function write(repositoryRoot, relative, content)
{
  const target = path.join(repositoryRoot, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
  return relative
}

function copy(repositoryRoot, relative)
{
  const source = path.join(root, relative)
  const target = path.join(repositoryRoot, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true })
}

function fixtureRepository(options = {})
{
  const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-matrix-topo-'))
  for (const relative of [
    'tests/matrix.yml',
    'tests/matrix.schema.json',
    'tests/coverage-registry.json',
    'config/testing/producer-execution-class-contract.json',
    'src/frontend/package.json',
    'tools/docs/generate-testing-docs.mjs',
    'tools/test-matrix/behavior-doc-static-admission-contract.mjs',
    'tools/deployment/slot-lib.mjs',
    'tools/deployment/release-rollout-lib.mjs',
    'tools/storage/release-gc.mjs',
    'config/testing/required-evidence-authority-ledger.json',
    'config/testing/release-domain-assertion-dispositions.json',
    'tools/test-matrix/release-final-evidence-contract.mjs',
    'tools/test-matrix/required-evidence-catalog.mjs',
    'tools/test-matrix/release-domain-ledger.mjs',
    'tools/test-matrix/outcomes/release-finalizer-adapter.mjs',
    'tools/test-matrix/outcomes/adapter-support.mjs',
    'tools/test-matrix/outcomes/outcome-contract.mjs',
    'config/testing/outcome-failure-taxonomy.json',
    'config/testing/outcome-field-dispositions.json',
    'tools/test/attempt-provenance.mjs',
    'tools/ci/check-flaky-registry.mjs',
    'tools/ci/check-job-summaries.mjs',
    'tools/docs/behavior-document-consistency-final.mjs',
    'tools/release/check-release-final.mjs',
    'tools/test-matrix/behavior-evidence-post-runtime.mjs',
    'tools/test-matrix/behavior-evidence-pre-runtime.mjs',
    'tools/test-matrix/release-domain-projection-receipt.mjs',
    'tools/test/run-native-tests.mjs',
    'tools/test/verify-release-reliability-receipt.mjs',
    'tools/test/lanes'
  ])
  {
    copy(directory, relative)
  }
  if (options.matrixText)
  {
    write(directory, 'tests/matrix.yml', options.matrixText)
  }
  copy(directory, '.tmp/contracts/runtime-role/runtime-role-observation.json')
  return directory
}

function extractFrom(repositoryRoot, extractorOverrides = {})
{
  const base = registryExtractor()
  return extractTestMatrix({
    repositoryRoot,
    buildIdentity: runtimeRoleBuild.buildIdentity,
    sourceCommit: sourceIdentity.sourceCommit,
    worktreeFingerprint: sourceIdentity.worktreeFingerprint,
    extractor: {
      ...base,
      ...extractorOverrides,
      consumedInputs: extractorOverrides.consumedInputs ?? base.consumedInputs
    }
  })
}

function minimalMatrix({
  tiers,
  bundles,
  finalizer,
  commandGroups
} = {})
{
  const defaultTiers = tiers ?? [
    {
      id: 'validate-matrix',
      command: 'tools/test/lanes/noop.sh',
      executionDependsOn: [],
      evidenceClass: 'correctness',
      coverage: []
    },
    {
      id: 'static-governance',
      command: 'tools/test/lanes/static-governance.sh',
      executionDependsOn: ['validate-matrix'],
      evidenceClass: 'correctness',
      coverage: []
    },
    {
      id: 'backend-unit',
      command: 'tools/test/lanes/backend-unit.sh',
      executionDependsOn: [],
      evidenceClass: 'correctness',
      coverage: []
    },
    {
      id: 'release-final',
      command: 'tools/test/lanes/release-final.sh',
      executionDependsOn: [],
      requiresEvidenceFrom: ['static-governance', 'backend-unit'],
      evidenceClass: 'correctness',
      coverage: []
    }
  ]
  const defaultBundles = bundles ?? [
    {
      id: 'build-static',
      command: 'tools/test/bundles/build-static.sh',
      dependsOn: [],
      members: ['validate-matrix']
    },
    {
      id: 'frontend-tests',
      command: 'tools/test/bundles/frontend-tests.sh',
      dependsOn: [],
      members: ['static-governance']
    },
    {
      id: 'backend-tests',
      command: 'tools/test/bundles/backend-tests.sh',
      dependsOn: [],
      members: ['backend-unit']
    },
    {
      id: 'performance-evidence',
      command: 'tools/test/bundles/performance-evidence.sh',
      dependsOn: ['build-static', 'frontend-tests', 'backend-tests'],
      members: ['release-final']
    }
  ]
  const defaultFinalizer = finalizer ?? {
    id: 'release-final',
    commandKind: 'finalizer',
    command: 'tools/test/lanes/release-final.sh',
    summaryTierIds: ['release-final'],
    inputContractSchema: 'fsusblog.release-final-evidence-inputs.v1',
    outputReceiptSchema: 'fsusblog.release-final-test-evidence-binding.v1'
  }
  const defaultCommandGroups = commandGroups ?? {
    'frontend-static-governance': {
      schema: 'fsusblog.frontend-static-command-manifest.v2',
      lane: 'frontend-static-governance',
      commands: [
        {
          id: 'frontend-style-full',
          script: 'lint:full',
          access: 'write',
          stage: 'blocking-prebuild',
          dependsOn: []
        }
      ]
    },
    'frontend-runtime-contracts': {
      schema: 'fsusblog.test-command-manifest.v1',
      lane: 'frontend-runtime-contracts',
      commands: [{ id: 'worker-contracts', script: 'check:worker-contracts', access: 'read' }]
    }
  }

  // Emit a compact YAML-ish structure via JSON-compatible flow where possible is hard;
  // instead splice from the real matrix and override only the sections under test for most cases.
  return { defaultTiers, defaultBundles, defaultFinalizer, defaultCommandGroups }
}

test('test-matrix-fact-extractor is registered for browserless-production-correctness', () =>
{
  const registry = loadRegistry()
  const ownership = validateOwnershipAgainstBehaviorCatalog(registry, loadCatalog(), root)
  assert.equal(ownership.behaviorOwners.get('browserless-production-correctness'), extractorId)
  const extractor = registryExtractor()
  assert.equal(extractor.kind, 'compiled-assembly')
  assert.equal(extractor.entrypoint, 'tools/fact-extractors/test-matrix/extract.mjs')
  assert.equal(extractor.hermeticPolicy, 'exact-build-receipt')
  assert.equal(extractor.requiredBuildArtifact, 'runtime-role-observation')
  for (const source of TEST_MATRIX_DECLARED_FACT_SOURCES)
  {
    assert.ok(extractor.consumedInputs.includes(source), `missing fact source ${source}`)
  }
  for (const consumer of TEST_MATRIX_CONSUMER_INPUTS)
  {
    assert.ok(extractor.consumedInputs.includes(consumer), `missing consumer input ${consumer}`)
  }
  assert.equal(TEST_MATRIX_REQUIRED_FACT_KEYS.length, 18)
})

test('live matrix projects typed topology / release-final / production-fresh facts', async () =>
{
  const first = await runExtractor({ extractorId, repositoryRoot: root, useCache: false, buildIdentity: runtimeRoleBuild.buildIdentity })
  const second = await runExtractor({ extractorId, repositoryRoot: root, useCache: false, buildIdentity: runtimeRoleBuild.buildIdentity })
  assert.equal(first.receipt.status, 'ok', first.receipt.failureReasons?.join('\n'))
  assertDeterministicSemanticDigest(first.receipt, second.receipt)
  const facts = first.receipt.observations.facts
  for (const key of TEST_MATRIX_REQUIRED_FACT_KEYS)
  {
    assert.ok(Object.hasOwn(facts, key), `missing ${key}`)
  }
  assert.ok(facts['test.topology.tiers'].includes('static-governance'))
  assert.ok(facts['test.topology.tiers'].includes('production-correctness'))
  assert.ok(facts['test.topology.tiers'].includes('release-final'))
  assert.deepEqual(facts['test.topology.profiles'], ['production'])
  // Counterexample 1: docs may claim static gate precedes backend, but matrix has no such edge.
  const staticPredecessors = facts['test.static-governance.membership'].predecessors?.['static-governance'] ?? []
  assert.ok(!staticPredecessors.includes('backend-unit'))
  assert.ok(!staticPredecessors.includes('backend-tests'))
  assert.ok(facts['test.static-governance.membership'].bundleMemberships.includes('production.frontend-tests'))
  assert.equal(facts['release-final.finalizer-authority'].commandEntrypoint, 'tools/test/lanes/release-final.sh')
  assert.equal(facts['deployment.runtime-role-contract'].ownership.authorityState, 'conflict-unknown')
  assert.deepEqual(Object.keys(facts['deployment.runtime-role-contract'].modes).sort(), ['adaptive', 'single', 'static-role'])
  const blueGreen = facts['deployment.blue-green-contract']
  assert.equal(blueGreen.switchState, 'switching')
  assert.equal(blueGreen.rollbackRequiredState, 'rollback_required')
  assert.match(blueGreen.stopActiveResult, /refusing to stop active slot blue/u)
  assert.match(blueGreen.unknownIdentityResult, /active release identity does not match/u)
  assert.equal(blueGreen.rolloutFailureState, 'recovery_required')
  assert.equal(blueGreen.activeAssetAction, 'retain')
  assert.ok(blueGreen.activeAssetReasons.includes('active'))
  assert.equal(blueGreen.runtimeProtectionAuthorityState, 'observed-in-slot-state-machine-probe')
  assert.equal(blueGreen.artifactProtectionAuthorityState, 'observed-in-release-gc-plan-probe')
  assert.equal(blueGreen.schemaProtectionAuthorityState, 'not-expressed-by-current-authorities')
  assert.equal(blueGreen.volumeProtectionAuthorityState, 'not-expressed-by-current-authorities')
  assert.equal(blueGreen.claimEligible, false)
  assert.equal(blueGreen.authorityState, 'conflict-unknown')
  assert.deepEqual(Object.keys(blueGreen.authorityModules).sort(), ['releaseAssetsGc', 'rollout', 'slot'])
  for (const authority of Object.values(blueGreen.authorityModules))
  {
    assert.match(authority.sourceDigest, /^[a-f0-9]{64}$/u)
  }
  assert.equal(facts['release-final.output-schema'], 'fsusblog.release-final-test-evidence-binding.v1')
  const releaseFinal = facts['release-final.aggregate-contract']
  assert.equal(releaseFinal.inputCount, 21)
  assert.deepEqual(releaseFinal.selectedTierIds, ['release-final'])
  assert.equal(releaseFinal.artifactOnly, true)
  assert.equal(releaseFinal.executesTestCommands, false)
  assert.equal(releaseFinal.semanticAdapterContractProbe.completeMembershipStatus, 'success')
  assert.equal(releaseFinal.semanticAdapterContractProbe.missingMembershipStatus, 'failed')
  assert.ok(releaseFinal.semanticAdapterContractProbe.missingInputReasonKinds.includes('contract.missing-evidence'))
  assert.equal(releaseFinal.currentRunBindingState, 'not-observed-by-static-authority-extractor')
  assert.equal(releaseFinal.publishGateState, 'blocked-current-run-binding-unverified')
  assert.equal(releaseFinal.claimEligible, false)
  assert.equal(releaseFinal.authorityState, 'conflict-unknown')
  assert.ok(facts['release-final.required-input-schemas'].includes('fsusblog.release-final-evidence-inputs.v1'))
  assert.ok(facts['production-fresh.bundle-ordering'].bundleIds.includes('frontend-tests'))
  assert.ok(facts['production-fresh.bundle-ordering'].edges.some((edge) => edge.endsWith('->performance-evidence')))
  assert.match(first.receipt.observations.topologyDigest, /^[a-f0-9]{64}$/u)
  // Candidate admission predecessors are mechanical, not prose.
  assert.ok(
    facts['test.candidate-admission-predecessors'].executionDependsOn['production-correctness'].includes('fast')
  )
  assert.ok(
    facts['test.candidate-admission-predecessors'].executionDependsOn['production-correctness']
      .includes('behavior-doc-static-admission')
  )
  assert.ok(
    facts['test.candidate-admission-predecessors'].requiresEvidenceFrom['release-final'].includes('browser-contract')
  )
})

test('1) static-governance follows BehaviorDoc admission with no backend predecessor edge', () =>
{
  const result = extractFrom(root)
  assert.equal(result.status, 'ok', result.failureReasons?.join('\n'))
  const membership = result.observations.facts['test.static-governance.membership']
  const predecessors = membership.predecessors?.['static-governance'] ?? []
  assert.deepEqual(predecessors, ['behavior-doc-static-admission', 'test-inventory'])
  assert.ok(!predecessors.includes('backend-unit'))
  // The physical frontend bundle is released only by the external static admission.
  assert.ok(membership.bundleMemberships.includes('production.frontend-tests'))
  const frontendDepends = result.observations.facts['test.topology.bundles'].dependsOn['production.frontend-tests']
  assert.deepEqual(frontendDepends, ['behavior-doc-static-admission'])
})

test('2) lane second tier dispatch fails closed', () =>
{
  const directory = fixtureRepository()
  try
  {
    write(directory, 'tools/test/lanes/rogue-dispatch.sh', `#!/usr/bin/env bash
set -euo pipefail
case "$TIER" in
  static-governance)
    echo static
    ;;
  backend-unit)
    echo backend
    ;;
  release-final)
    echo final
    ;;
esac
`)
    const result = extractFrom(directory)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /second tier dispatch/u.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('3) package alias to retired tier fails closed', () =>
{
  const directory = fixtureRepository()
  try
  {
    const packageJson = JSON.parse(readFileSync(path.join(directory, 'src/frontend/package.json'), 'utf8'))
    packageJson.scripts['test:production'] = 'bash ../../tools/test.sh backend-chaos'
    write(directory, 'src/frontend/package.json', `${JSON.stringify(packageJson, null, 2)}\n`)
    const result = extractFrom(directory)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /retired tier alias|backend-chaos/u.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('4) release-final consumer missing check-release-final fails closed', () =>
{
  const directory = fixtureRepository()
  try
  {
    write(directory, 'tools/test/lanes/release-final.sh', `#!/usr/bin/env bash
set -euo pipefail
echo 'not the finalizer authority'
`)
    const result = extractFrom(directory)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /check-release-final/u.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('5) adding a production bundle changes topologyDigest', () =>
{
  const directory = fixtureRepository()
  try
  {
    const baseline = extractFrom(directory)
    assert.equal(baseline.status, 'ok', baseline.failureReasons?.join('\n'))
    const matrixPath = path.join(directory, 'tests/matrix.yml')
    let text = readFileSync(matrixPath, 'utf8')
    // Insert a new empty-depends bundle into production profile after build-static block marker.
    const needle = '            - id: build-static\n'
    assert.ok(text.includes(needle))
    const insertion = `            - id: extra-topology-bundle
              command: tools/test/bundles/build-static.sh
              deadlineWeight: 1
              minimumDeadlineShare: 0.01
              dependsOn: []
              members: [validate-matrix]
              resourceClass: cpu
              cpuWeight: 1
              memoryWeight: 1
              minCpuUnits: 1
              startupMinCpuUnits: 1
              startupMemoryWeight: 1
              startupPriority: 1
              exclusiveResources: []
`
    text = text.replace(needle, `${insertion}${needle}`)
    writeFileSync(matrixPath, text)
    const mutated = extractFrom(directory)
    assert.equal(mutated.status, 'ok', mutated.failureReasons?.join('\n'))
    assert.notEqual(baseline.observations.topologyDigest, mutated.observations.topologyDigest)
    assert.ok(
      mutated.observations.facts['production-fresh.bundle-ordering'].bundleIds.includes('extra-topology-bundle')
    )
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('6) dependency cycle fails closed', () =>
{
  const directory = fixtureRepository()
  try
  {
    const matrixPath = path.join(directory, 'tests/matrix.yml')
    let text = readFileSync(matrixPath, 'utf8')
    // Force a cycle between validate-matrix and static-governance by rewriting both edges.
    text = text.replace(
      /    - id: validate-matrix\n[\s\S]*?executionDependsOn: \[[^\]]*\]/u,
      (block) => block.replace(/executionDependsOn: \[[^\]]*\]/u, 'executionDependsOn: [static-governance]')
    )
    // static-governance already depends on validate-matrix in the real matrix.
    writeFileSync(matrixPath, text)
    const result = extractFrom(directory)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /cycle/iu.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('7) command group membership drop changes observation digest', () =>
{
  const directory = fixtureRepository()
  try
  {
    const baseline = extractFrom(directory)
    assert.equal(baseline.status, 'ok', baseline.failureReasons?.join('\n'))
    const matrixPath = path.join(directory, 'tests/matrix.yml')
    let text = readFileSync(matrixPath, 'utf8')
    // Remove one known frontend-static-governance command entry.
    const removed = text.replace(
      /\n            - id: "frontend-style-full"\n[\s\S]*?(?=\n            - id: )/u,
      '\n'
    )
    assert.notEqual(removed, text)
    writeFileSync(matrixPath, removed)
    const mutated = extractFrom(directory)
    assert.equal(mutated.status, 'ok', mutated.failureReasons?.join('\n'))
    assert.notEqual(baseline.observations.topologyDigest, mutated.observations.topologyDigest)
    const commandIds = mutated.observations.facts['test.topology.command-groups'].commandIds['frontend-static-governance']
    assert.ok(!commandIds.includes('frontend-style-full'))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('8) extractor refuses docs/testing as fact source', () =>
{
  const directory = fixtureRepository()
  try
  {
    write(directory, 'docs/testing.generated.md', '# Generated Test Matrix\n\nstatic-governance depends on backend-unit\n')
    const extractor = {
      ...registryExtractor(),
      consumedInputs: [
        ...registryExtractor().consumedInputs,
        'docs/testing.generated.md'
      ]
    }
    // Ensure the forbidden input file exists for the read attempt path.
    assert.ok(existsSync(path.join(directory, 'docs/testing.generated.md')))
    const result = extractTestMatrix({ repositoryRoot: directory, extractor, buildIdentity: runtimeRoleBuild.buildIdentity })
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /docs\/testing|refuses/u.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('runtime-role observation requires exact receipt and rejects semantic tamper', () =>
{
  const directory = fixtureRepository()
  try
  {
    const extractor = registryExtractor()
    const missingIdentity = extractTestMatrix({ repositoryRoot: directory, extractor })
    assert.equal(missingIdentity.status, 'failed')
    assert.match(missingIdentity.failureReasons.join('\n'), /exact runtime-role-observation buildIdentity/iu)

    const artifact = path.join(directory, '.tmp/contracts/runtime-role/runtime-role-observation.json')
    const observation = JSON.parse(readFileSync(artifact, 'utf8'))
    observation.staticRoleCapabilities.web = ['tampered.capability']
    const unsigned = {
      schema: observation.schema,
      modes: observation.modes,
      staticRoleCapabilities: observation.staticRoleCapabilities,
      unsupportedCombinations: observation.unsupportedCombinations,
      ownership: observation.ownership
    }
    observation.observationDigest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')
    writeFileSync(artifact, `${JSON.stringify(observation, null, 2)}\n`)
    const artifactDigest = createHash('sha256').update(readFileSync(artifact)).digest('hex')
    const semanticTamper = extractTestMatrix({
      repositoryRoot: directory,
      extractor,
      buildIdentity: { ...runtimeRoleBuild.buildIdentity, artifactDigest }
    })
    assert.equal(semanticTamper.status, 'failed')
    assert.match(semanticTamper.failureReasons.join('\n'), /build receipt digest mismatch/iu)
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('missing lane entrypoint declared by matrix fails closed', () =>
{
  const directory = fixtureRepository()
  try
  {
    rmSync(path.join(directory, 'tools/test/lanes/static-governance.sh'), { force: true })
    const result = extractFrom(directory)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /missing lane entrypoint/u.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('package script that bypasses public entry for test:production fails', () =>
{
  const directory = fixtureRepository()
  try
  {
    const packageJson = JSON.parse(readFileSync(path.join(directory, 'src/frontend/package.json'), 'utf8'))
    packageJson.scripts['test:production'] = 'bash ../../tools/test/lanes/production-correctness-receipt.sh'
    write(directory, 'src/frontend/package.json', `${JSON.stringify(packageJson, null, 2)}\n`)
    const result = extractFrom(directory)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /bypass|public entry|direct lane/u.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reordering dependency edges changes topologyDigest', () =>
{
  const directory = fixtureRepository()
  try
  {
    const baseline = extractFrom(directory)
    assert.equal(baseline.status, 'ok', baseline.failureReasons?.join('\n'))
    const matrixPath = path.join(directory, 'tests/matrix.yml')
    let text = readFileSync(matrixPath, 'utf8')
    // Add an extra executionDependsOn edge from backend-unit (or first match) to static-governance.
    text = text.replace(
      /    - id: static-governance\n[\s\S]*?executionDependsOn: \[[^\]]*\]/u,
      (block) => block.replace(
        /executionDependsOn: \[[^\]]*\]/u,
        'executionDependsOn: [validate-matrix, frontend-build]'
      )
    )
    writeFileSync(matrixPath, text)
    const mutated = extractFrom(directory)
    // frontend-build exists in real matrix; edge addition must alter digest.
    assert.equal(mutated.status, 'ok', mutated.failureReasons?.join('\n'))
    assert.notEqual(baseline.observations.topologyDigest, mutated.observations.topologyDigest)
    assert.ok(
      mutated.observations.facts['test.topology.dependencies'].edges.includes('frontend-build->static-governance')
    )
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('release-final required-evidence ledger digest tamper fails closed', () =>
{
  const directory = fixtureRepository()
  try
  {
    const relative = 'config/testing/required-evidence-authority-ledger.json'
    const ledger = JSON.parse(readFileSync(path.join(directory, relative), 'utf8'))
    ledger.entries[0].receiptSchema = 'fsusblog.ci.job-result.v1'
    write(directory, relative, `${JSON.stringify(ledger, null, 2)}\n`)
    const result = extractFrom(directory)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /contentDigest is stale or tampered/u.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('release-final matrix membership drift from the exact ledger set fails closed', () =>
{
  const directory = fixtureRepository()
  try
  {
    const matrixPath = path.join(directory, 'tests/matrix.yml')
    const original = readFileSync(matrixPath, 'utf8')
    const mutated = original.replace('              behavior-document-consistency-final,\n', '')
    assert.notEqual(mutated, original)
    writeFileSync(matrixPath, mutated)
    const result = extractFrom(directory)
    assert.equal(result.status, 'failed')
    assert.ok(result.failureReasons.some((reason) => /missing canonical evidence inputs/u.test(reason)))
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('semantic digest is stable across identical live runs', async () =>
{
  const first = await runExtractor({ extractorId, repositoryRoot: root, useCache: false, buildIdentity: runtimeRoleBuild.buildIdentity })
  const second = await runExtractor({ extractorId, repositoryRoot: root, useCache: false, buildIdentity: runtimeRoleBuild.buildIdentity })
  assert.equal(first.receipt.status, 'ok')
  assert.equal(semanticDigestFromReceipt(first.receipt), semanticDigestFromReceipt(second.receipt))
})

// Keep unused helper referenced so the compact matrix builder stays available for future fixtures.
void minimalMatrix
