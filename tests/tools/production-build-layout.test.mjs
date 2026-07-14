import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assertSafeProductionBuildRunRoot,
  bindProductionBuildLayoutSource,
  collectStaleProductionBuildRoots,
  dotnetProjectLayout,
  finalizeProductionBuildLayout,
  prepareProductionBuildLayout,
  productionBuildEnvironment,
  productionBuildLayoutDigest,
  productionDotnetArtifacts,
  resolveProductionBuildLayout,
  scheduleStaleProductionBuildGc
} from '../../tools/test-matrix/production-build-layout.mjs'
import {
  digestDeclaredOutputs,
  resolveRunBoundArtifactDeclaration
} from '../../tools/test-matrix/local-profile.mjs'
import { snapshotTierOutputs } from '../../tools/test-matrix/scheduler.mjs'

function repositoryFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-build-layout-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('MSBuild policy excludes legacy project-tree bin/obj after relocating the SDK intermediate root', () => {
  const props = fs.readFileSync(path.join(repositoryRoot, 'Directory.Build.props'), 'utf8')
  assert.match(props, /BaseOutputPath[\s\S]*?BaseIntermediateOutputPath[\s\S]*?MSBuildProjectExtensionsPath/u)
  assert.match(props, /DefaultItemExcludes>\$\(DefaultItemExcludes\);bin\/\*\*;obj\/\*\*/u)
})

test('run-bound layout isolates every MSBuild project and exposes canonical artifacts', t => {
  const root = repositoryFixture(t)
  const layout = prepareProductionBuildLayout({ root, runId: 'production-current' })
  const projects = [
    dotnetProjectLayout(layout, 'src/backend/FsusBlog.Server.csproj'),
    dotnetProjectLayout(layout, 'tests/backend/FsusBlog.Server.Tests.csproj'),
    dotnetProjectLayout(layout, 'benchmarks/core/FsusBlog.Core.Benchmarks.csproj')
  ]
  assert.equal(new Set(projects.map(project => project.projectExtensionsPath)).size, projects.length)
  assert.equal(new Set(projects.map(project => project.baseIntermediateOutputPath)).size, projects.length)
  assert.ok(projects.every(project => project.projectExtensionsPath.startsWith(`${layout.dotnetRoot}${path.sep}`)))

  const artifacts = productionDotnetArtifacts(layout)
  const env = productionBuildEnvironment(layout, { SENTINEL: 'kept' })
  assert.equal(env.SENTINEL, 'kept')
  assert.equal(env.FSUSBLOG_BACKEND_SERVER_DLL, artifacts.serverDll)
  assert.equal(env.FSUSBLOG_BACKEND_TEST_DLL, artifacts.testDll)
  assert.equal(env.FSUSBLOG_BENCHMARK_DLL, artifacts.benchmarkDll)
  assert.equal(env.ASPNETCORE_WEBROOT, layout.backendWebRoot)
  assert.equal(env.FSUSBLOG_WASM_ARTIFACT_ROOT, layout.wasmArtifacts)
})

test('layout identity binds run, source fingerprint and digest before readiness consumption', t => {
  const root = repositoryFixture(t)
  const layout = prepareProductionBuildLayout({ root, runId: 'release-final-42' })
  const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
  const manifest = bindProductionBuildLayoutSource(layout, sourceState)
  assert.deepEqual(manifest.sourceState, sourceState)
  const identityDigest = productionBuildLayoutDigest(layout)
  assert.match(identityDigest, /^sha256:[a-f0-9]{64}$/u)

  fs.mkdirSync(layout.frontendDist, { recursive: true })
  fs.writeFileSync(path.join(layout.frontendDist, 'index.html'), '<!doctype html>')
  const canonical = 'src/frontend/dist/index.html'
  const actual = path.relative(root, path.join(layout.frontendDist, 'index.html')).replaceAll(path.sep, '/')
  const env = productionBuildEnvironment(layout, {})
  assert.equal(resolveRunBoundArtifactDeclaration(root, canonical, env), actual)
  assert.match(digestDeclaredOutputs(root, [canonical], env)[canonical], /^sha256:/u)
  finalizeProductionBuildLayout(layout, { status: 'success' })
  assert.equal(productionBuildLayoutDigest(layout), identityDigest)
})

