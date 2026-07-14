import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const productionBuildLayoutSchema = 'fsusblog.production-build-layout.v1'

export function validateProductionRunId(value) {
  const runId = String(value ?? '').trim()
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(runId) || runId === '.' || runId === '..') {
    throw new Error(`unsafe production build run id: ${runId || '<empty>'}`)
  }
  return runId
}

function projectName(projectFile) {
  const name = path.basename(String(projectFile), path.extname(String(projectFile)))
  if (!name || !/^[A-Za-z0-9_.-]+$/u.test(name)) throw new Error(`unsafe MSBuild project name: ${projectFile}`)
  return name
}

export function resolveProductionBuildLayout({
  root = defaultRoot,
  runId = process.env.FSUSBLOG_TEST_RUN_ID
} = {}) {
  const repositoryRoot = path.resolve(root)
  const normalizedRunId = validateProductionRunId(runId)
  const buildBase = path.join(repositoryRoot, '.tmp/build')
  const runRoot = path.join(buildBase, normalizedRunId)
  return {
    schema: productionBuildLayoutSchema,
    runId: normalizedRunId,
    repositoryRoot,
    buildBase,
    runRoot,
    activeFile: path.join(runRoot, '.active.json'),
    manifestFile: path.join(runRoot, 'layout.json'),
    dotnetRoot: path.join(runRoot, 'dotnet'),
    frontendDist: path.join(runRoot, 'frontend/dist'),
    frontendCache: path.join(runRoot, 'frontend/cache'),
    frontendWasm: path.join(runRoot, 'frontend/wasm'),
    backendWebRoot: path.join(runRoot, 'frontend/wwwroot'),
    wasmArtifacts: path.join(runRoot, 'wasm'),
    generatedRoot: path.join(runRoot, 'generated')
  }
}

export function dotnetProjectLayout(layout, projectFile, configuration = 'Release', targetFramework = 'net10.0') {
  const name = projectName(projectFile)
  const projectRoot = path.join(layout.dotnetRoot, name)
  return {
    name,
    projectFile: String(projectFile).replaceAll(path.sep, '/'),
    projectRoot,
    baseOutputPath: path.join(projectRoot, 'bin'),
    baseIntermediateOutputPath: path.join(projectRoot, 'obj'),
    projectExtensionsPath: path.join(projectRoot, 'obj'),
    outputDirectory: path.join(projectRoot, 'bin', configuration, targetFramework),
    intermediateDirectory: path.join(projectRoot, 'obj', configuration, targetFramework),
    assetsFile: path.join(projectRoot, 'obj/project.assets.json')
  }
}

export function productionDotnetArtifacts(layout) {
  const server = dotnetProjectLayout(layout, 'src/backend/FsusBlog.Server.csproj')
  const tests = dotnetProjectLayout(layout, 'tests/backend/FsusBlog.Server.Tests.csproj')
  const benchmark = dotnetProjectLayout(layout, 'benchmarks/core/FsusBlog.Core.Benchmarks.csproj')
  return {
    server,
    tests,
    benchmark,
    serverDll: path.join(server.outputDirectory, 'FsusBlog.Server.dll'),
    testDll: path.join(tests.outputDirectory, 'FsusBlog.Server.Tests.dll'),
    benchmarkDll: path.join(benchmark.outputDirectory, 'FsusBlog.Core.Benchmarks.dll')
  }
}

function relative(root, target) {
  return path.relative(root, target).replaceAll(path.sep, '/')
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

export function assertSafeProductionBuildRunRoot(candidate, { root = defaultRoot } = {}) {
  const repositoryRoot = path.resolve(root)
  const buildBase = path.resolve(repositoryRoot, '.tmp/build')
  const resolved = path.resolve(candidate)
  if (resolved === buildBase || resolved === repositoryRoot || resolved === path.parse(resolved).root
    || path.dirname(resolved) !== buildBase || !resolved.startsWith(`${buildBase}${path.sep}`)) {
    throw new Error(`refusing unsafe production build root: ${candidate}`)
  }
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`refusing symlink production build root: ${candidate}`)
  }
  validateProductionRunId(path.basename(resolved))
  return resolved
}

