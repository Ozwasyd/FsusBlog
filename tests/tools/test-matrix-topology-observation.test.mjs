import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
    chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
    cpSync, existsSync, readdirSync
} from 'node:fs';
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
import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { sealSourceIdentity } from '../../tools/fact-extractors/identity.mjs'
import {
  buildIdentitiesFromMinimalReceipt,
  minimalContractSourceClosureDigests,
  runMinimalContractBuild
} from '../../tools/docs/behavior-doc-minimal-contract-build.mjs'
import {
  extract as extractTestMatrix,
  TEST_MATRIX_REQUIRED_FACT_KEYS,
  TEST_MATRIX_DECLARED_FACT_SOURCES,
  TEST_MATRIX_CONSUMER_INPUTS
} from '../../tools/fact-extractors/test-matrix/extract.mjs'
import { runtimeRoleProject } from '../../tools/contracts/lib/runtime-role-observation.mjs'

const extractorId = 'test-matrix-fact-extractor'
const sourceIdentity = sealSourceIdentity(root)
const minimalBuild = runMinimalContractBuild({
  repositoryRoot: root,
  runId: 'runtime-role-observation-tests',
  sourceIdentity
})
const runtimeRoleBuild = {
  buildIdentity: minimalBuild.buildIdentities['runtime-role-observation'],
  buildReceiptPath: path.relative(root, minimalBuild.identityReceiptFile).replaceAll(path.sep, '/')
}
const runtimeRoleOutputRoot = minimalBuild.receipt
  .artifacts['runtime-role-observation']
  .buildReceipt
  .reproducibleBuild
  .outputRoot
let trustedRuntimeBuildVerified = false

function loadRuntimeBuildBinding(repositoryRoot, buildReceiptPath = runtimeRoleBuild.buildReceiptPath)
{
  const receipt = JSON.parse(readFileSync(path.join(repositoryRoot, buildReceiptPath), 'utf8'))
  return {
    receipt,
    binding: receipt.artifacts['runtime-role-observation'],
    buildReceiptPath
  }
}

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

function resealRuntimeObservation(observation)
{
  const unsigned = {
    schema: observation.schema,
    modes: observation.modes,
    staticRoleCapabilities: observation.staticRoleCapabilities,
    unsupportedCombinations: observation.unsupportedCombinations,
    ownership: observation.ownership,
    deploymentAuthority: observation.deploymentAuthority,
    schemaOverlap: observation.schemaOverlap
  }
  observation.observationDigest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')
}