test('fresh run never reads an older run root and finalization removes the active marker', t => {
  const root = repositoryFixture(t)
  const oldLayout = prepareProductionBuildLayout({ root, runId: 'old-run' })
  fs.mkdirSync(oldLayout.frontendDist, { recursive: true })
  fs.writeFileSync(path.join(oldLayout.frontendDist, 'index.html'), 'stale')
  const current = prepareProductionBuildLayout({ root, runId: 'current-run' })
  assert.equal(fs.existsSync(path.join(current.frontendDist, 'index.html')), false)
  assert.notEqual(current.frontendDist, oldLayout.frontendDist)
  const finalized = finalizeProductionBuildLayout(current, {
    status: 'cancelled',
    cleanup: { durationMs: 1, traversedEntryCount: 2 },
    wallClockMs: 3
  })
  assert.equal(finalized.status, 'cancelled')
  assert.equal(fs.existsSync(current.activeFile), false)
  assert.ok(finalized.metrics.output.inodeCount > 0)
  assert.ok(finalized.metrics.output.byteCount > 0)
})

test('scheduler output validation resolves logical declarations only to the current run root', t => {
  const root = repositoryFixture(t)
  const oldLayout = prepareProductionBuildLayout({ root, runId: 'old-output' })
  fs.mkdirSync(oldLayout.frontendDist, { recursive: true })
  fs.writeFileSync(path.join(oldLayout.frontendDist, 'index.html'), 'old')
  const current = prepareProductionBuildLayout({ root, runId: 'current-output' })
  const tier = { artifacts: ['src/frontend/dist/index.html'], evidence: [] }
  const env = productionBuildEnvironment(current, {})
  assert.equal(snapshotTierOutputs(root, tier, env).reusable, false)
  fs.mkdirSync(current.frontendDist, { recursive: true })
  fs.writeFileSync(path.join(current.frontendDist, 'index.html'), 'current')
  const snapshot = snapshotTierOutputs(root, tier, env)
  assert.equal(snapshot.reusable, true)
  assert.notEqual(snapshot.entries['src/frontend/dist/index.html'], 'missing')
})

test('stale GC retains current and live runs while reclaiming interrupted inactive runs', t => {
  const root = repositoryFixture(t)
  for (const runId of ['current', 'active', 'stale']) {
    const layout = resolveProductionBuildLayout({ root, runId })
    fs.mkdirSync(layout.runRoot, { recursive: true })
    fs.writeFileSync(path.join(layout.runRoot, 'artifact'), runId)
  }
  const report = collectStaleProductionBuildRoots({
    root,
    currentRunId: 'current',
    isRunActive: runId => runId === 'active'
  })
  assert.deepEqual(report.removed, ['stale'])
  assert.deepEqual(report.retained, ['active', 'current'])
  assert.equal(report.reclaimed.inodeCount, 1)
  assert.equal(report.reclaimed.byteCount, Buffer.byteLength('stale'))
  assert.ok(report.durationMs >= 0)
  assert.equal(fs.existsSync(resolveProductionBuildLayout({ root, runId: 'stale' }).runRoot), false)
})

test('GC refuses traversal, repository/root targets and symlinks without deleting outside data', t => {
  const root = repositoryFixture(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-build-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'keep'), 'keep')
  fs.mkdirSync(path.join(root, '.tmp/build'), { recursive: true })
  fs.symlinkSync(outside, path.join(root, '.tmp/build/linked'), 'dir')

  for (const candidate of [root, path.parse(root).root, path.join(root, '.tmp/build'), path.join(root, '.tmp/build/../outside')]) {
    assert.throws(() => assertSafeProductionBuildRunRoot(candidate, { root }), /refusing unsafe/u)
  }
  assert.throws(
    () => collectStaleProductionBuildRoots({ root, currentRunId: 'current' }),
    /refusing symlink/u
  )
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep')
})

test('GC scheduling is detached and never blocks the current critical path', t => {
  const root = repositoryFixture(t)
  let captured = null
  let unrefCalled = false
  const result = scheduleStaleProductionBuildGc({
    root,
    currentRunId: 'production-now',
    spawnProcess(command, args, options) {
      captured = { command, args, options }
      return { pid: 321, unref: () => { unrefCalled = true } }
    }
  })
  assert.equal(result.pid, 321)
  assert.equal(captured.options.detached, true)
  assert.equal(captured.options.stdio, 'ignore')
  assert.equal(unrefCalled, true)
})