export function prepareProductionBuildLayout(options = {}) {
  const layout = resolveProductionBuildLayout(options)
  assertSafeProductionBuildRunRoot(layout.runRoot, { root: layout.repositoryRoot })
  const fresh = options.fresh !== false
  if (fresh && fs.existsSync(layout.runRoot)) {
    if (productionBuildRunIsActive(layout.repositoryRoot, layout.runId)) {
      throw new Error(`production build run is already active: ${layout.runId}`)
    }
    fs.rmSync(layout.runRoot, { recursive: true, force: true })
  }
  fs.mkdirSync(layout.runRoot, { recursive: true })
  for (const directory of [
    layout.frontendCache,
    layout.wasmArtifacts,
    layout.generatedRoot
  ]) fs.mkdirSync(directory, { recursive: true })
  const artifacts = productionDotnetArtifacts(layout)
  const projects = [artifacts.server, artifacts.tests, artifacts.benchmark]
  if (new Set(projects.map((entry) => entry.projectExtensionsPath)).size !== projects.length) {
    throw new Error('production MSBuild project extension paths are not isolated')
  }
  const manifest = {
    schema: productionBuildLayoutSchema,
    status: 'active',
    runId: layout.runId,
    sourceState: {
      commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null,
      worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
    },
    paths: {
      runRoot: relative(layout.repositoryRoot, layout.runRoot),
      frontendDist: relative(layout.repositoryRoot, layout.frontendDist),
      frontendWasm: relative(layout.repositoryRoot, layout.frontendWasm),
      backendWebRoot: relative(layout.repositoryRoot, layout.backendWebRoot),
      generatedRoot: relative(layout.repositoryRoot, layout.generatedRoot)
    },
    projects: Object.fromEntries(projects.map((entry) => [entry.name, {
      projectFile: entry.projectFile,
      baseOutputPath: relative(layout.repositoryRoot, entry.baseOutputPath),
      baseIntermediateOutputPath: relative(layout.repositoryRoot, entry.baseIntermediateOutputPath),
      projectExtensionsPath: relative(layout.repositoryRoot, entry.projectExtensionsPath)
    }])),
    createdAt: new Date().toISOString()
  }
  if (!fresh && fs.existsSync(layout.manifestFile)) {
    const existing = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'))
    if (existing.schema !== productionBuildLayoutSchema || existing.runId !== layout.runId) {
      throw new Error(`production build layout identity mismatch: ${layout.manifestFile}`)
    }
    atomicWriteJson(layout.manifestFile, {
      ...existing,
      status: 'active',
      resumedAt: new Date().toISOString()
    })
  } else {
    atomicWriteJson(layout.manifestFile, manifest)
  }
  atomicWriteJson(layout.activeFile, {
    schema: 'fsusblog.production-build-layout-active.v1',
    runId: layout.runId,
    pid: process.pid,
    startedAt: new Date().toISOString()
  })
  return { ...layout, manifest: JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8')), artifacts }
}

export function productionBuildEnvironment(layout, env = process.env) {
  const artifacts = productionDotnetArtifacts(layout)
  return {
    ...env,
    FSUSBLOG_PRODUCTION_BUILD_ROOT: layout.runRoot,
    FSUSBLOG_FRONTEND_DIST_ROOT: layout.frontendDist,
    FSUSBLOG_FRONTEND_CACHE_ROOT: layout.frontendCache,
    FSUSBLOG_FRONTEND_WASM_ROOT: layout.frontendWasm,
    FSUSBLOG_WASM_ARTIFACT_ROOT: layout.wasmArtifacts,
    FSUSBLOG_BACKEND_WEBROOT: layout.backendWebRoot,
    FSUSBLOG_WEB_ROOT: layout.backendWebRoot,
    FSUSBLOG_RETENTION_WEBROOT_DIR: layout.backendWebRoot,
    ASPNETCORE_WEBROOT: layout.backendWebRoot,
    FSUSBLOG_GENERATED_OUTPUT_ROOT: layout.generatedRoot,
    FSUSBLOG_ARTIFACT_DIGEST_TABLE: path.join(layout.generatedRoot, 'artifact-digest-table.json'),
    FSUSBLOG_COMMENT_PROVER_BUNDLE: path.join(layout.generatedRoot, 'comment_v2_prover_wasm.tar.gz'),
    FSUSBLOG_BACKEND_SERVER_DLL: artifacts.serverDll,
    FSUSBLOG_BACKEND_TEST_DLL: artifacts.testDll,
    FSUSBLOG_BACKEND_TEST_BIN_DIR: artifacts.tests.outputDirectory,
    FSUSBLOG_BACKEND_TEST_OBJ_DIR: artifacts.tests.baseIntermediateOutputPath,
    FSUSBLOG_BENCHMARK_DLL: artifacts.benchmarkDll
  }
}

export function bindProductionBuildLayoutSource(layout, sourceState) {
  assertSafeProductionBuildRunRoot(layout.runRoot, { root: layout.repositoryRoot })
  const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'))
  if (manifest.schema !== productionBuildLayoutSchema || manifest.runId !== layout.runId || manifest.status !== 'active') {
    throw new Error(`production build layout cannot bind source identity: ${layout.manifestFile}`)
  }
  const commit = String(sourceState?.commit ?? '').trim()
  const worktreeFingerprint = String(sourceState?.worktreeFingerprint ?? '').trim()
  if (!commit || !worktreeFingerprint) throw new Error('production build layout requires complete source identity')
  const bound = {
    ...manifest,
    sourceState: { commit, worktreeFingerprint }
  }
  atomicWriteJson(layout.manifestFile, bound)
  return bound
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export function productionBuildRunIsActive(root, runId) {
  const safeRunId = validateProductionRunId(runId)
  const lockPath = path.join(path.resolve(root), '.tmp/test-runs/.locks', `${safeRunId}.lock`)
  if (!fs.existsSync(lockPath)) return false
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'))
    return processIsAlive(Number(owner.pid))
  } catch {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs < 30_000
    } catch {
      return false
    }
  }
}