function canonical(value)
{
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
  {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function extractMutatedRuntimeObservation(directory, mutate)
{
  const { receipt, binding, buildReceiptPath } = loadRuntimeBuildBinding(directory)
  const artifact = path.join(directory, binding.path)
  const observation = JSON.parse(readFileSync(artifact, 'utf8'))
  mutate(observation)
  resealRuntimeObservation(observation)
  writeFileSync(artifact, `${JSON.stringify(observation, null, 2)}\n`)
  const artifactDigest = createHash('sha256').update(readFileSync(artifact)).digest('hex')
  binding.artifactDigest = artifactDigest
  binding.buildReceipt.artifactDigest = artifactDigest
  binding.buildReceipt.externalOracle = observation.deploymentAuthority.effectiveCompose?.oracle
  binding.buildReceipt.externalOracleVersion = observation.deploymentAuthority.effectiveCompose?.oracleVersion
  binding.buildReceipt.effectiveComposeModelDigest = observation.deploymentAuthority.effectiveCompose?.modelDigest
  binding.buildReceipt.deploymentAuthoritySchema = observation.deploymentAuthority.authoritySchema
  binding.buildReceipt.deploymentAuthorityContentDigest = observation.deploymentAuthority.authorityContentDigest
  binding.buildReceipt.deploymentObservationDigest = observation.deploymentAuthority.observationDigest
  receipt.contentDigest = null
  receipt.contentDigest = digestValue(receipt)
  writeFileSync(path.join(directory, buildReceiptPath), `${JSON.stringify(receipt, null, 2)}\n`)
  const identity = buildIdentitiesFromMinimalReceipt(receipt)['runtime-role-observation']
  return extractTestMatrix({
    repositoryRoot: directory,
    extractor: registryExtractor(),
    sourceCommit: sourceIdentity.sourceCommit,
    worktreeFingerprint: sourceIdentity.worktreeFingerprint,
    buildIdentity: identity,
    buildReceiptPath
  })
}

function fixtureRepository(options = {})
{
  if (!trustedRuntimeBuildVerified)
  {
    const current = extractTestMatrix({
      repositoryRoot: root,
      extractor: registryExtractor(),
      sourceCommit: sourceIdentity.sourceCommit,
      worktreeFingerprint: sourceIdentity.worktreeFingerprint,
      buildIdentity: runtimeRoleBuild.buildIdentity,
      buildReceiptPath: runtimeRoleBuild.buildReceiptPath
    })
    assert.equal(current.status, 'ok', current.failureReasons?.join('\n'))
    trustedRuntimeBuildVerified = true
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-matrix-topo-'))
  for (const relative of [
    'tests/matrix.yml',
    'tests/matrix.schema.json',
    'tests/coverage-registry.json',
    'config/testing/producer-execution-class-contract.json',
    'src/frontend/package.json',
    'tools/docs/generate-testing-docs.mjs',
    'tools/test-matrix/behavior-doc-static-admission-contract.mjs',
    runtimeRoleProject,
    'tests/governance/monolithic-distributed-architecture.json',
    'src/backend/FsusBlog.Server.csproj',
    'ops/docker/FsusBlog.Server.Dockerfile',
    'ops/docker/docker-compose.production.yml',
    'tools/governance/check-monolithic-distributed-architecture.mjs',
    'tools/deployment/slot-lib.mjs',
    'tools/deployment/release-rollout-lib.mjs',
    'tools/storage/release-gc.mjs',
    'config/deployment/destructive-operation-authority.json',
    'tools/deployment/destructive-operation-authority.mjs',
    'src/backend/Infrastructure/SchemaMigration/OnlineSchemaMigrationCompatibility.cs',
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
    'tools/test/run-runtime-order-equivalence.mjs',
    'tools/test/verify-release-reliability-receipt.mjs',
    'tools/test-runtime/order-equivalence.mjs',
    'tools/test/lanes'
  ])
  {
    copy(directory, relative)
  }
  for (const entry of minimalBuild.receipt.sourceClosureDigests)
  {
    if (existsSync(path.join(root, entry.path))) copy(directory, entry.path)
  }
  if (options.matrixText)
  {
    write(directory, 'tests/matrix.yml', options.matrixText)
  }
  copy(directory, minimalBuild.receipt.buildRoot)
  copy(directory, runtimeRoleOutputRoot)
  return directory
}

function bindFixtureBuild(repositoryRoot)
{
  const originalIdentity = runtimeRoleBuild.buildIdentity
  const originalReceipt = JSON.parse(readFileSync(
    path.join(repositoryRoot, runtimeRoleBuild.buildReceiptPath),
    'utf8'
  ))
  const registry = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'config/contracts/behavior-fact-extractors.json'),
    'utf8'
  ))
  const compiled = registry.extractors.filter((entry) => entry.kind === 'compiled-assembly')
  const sourceClosureDigests = minimalContractSourceClosureDigests(repositoryRoot, compiled)
  const buildKey = digestValue({
    sourceIdentity: {
      sourceCommit: originalReceipt.sourceCommit,
      worktreeFingerprint: originalReceipt.worktreeFingerprint
    },
    toolchain: originalReceipt.toolchain,
    sourceClosureDigests
  })
  if (buildKey === originalReceipt.buildKey)
  {
    return {
      buildIdentity: originalIdentity,
      buildReceiptPath: runtimeRoleBuild.buildReceiptPath
    }
  }
  const receipt = structuredClone(originalReceipt)
  const oldBuildRoot = receipt.buildRoot
  const newBuildRoot = `.tmp/behavior-doc-contract-builds/${buildKey}`
  copy(repositoryRoot, oldBuildRoot)
  const copiedOldRoot = path.join(repositoryRoot, oldBuildRoot)
  const copiedNewRoot = path.join(repositoryRoot, newBuildRoot)
  mkdirSync(path.dirname(copiedNewRoot), { recursive: true })
  cpSync(copiedOldRoot, copiedNewRoot, { recursive: true })
  receipt.buildKey = buildKey
  receipt.buildRoot = newBuildRoot
  receipt.sourceClosureDigests = sourceClosureDigests
  receipt.sourceDigest = digestValue(sourceClosureDigests)
  for (const artifact of Object.values(receipt.artifacts))
  {
    artifact.path = artifact.path.replace(oldBuildRoot, newBuildRoot)
  }
  const runtime = receipt.artifacts['runtime-role-observation']
  const oldRuntimeRoot = runtime.buildReceipt.reproducibleBuild.outputRoot
  const newRuntimeRoot = `.tmp/runtime-role-reproducible-builds/${buildKey}`
  const newAssemblyPath = runtime.assemblyPath.replace(oldRuntimeRoot, newRuntimeRoot)
  copy(repositoryRoot, oldRuntimeRoot)
  const newRuntimeAbsolute = path.join(repositoryRoot, newRuntimeRoot)
  mkdirSync(path.dirname(newRuntimeAbsolute), { recursive: true })
  cpSync(path.join(repositoryRoot, oldRuntimeRoot), newRuntimeAbsolute, { recursive: true })
  runtime.assemblyPath = newAssemblyPath
  runtime.deploymentArtifactPath = runtime.deploymentArtifactPath.replace(oldBuildRoot, newBuildRoot)
  runtime.buildReceipt.assemblyPath = newAssemblyPath
  runtime.buildReceipt.deploymentArtifactPath = runtime.deploymentArtifactPath
  runtime.buildReceipt.reproducibleBuild.outputRoot = newRuntimeRoot
  runtime.buildReceipt.reproducibleBuild.assemblyPath = newAssemblyPath
  runtime.buildReceipt.reproducibleBuild.sourceClosureDigest = digestValue(sourceClosureDigests)
  runtime.buildReceipt.reproducibleBuild.command = runtime.buildReceipt.reproducibleBuild.command
    .map((value) => value === oldRuntimeRoot ? newRuntimeRoot : value)
  receipt.contentDigest = null
  receipt.contentDigest = digestValue(receipt)
  const receiptPath = path.join(repositoryRoot, newBuildRoot, 'receipts', `${receipt.runId}.json`)
  mkdirSync(path.dirname(receiptPath), { recursive: true })
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  return {
    buildIdentity: buildIdentitiesFromMinimalReceipt(receipt)['runtime-role-observation'],
    buildReceiptPath: path.relative(repositoryRoot, receiptPath).replaceAll(path.sep, '/')
  }
}

