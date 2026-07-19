#!/usr/bin/env node

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const requiredClusterFixtures = [
  'shared-postgres',
  'shared-redis',
  'shared-artifact-storage'
]

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function hashFile(file) {
  return sha256(fs.readFileSync(file))
}

function parseEnvFile(file) {
  const values = {}
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error(`invalid environment entry in ${file}: ${rawLine}`)
    values[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return values
}

function parseFixtureNames(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function validateHomogeneousTopology(environment) {
  const errors = []
  const runtimeMode = environment.FSUSBLOG_TEST_RUNTIME_MODE
  const nodeCount = Number(environment.FSUSBLOG_TEST_NODE_COUNT)
  const fixtureNames = new Set(parseFixtureNames(environment.FSUSBLOG_TEST_CLUSTER_FIXTURES))

  if (!['static-role', 'adaptive'].includes(runtimeMode)) {
    errors.push('FSUSBLOG_TEST_RUNTIME_MODE must be static-role or adaptive')
  }
  if (nodeCount !== 2) errors.push('FSUSBLOG_TEST_NODE_COUNT must be exactly 2')
  if (environment.FSUSBLOG_TEST_CLUSTER_BOOTSTRAP !== 'homogeneous') {
    errors.push('FSUSBLOG_TEST_CLUSTER_BOOTSTRAP must be homogeneous')
  }
  if (environment.FSUSBLOG_TEST_ARTIFACT_STORAGE !== 'shared-volume') {
    errors.push('FSUSBLOG_TEST_ARTIFACT_STORAGE must be shared-volume')
  }
  if (environment.FSUSBLOG_TEST_COORDINATION_STORE !== 'redis') {
    errors.push('FSUSBLOG_TEST_COORDINATION_STORE must be redis')
  }
  for (const fixture of requiredClusterFixtures) {
    if (!fixtureNames.has(fixture)) errors.push(`FSUSBLOG_TEST_CLUSTER_FIXTURES must include ${fixture}`)
  }
  if (!environment.ConnectionStrings__DefaultConnection) {
    errors.push('ConnectionStrings__DefaultConnection is required')
  }
  if (!(environment.ConnectionStrings__Redis || environment.RedisOptions__Configuration)) {
    errors.push('ConnectionStrings__Redis or RedisOptions__Configuration is required')
  }
  return errors
}

async function reservePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to reserve a local TCP port')
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exit = new Promise((resolve) => child.once('exit', () => resolve(true)))
  child.kill('SIGTERM')
  const exited = await Promise.race([
    exit,
    new Promise((resolve) => setTimeout(() => resolve(false), 3_000))
  ])
  if (!exited && child.exitCode === null && child.signalCode === null) {
    const killed = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGKILL')
    await killed
  }
}

async function readHealth(node, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'not attempted'
  while (Date.now() < deadline) {
    if (node.spawnError) throw new Error(`${node.nodeId} failed to start: ${node.spawnError.message}`)
    if (node.child.exitCode !== null || node.child.signalCode !== null) {
      throw new Error(`${node.nodeId} exited before health became live; log=${node.logPath}`)
    }
    try {
      const response = await fetch(`${node.baseUrl}/health/live`, {
        signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - Date.now())))
      })
      const body = await response.json()
      if (response.ok && body?.status === 'live') return body
      lastError = `status=${response.status} body=${JSON.stringify(body)}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${node.nodeId} health timeout: ${lastError}; log=${node.logPath}`)
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