export function measureProductionBuildTree(directory) {
  if (!fs.existsSync(directory)) return { inodeCount: 0, byteCount: 0 }
  let inodeCount = 0
  let byteCount = 0
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name)
      inodeCount += 1
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) byteCount += fs.statSync(child).size
    }
  }
  visit(directory)
  return { inodeCount, byteCount }
}

export function collectStaleProductionBuildRoots({
  root = defaultRoot,
  currentRunId = null,
  isRunActive = (runId) => productionBuildRunIsActive(root, runId),
  remove = (directory) => fs.rmSync(directory, { recursive: true, force: true })
} = {}) {
  const startedAtMs = Date.now()
  const repositoryRoot = path.resolve(root)
  const buildBase = path.join(repositoryRoot, '.tmp/build')
  if (!fs.existsSync(buildBase)) return {
    removed: [],
    retained: [],
    reclaimed: { inodeCount: 0, byteCount: 0 },
    durationMs: Date.now() - startedAtMs
  }
  if (fs.lstatSync(buildBase).isSymbolicLink()) throw new Error('refusing symlink production build base')
  const normalizedCurrent = currentRunId ? validateProductionRunId(currentRunId) : null
  const removed = []
  const retained = []
  const reclaimed = { inodeCount: 0, byteCount: 0 }
  for (const entry of fs.readdirSync(buildBase, { withFileTypes: true })) {
    const candidate = path.join(buildBase, entry.name)
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      if (entry.isSymbolicLink()) throw new Error(`refusing symlink production build candidate: ${candidate}`)
      continue
    }
    assertSafeProductionBuildRunRoot(candidate, { root: repositoryRoot })
    if (entry.name === normalizedCurrent || isRunActive(entry.name)) {
      retained.push(entry.name)
      continue
    }
    const measured = measureProductionBuildTree(candidate)
    reclaimed.inodeCount += measured.inodeCount
    reclaimed.byteCount += measured.byteCount
    remove(candidate)
    removed.push(entry.name)
  }
  return {
    removed: removed.sort(),
    retained: retained.sort(),
    reclaimed,
    durationMs: Date.now() - startedAtMs
  }
}

export function finalizeProductionBuildLayout(layout, {
  status,
  cleanup = null,
  wallClockMs = null,
  completedAt = new Date().toISOString()
} = {}) {
  if (!['success', 'failure', 'cancelled'].includes(status)) {
    throw new Error(`production build layout final status is invalid: ${status}`)
  }
  assertSafeProductionBuildRunRoot(layout.runRoot, { root: layout.repositoryRoot })
  const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'))
  if (manifest.schema !== productionBuildLayoutSchema || manifest.runId !== layout.runId) {
    throw new Error(`production build layout identity mismatch: ${layout.manifestFile}`)
  }
  const output = measureProductionBuildTree(layout.runRoot)
  const finalized = {
    ...manifest,
    status,
    completedAt,
    metrics: {
      cleanup,
      output,
      wallClockMs: Number.isFinite(Number(wallClockMs)) ? Number(wallClockMs) : null
    }
  }
  atomicWriteJson(layout.manifestFile, finalized)
  fs.rmSync(layout.activeFile, { force: true })
  return finalized
}

export function scheduleStaleProductionBuildGc({
  root = defaultRoot,
  currentRunId,
  spawnProcess = spawn
} = {}) {
  const repositoryRoot = path.resolve(root)
  const safeRunId = validateProductionRunId(currentRunId)
  const script = fileURLToPath(new URL('./production-build-gc.mjs', import.meta.url))
  const child = spawnProcess(process.execPath, [script, '--root', repositoryRoot, '--current-run', safeRunId], {
    cwd: repositoryRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FSUSBLOG_PRODUCTION_BUILD_GC: '1' }
  })
  child.unref?.()
  return { pid: child.pid ?? null, currentRunId: safeRunId, script }
}

export function productionBuildLayoutDigest(layout) {
  const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'))
  const identity = {
    schema: manifest.schema,
    runId: manifest.runId,
    sourceState: manifest.sourceState,
    paths: manifest.paths,
    projects: manifest.projects
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
}