function extractFrom(repositoryRoot, extractorOverrides = {})
{
  const base = registryExtractor()
  const build = repositoryRoot === root ? runtimeRoleBuild : bindFixtureBuild(repositoryRoot)
  return extractTestMatrix({
    repositoryRoot,
    buildIdentity: build.buildIdentity,
    buildReceiptPath: build.buildReceiptPath,
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

test('runtime-role replay ignores external TMPDIR and cleans repeated compiled observations', () =>
{
    const external = mkdtempSync(path.join(os.tmpdir(), 'runtime-role-replay-external-'));
    const previous = process.env.TMPDIR;
    const owner = path.join(root, '.tmp/contracts/runtime-role');
    try
    {
        assert.ok(!external.startsWith(`${root}${path.sep}`));
        process.env.TMPDIR = external;
        for (let attempt = 0; attempt < 2; attempt += 1)
        {
            const result = extractTestMatrix({
                repositoryRoot: root,
                extractor: registryExtractor(),
                sourceCommit: sourceIdentity.sourceCommit,
                worktreeFingerprint: sourceIdentity.worktreeFingerprint,
                buildIdentity: runtimeRoleBuild.buildIdentity,
                buildReceiptPath: runtimeRoleBuild.buildReceiptPath
            });
            assert.equal(result.status, 'ok', result.failureReasons?.join('\n'));
            // SDK verification may create NuGet scratch here; replay output must stay in its canonical owner.
            assert.ok(!readdirSync(external).some((name) =>
                name.startsWith('runtime-role-replay-')
                || name.startsWith('replay-')
                || name === 'runtime-role-observation.json'));
            assert.ok(!readdirSync(owner).some((name) => name.startsWith('replay-')));
        }
    }
    finally
    {
        if (previous === undefined)
        {
            delete process.env.TMPDIR;
        }
        else
        {
            process.env.TMPDIR = previous;
        }
        rmSync(external, { recursive: true, force: true });
    }
});

test('compiled runtime-role producer still refuses external and symlinked replay output', () =>
{
    const external = mkdtempSync(path.join(os.tmpdir(), 'runtime-role-output-external-'));
    const refusalDirectory = mkdtempSync(path.join(root, '.tmp/contracts/runtime-role/refusal-'));
    try
    {
        assert.ok(!external.startsWith(`${root}${path.sep}`));
        const { binding } = loadRuntimeBuildBinding(root);
        const output = path.join(external, 'rejected.json');
        const result = spawnSync('dotnet', [
            path.join(root, binding.assemblyPath),
            '--deployment-observation', path.join(root, binding.deploymentArtifactPath),
            '--output', output
        ], { cwd: root, encoding: 'utf8', timeout: 30_000 });
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}\n${result.stderr}`, /runtime_role_output_path_not_canonical:output/u);
        assert.equal(existsSync(output), false);
        const alias = path.join(refusalDirectory, 'outside');
        symlinkSync(external, alias, 'dir');
        const symlinkedOutput = path.join(alias, 'rejected.json');
        const symlinkedResult = spawnSync('dotnet', [
            path.join(root, binding.assemblyPath),
            '--deployment-observation', path.join(root, binding.deploymentArtifactPath),
            '--output', symlinkedOutput
        ], { cwd: root, encoding: 'utf8', timeout: 30_000 });
        assert.notEqual(symlinkedResult.status, 0);
        assert.match(`${symlinkedResult.stdout}\n${symlinkedResult.stderr}`, /runtime_role_output_path_symlink:output/u);
        assert.equal(existsSync(output), false);
        assert.deepEqual(readdirSync(external), []);
    }
    finally
    {
        rmSync(refusalDirectory, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
    }
});

test('runtime-role replay refuses a symlinked canonical owner before writing outside', () =>
{
    const directory = fixtureRepository();
    const external = mkdtempSync(path.join(os.tmpdir(), 'runtime-role-owner-external-'));
    try
    {
        const build = bindFixtureBuild(directory);
        const owner = path.join(directory, '.tmp/contracts/runtime-role');
        mkdirSync(path.dirname(owner), { recursive: true });
        assert.equal(existsSync(owner), false);
        symlinkSync(external, owner, 'dir');
        const result = extractTestMatrix({
            repositoryRoot: directory,
            extractor: registryExtractor(),
            sourceCommit: sourceIdentity.sourceCommit,
            worktreeFingerprint: sourceIdentity.worktreeFingerprint,
            buildIdentity: build.buildIdentity,
            buildReceiptPath: build.buildReceiptPath
        });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /symbolic link/u);
        assert.deepEqual(readdirSync(external), []);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
    }
});

test('live matrix projects typed topology / release-final / production-fresh facts', async () =>
{
  const first = await runExtractor({
    extractorId,
    repositoryRoot: root,
    useCache: false,
    buildIdentity: runtimeRoleBuild.buildIdentity,
    buildReceiptPath: runtimeRoleBuild.buildReceiptPath
  })
  const second = await runExtractor({
    extractorId,
    repositoryRoot: root,
    useCache: false,
    buildIdentity: runtimeRoleBuild.buildIdentity,
    buildReceiptPath: runtimeRoleBuild.buildReceiptPath
  })
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
  const runtimeRole = facts['deployment.runtime-role-contract']
  assert.equal(runtimeRole.ownership.authorityState, 'closed-current')
  assert.equal(runtimeRole.ownership.claimEligible, true)
  assert.equal(runtimeRole.ownership.process, 'one-fsusblog-server-process-per-application-container')
  assert.equal(runtimeRole.ownership.container, 'one-application-container-per-release-slot')
  assert.equal(runtimeRole.ownership.service, 'fsusblog.server')
  assert.equal(runtimeRole.ownership.separation, 'blue-green-release-slots-not-runtime-role-services')
  assert.match(runtimeRole.deploymentAuthority.observationDigest, /^sha256:[a-f0-9]{64}$/u)
  assert.equal(runtimeRole.deploymentAuthority.effectiveCompose.oracle, 'docker-compose-config-json-no-interpolate')
  assert.equal(runtimeRole.deploymentAuthority.effectiveCompose.dockerExecutable.canonicalPath, '/usr/bin/docker')
  assert.match(runtimeRole.deploymentAuthority.effectiveCompose.dockerExecutable.digest, /^[a-f0-9]{64}$/u)
  assert.match(runtimeRole.deploymentAuthority.effectiveCompose.composeImplementation.digest, /^[a-f0-9]{64}$/u)
  assert.equal(runtimeRole.deploymentAuthority.effectiveCompose.defaultServices['fsusblog.server'].profileState, 'default-active')
  assert.equal(runtimeRole.schemaOverlap.sourceReadiness, 'ready')
  assert.notEqual(runtimeRole.schemaOverlap.sourceReleaseId, runtimeRole.schemaOverlap.targetReleaseId)
  assert.equal(runtimeRole.schemaOverlap.sameReleaseFailureCode, 'schema_previous_rollback_release_not_distinct')
  assert.ok(runtimeRole.schemaOverlap.missingExpandFailureCodes.includes('schema_expand_pending'))
  assert.deepEqual(Object.keys(facts['deployment.runtime-role-contract'].modes).sort(), ['adaptive', 'single', 'static-role'])
  const blueGreen = facts['deployment.blue-green-contract']
  assert.equal(blueGreen.switchState, 'switching')
  assert.equal(blueGreen.rollbackRequiredState, 'rollback_required')
  assert.match(blueGreen.stopActiveResult, /refusing to stop active slot blue/u)
  assert.match(blueGreen.unknownIdentityResult, /active release identity does not match/u)
  assert.equal(blueGreen.rolloutFailureState, 'recovery_required')
  assert.equal(blueGreen.activeAssetAction, 'retain')
  assert.ok(blueGreen.activeAssetReasons.includes('active'))
  assert.equal(blueGreen.evidenceClass, 'synthetic-library-proof')
  assert.equal(blueGreen.runtimeProtectionAuthorityState, 'synthetic-library-proof')
  assert.equal(blueGreen.artifactProtectionAuthorityState, 'synthetic-library-proof')
  assert.equal(blueGreen.schemaProtectionAuthorityState, 'synthetic-library-proof')
  assert.equal(blueGreen.volumeProtectionAuthorityState, 'synthetic-library-proof')
  assert.equal(blueGreen.destructiveAuthority.volumeCleanupStatus, 'unsupported')
  assert.equal(blueGreen.destructiveAuthority.schemaCleanupStatus, 'unsupported')
  assert.equal(blueGreen.volumeScopes['slot-private'].length, 3)
  assert.equal(blueGreen.claimEligible, false)
  assert.deepEqual(blueGreen.claimEligibilityReasons, ['production-current-active-resource-evidence-absent'])
  assert.equal(blueGreen.authorityState, 'synthetic-library-proof')
  assert.deepEqual(Object.keys(blueGreen.authorityModules).sort(), [
    'destructiveOperations', 'onlineSchema', 'releaseAssetsGc', 'rollout', 'slot', 'topologyAuthority'
  ])
  for (const authority of Object.values(blueGreen.authorityModules))
  {
    assert.match(authority.sourceDigest, /^[a-f0-9]{64}$/u)
  }
  assert.equal(facts['release-final.output-schema'], 'fsusblog.release-final-test-evidence-binding.v1')
  const releaseFinal = facts['release-final.aggregate-contract']
  assert.equal(releaseFinal.inputCount, 22)
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
    assert.ok(
      result.failureReasons.some((reason) => /second tier dispatch/u.test(reason)),
      result.failureReasons.join('\n')
    )
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
    const build = bindFixtureBuild(directory)
    const result = extractTestMatrix({
      repositoryRoot: directory,
      extractor,
      sourceCommit: sourceIdentity.sourceCommit,
      worktreeFingerprint: sourceIdentity.worktreeFingerprint,
      buildIdentity: build.buildIdentity,
      buildReceiptPath: build.buildReceiptPath
    })
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

    const build = bindFixtureBuild(directory)
    const { binding } = loadRuntimeBuildBinding(directory, build.buildReceiptPath)
    const artifact = path.join(directory, binding.path)
    const observation = JSON.parse(readFileSync(artifact, 'utf8'))
    observation.staticRoleCapabilities.web = ['tampered.capability']
    const unsigned = {
      schema: observation.schema,
      modes: observation.modes,
      staticRoleCapabilities: observation.staticRoleCapabilities,
      unsupportedCombinations: observation.unsupportedCombinations,
      ownership: observation.ownership,
      deploymentAuthority: observation.deploymentAuthority,
      schemaOverlap: observation.schemaOverlap
    }
    observation.observationDigest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')
    writeFileSync(artifact, `${JSON.stringify(observation, null, 2)}\n`)
    const artifactDigest = createHash('sha256').update(readFileSync(artifact)).digest('hex')
    const semanticTamper = extractTestMatrix({
      repositoryRoot: directory,
      extractor,
      sourceCommit: sourceIdentity.sourceCommit,
      worktreeFingerprint: sourceIdentity.worktreeFingerprint,
      buildIdentity: { ...build.buildIdentity, artifactDigest },
      buildReceiptPath: build.buildReceiptPath
    })
    assert.equal(semanticTamper.status, 'failed')
    assert.match(semanticTamper.failureReasons.join('\n'), /artifact binding is not exact/iu)
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('runtime-role upstream source, parent receipt, assembly and deployment identities fail closed', () =>
{
  for (const [label, mutate, pattern] of [
    [
      'source commit',
      ({ receipt }) => { receipt.sourceCommit = '0'.repeat(40) },
      /minimal build receipt identity mismatch/iu
    ],
    [
      'parent receipt',
      ({ identity }) => { identity.receiptDigest = '0'.repeat(64) },
      /minimal build receipt identity mismatch/iu
    ],
    [
      'assembly',
      ({ receipt }) => { receipt.artifacts['runtime-role-observation'].assemblyDigest = '0'.repeat(64) },
      /artifact or assembly digest mismatch/iu
    ],
    [
      'deployment artifact',
      ({ receipt }) => {
        receipt.artifacts['runtime-role-observation'].deploymentArtifactDigest = '0'.repeat(64)
      },
      /artifact or assembly digest mismatch/iu
    ]
  ])
  {
    const directory = fixtureRepository()
    try
    {
      const build = bindFixtureBuild(directory)
      const identity = structuredClone(build.buildIdentity)
      const { receipt } = loadRuntimeBuildBinding(directory, build.buildReceiptPath)
      mutate({ identity, receipt })
      if (label !== 'parent receipt')
      {
        receipt.contentDigest = null
        receipt.contentDigest = digestValue(receipt)
        identity.receiptDigest = receipt.contentDigest
        writeFileSync(
          path.join(directory, build.buildReceiptPath),
          `${JSON.stringify(receipt, null, 2)}\n`
        )
      }
      const result = extractTestMatrix({
        repositoryRoot: directory,
        extractor: registryExtractor(),
        sourceCommit: sourceIdentity.sourceCommit,
        worktreeFingerprint: sourceIdentity.worktreeFingerprint,
        buildIdentity: identity,
        buildReceiptPath: build.buildReceiptPath
      })
      assert.equal(result.status, 'failed', label)
      assert.match(result.failureReasons.join('\n'), pattern, label)
    }
    finally
    {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('coordinated DLL, raw observation and artifact reseal cannot replace the trusted upstream build', () =>
{
  const directory = fixtureRepository()
  try
  {
    const build = bindFixtureBuild(directory)
    const loaded = loadRuntimeBuildBinding(directory, build.buildReceiptPath)
    const { receipt, binding } = loaded
    const assemblyPath = path.join(directory, binding.assemblyPath)
    writeFileSync(assemblyPath, 'coordinated-fake-runtime-role-assembly')
    const assemblyDigest = createHash('sha256').update(readFileSync(assemblyPath)).digest('hex')

    const deploymentPath = path.join(directory, binding.deploymentArtifactPath)
    const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'))
    deployment.effectiveCompose.oracleVersion = 'coordinated-fake'
    const { observationDigest: _deploymentDigest, ...deploymentUnsigned } = deployment
    deployment.observationDigest = `sha256:${createHash('sha256')
      .update(canonical(deploymentUnsigned)).digest('hex')}`
    writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`)
    const deploymentDigest = createHash('sha256').update(readFileSync(deploymentPath)).digest('hex')

    const artifactPath = path.join(directory, binding.path)
    const observation = JSON.parse(readFileSync(artifactPath, 'utf8'))
    observation.staticRoleCapabilities.web = ['coordinated.fake']
    observation.deploymentAuthority = deployment
    resealRuntimeObservation(observation)
    writeFileSync(artifactPath, `${JSON.stringify(observation, null, 2)}\n`)
    const artifactDigest = createHash('sha256').update(readFileSync(artifactPath)).digest('hex')

    binding.artifactDigest = artifactDigest
    binding.assemblyDigest = assemblyDigest
    binding.deploymentArtifactDigest = deploymentDigest
    Object.assign(binding.buildReceipt, {
      artifactDigest,
      assemblyDigest,
      deploymentArtifactDigest: deploymentDigest,
      externalOracleVersion: 'coordinated-fake',
      effectiveComposeModelDigest: deployment.effectiveCompose.modelDigest,
      deploymentObservationDigest: deployment.observationDigest
    })
    binding.buildReceipt.reproducibleBuild.assemblyDigest = assemblyDigest
    receipt.contentDigest = null
    receipt.contentDigest = digestValue(receipt)
    writeFileSync(
      path.join(directory, build.buildReceiptPath),
      `${JSON.stringify(receipt, null, 2)}\n`
    )
    const identity = buildIdentitiesFromMinimalReceipt(receipt)['runtime-role-observation']

    const result = extractTestMatrix({
      repositoryRoot: directory,
      extractor: registryExtractor(),
      sourceCommit: sourceIdentity.sourceCommit,
      worktreeFingerprint: sourceIdentity.worktreeFingerprint,
      buildIdentity: identity,
      buildReceiptPath: build.buildReceiptPath
    })
    assert.equal(result.status, 'failed')
    assert.match(result.failureReasons.join('\n'), /independently verified upstream build/iu)
  }
  finally
  {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('nested source and artifact symlinks fail closed before digest consumption', () =>
{
  for (const kind of ['source', 'artifact'])
  {
    const directory = fixtureRepository()
    try
    {
      const build = bindFixtureBuild(directory)
      if (kind === 'source')
      {
        const source = path.join(
          directory,
          'src/backend/Infrastructure/SchemaMigration/OnlineSchemaMigrationCompatibility.cs'
        )
        const outside = path.join(directory, 'linked-schema-source.cs')
        writeFileSync(outside, readFileSync(source))
        rmSync(source)
        symlinkSync(path.relative(path.dirname(source), outside), source)
      }
      else
      {
        const { binding } = loadRuntimeBuildBinding(directory)
        const observations = path.dirname(path.join(directory, binding.path))
        const physical = `${observations}-physical`
        renameSync(observations, physical)
        symlinkSync(path.basename(physical), observations)
      }
      const result = extractTestMatrix({
        repositoryRoot: directory,
        extractor: registryExtractor(),
        sourceCommit: sourceIdentity.sourceCommit,
        worktreeFingerprint: sourceIdentity.worktreeFingerprint,
        buildIdentity: build.buildIdentity,
        buildReceiptPath: build.buildReceiptPath
      })
      assert.equal(result.status, 'failed', kind)
      assert.match(result.failureReasons.join('\n'), /symbolic link/iu, kind)
    }
    finally
    {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('runtime-role deployment source roster, live digests, and policy authority fail closed', () =>
{
  for (const [label, mutate] of [
    [
      'missing roster member',
      (observation) => { delete observation.deploymentAuthority.sourceDigests.dockerfile }
    ],
    [
      'stale source digest',
      (observation) => { observation.deploymentAuthority.sourceDigests.dockerfile.digest = '0'.repeat(64) }
    ],
    [
      'tampered authority binding',
      (observation) => { observation.deploymentAuthority.authorityContentDigest = `sha256:${'0'.repeat(64)}` }
    ]
  ])
  {
    const directory = fixtureRepository()
    try
    {
      const result = extractMutatedRuntimeObservation(directory, mutate)
      assert.equal(result.status, 'failed', label)
      assert.match(result.failureReasons.join('\n'), /compiled producer replay mismatch/iu, label)
            const replayOwner = path.join(directory, '.tmp/contracts/runtime-role');
            assert.ok(!readdirSync(replayOwner).some((name) => name.startsWith('replay-')), label);
    }
    finally
    {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('schema overlap failure-code sets reject both missing and extra members', () =>
{
  for (const [label, mutate] of [
    ['missing', (observation) => { observation.schemaOverlap.concurrentContractFailureCodes.pop() }],
    ['extra', (observation) => { observation.schemaOverlap.missingExpandFailureCodes.push('schema_unexpected') }]
  ])
  {
    const directory = fixtureRepository()
    try
    {
      const result = extractMutatedRuntimeObservation(directory, mutate)
      assert.equal(result.status, 'failed', label)
      assert.match(result.failureReasons.join('\n'), /partial, conflicting, or unsupported/iu, label)
    }
    finally
    {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('compiled runtime-role host rejects resealed nested deployment contradictions', () =>
{
  for (const [label, mutate, pattern] of [
    [
      'source roster',
      (deployment) => { delete deployment.sourceDigests.dockerfile },
      /runtime_role_deployment_source_roster_invalid/iu
    ],
    [
      'ownership',
      (deployment) => { deployment.ownership.coResidency = 'runtime-roles-are-separate' },
      /runtime_role_deployment_ownership_policy_mismatch/iu
    ],
    [
      'application',
      (deployment) => { deployment.application.effectivePid1 = ['/bin/sh'] },
      /runtime_role_deployment_pid1_mismatch/iu
    ],
    [
      'effective compose oracle',
      (deployment) => { deployment.effectiveCompose.modelDigest = `sha256:${'0'.repeat(64)}` },
      /runtime_role_deployment_effective_compose_mismatch/iu
    ],
    [
      'volume topology',
      (deployment) => { deployment.volumeTopology['/app/data'].scope = 'shared-between-slots' },
      /runtime_role_deployment_volume_topology_mismatch/iu
    ]
  ])
  {
    const directory = fixtureRepository()
    try
    {
      const { binding } = loadRuntimeBuildBinding(directory)
      const deploymentPath = path.join(directory, binding.deploymentArtifactPath)
      const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'))
      mutate(deployment)
      const { observationDigest: _observationDigest, ...unsigned } = deployment
      deployment.observationDigest = `sha256:${createHash('sha256').update(canonical(unsigned)).digest('hex')}`
      writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`)
      const output = path.join(directory, '.tmp/contracts/runtime-role/rejected.json')
      const run = spawnSync('dotnet', [
        path.join(directory, binding.assemblyPath),
        '--deployment-observation', deploymentPath,
        '--output', output
      ], { cwd: directory, encoding: 'utf8' })
      assert.notEqual(run.status, 0, label)
      assert.match(`${run.stdout}\n${run.stderr}`, pattern, label)
      assert.equal(existsSync(output), false, label)
    }
    finally
    {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('compiled runtime-role host rejects a PATH-prepended fake Docker oracle', () =>
{
  const directory = fixtureRepository()
  try
  {
    const { binding } = loadRuntimeBuildBinding(directory)
    const fakeBin = path.join(directory, 'fake-bin')
    mkdirSync(fakeBin)
    const fakeDocker = path.join(fakeBin, 'docker')
    writeFileSync(fakeDocker, '#!/usr/bin/env bash\nexec /usr/bin/docker "$@"\n')
    chmodSync(fakeDocker, 0o755)
    const output = path.join(directory, '.tmp/contracts/runtime-role/fake-docker-rejected.json')
    const run = spawnSync('dotnet', [
      path.join(directory, binding.assemblyPath),
      '--deployment-observation',
      path.join(directory, binding.deploymentArtifactPath),
      '--output', output
    ], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` }
    })
    assert.notEqual(run.status, 0)
    assert.match(`${run.stdout}\n${run.stderr}`, /runtime_role_external_oracle_untrusted:docker/iu)
    assert.equal(existsSync(output), false)
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
  const first = await runExtractor({
    extractorId,
    repositoryRoot: root,
    useCache: false,
    buildIdentity: runtimeRoleBuild.buildIdentity,
    buildReceiptPath: runtimeRoleBuild.buildReceiptPath
  })
  const second = await runExtractor({
    extractorId,
    repositoryRoot: root,
    useCache: false,
    buildIdentity: runtimeRoleBuild.buildIdentity,
    buildReceiptPath: runtimeRoleBuild.buildReceiptPath
  })
  assert.equal(first.receipt.status, 'ok')
  assert.equal(semanticDigestFromReceipt(first.receipt), semanticDigestFromReceipt(second.receipt))
})

// Keep unused helper referenced so the compact matrix builder stays available for future fixtures.
void minimalMatrix