export async function startHomogeneousTwoNodeFixture(options) {
  const environment = { ...options.environment }
  const topologyErrors = validateHomogeneousTopology(environment)
  if (topologyErrors.length > 0) throw new Error(topologyErrors.join('\n'))

  const artifact = path.resolve(options.artifact)
  const artifactRoot = path.resolve(options.artifactRoot ?? path.dirname(artifact))
  const frontendAssetSource = path.resolve(options.frontendAssetSource)
  const outputRoot = path.resolve(options.outputRoot)
  const summaryPath = path.resolve(options.summaryPath ?? path.join(outputRoot, 'cluster-summary.json'))
  if (!fs.statSync(artifact).isFile()) throw new Error(`backend artifact is not a file: ${artifact}`)
  if (!fs.statSync(artifactRoot).isDirectory()) throw new Error(`artifact root is not a directory: ${artifactRoot}`)
  const relativeArtifact = path.relative(artifactRoot, artifact)
  if (relativeArtifact.startsWith('..') || path.isAbsolute(relativeArtifact)) {
    throw new Error(`backend artifact must belong to artifact root: artifact=${artifact} root=${artifactRoot}`)
  }
  if (!fs.statSync(frontendAssetSource).isFile()) {
    throw new Error(`frontend asset identity source is not a file: ${frontendAssetSource}`)
  }
  fs.mkdirSync(outputRoot, { recursive: true })

  let ports = options.ports
  if (!ports) {
    const first = await reservePort()
    let second = await reservePort()
    while (second === first) second = await reservePort()
    ports = [first, second]
  }
  if (ports.length !== 2 || ports[0] === ports[1]) throw new Error('two distinct node ports are required')
  const artifactDigest = hashFile(artifact)
  const frontendAssetVersion = hashFile(frontendAssetSource)
  const redisConnection = environment.ConnectionStrings__Redis ?? environment.RedisOptions__Configuration
  const sharedInfraIdentity = sha256(JSON.stringify({
    postgres: environment.ConnectionStrings__DefaultConnection,
    redis: redisConnection
  }))
  const command = options.command ?? 'dotnet'
  const commandArgs = options.commandArgs ?? [artifact]
  const nodes = []

  try {
    for (const [index, nodeName] of ['a', 'b'].entries()) {
      const nodeId = `${options.nodeIdPrefix ?? 'fsusblog-test-node'}-${nodeName}`
      const baseUrl = `http://127.0.0.1:${ports[index]}`
      const logPath = path.join(outputRoot, `node-${nodeName}.log`)
      const dataRoot = path.join(outputRoot, `node-${nodeName}-data`)
      fs.mkdirSync(dataRoot, { recursive: true })
      const log = fs.openSync(logPath, 'a', 0o600)
      const child = spawn(command, commandArgs, {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...environment,
          ASPNETCORE_URLS: baseUrl,
          ASPNETCORE_CONTENTROOT: artifactRoot,
          FSUSBLOG_DATA_ROOT: dataRoot,
          FSUSBLOG_SHARED_ARTIFACT_ROOT: artifactRoot,
          FSUSBLOG_TEST_NODE_ID: nodeId,
          FSUSBLOG_TEST_NODE_BASE_URL: baseUrl
        },
        stdio: ['ignore', log, log]
      })
      const node = { nodeId, baseUrl, logPath, dataRoot, child, spawnError: null }
      child.once('error', (error) => {
        node.spawnError = error
      })
      fs.closeSync(log)
      nodes.push(node)
    }

    const health = await Promise.all(nodes.map((node) => readHealth(node, options.startupTimeoutMs ?? 30_000)))
    const summary = {
      schema: 'fsusblog.homogeneous-two-node-fixture.v1',
      generatedAt: new Date().toISOString(),
      runtimeMode: environment.FSUSBLOG_TEST_RUNTIME_MODE,
      clusterScenario: environment.FSUSBLOG_TEST_CLUSTER_SCENARIO,
      build: {
        artifact,
        artifactRoot,
        sha256: artifactDigest,
        appVersion: artifactDigest
      },
      frontendAssetVersion,
      sharedInfraIdentity,
      nodes: nodes.map((node, index) => ({
        nodeId: node.nodeId,
        baseUrl: node.baseUrl,
        logPath: node.logPath,
        health: health[index],
        appVersion: artifactDigest,
        frontendAssetVersion,
        runtimeMode: environment.FSUSBLOG_TEST_RUNTIME_MODE
      })),
      invariants: {
        sameArtifact: true,
        sameAppVersion: true,
        sameFrontendAssetVersion: true,
        sameRuntimeMode: true,
        independentLogs: nodes[0].logPath !== nodes[1].logPath,
        sharedPostgres: true,
        sharedRedis: true
      }
    }
    writeJsonAtomic(summaryPath, summary)
    return {
      nodes,
      summary,
      summaryPath,
      stop: async () => Promise.all(nodes.map((node) => stopChild(node.child)))
    }
  } catch (error) {
    await Promise.all(nodes.map((node) => stopChild(node.child)))
    throw error
  }
}

function parseArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument: ${key ?? '<missing>'}`)
    result[key.slice(2)] = value
  }
  return result
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const environment = { ...process.env, ...parseEnvFile(path.resolve(args['env-file'])) }
  const fixture = await startHomogeneousTwoNodeFixture({
    environment,
    artifact: args.artifact,
    artifactRoot: args['artifact-root'],
    frontendAssetSource: args['frontend-asset-source'],
    outputRoot: args['output-root'],
    summaryPath: args.summary,
    cwd: args.cwd ?? process.cwd(),
    startupTimeoutMs: Number(args['startup-timeout-ms'] ?? 60_000)
  })
  try {
    process.stdout.write(`${JSON.stringify(fixture.summary)}\n`)
  } finally {
    await fixture.stop()
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
}
