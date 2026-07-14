#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { fingerprintPaths, runBoundExecution } from './run-once.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function parse(argv) {
  const options = { paths: [], environmentNames: [], outputs: [], testIds: [] }
  const separator = argv.indexOf('--')
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error('run-deterministic-command requires a command after --')
  }
  for (let index = 0; index < separator; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value == null) throw new Error(`invalid option: ${name ?? ''}`)
    if (name === '--path') options.paths.push(value)
    else if (name === '--env') options.environmentNames.push(value)
    else if (name === '--output') options.outputs.push(value)
    else if (name === '--test-id') options.testIds.push(value)
    else options[name.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value
  }
  return { options, command: argv.slice(separator + 1) }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

async function spawnCommand(command, cwd, signal) {
  await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: process.env,
      stdio: 'inherit',
      signal
    })
    child.on('error', reject)
    child.on('exit', (code, childSignal) => {
      if (code === 0) {
        resolve()
        return
      }
      const error = new Error(`command failed (${childSignal ? `signal ${childSignal}` : `exit ${code}`}): ${command.join(' ')}`)
      error.exitCode = code
      error.signal = childSignal
      reject(error)
    })
  })
}

async function main(argv) {
  const { options, command } = parse(argv)
  if (!String(options.key ?? '').trim()) throw new Error('--key is required')
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const runId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim()
  if (!runId) {
    await spawnCommand(command, cwd)
    console.log(`[physical-execution] direct key=${options.key} (no scheduler run ID; dedup disabled)`)
    return
  }

  const commit = git(['rev-parse', 'HEAD'])
  const inputDigest = await fingerprintPaths(options.paths, {
    root: repoRoot,
    values: [
      'run-bound-physical-execution-v3',
      cwd,
      JSON.stringify(command),
      JSON.stringify([...options.outputs].sort())
    ]
  })
  const environment = Object.fromEntries([...new Set(options.environmentNames)].sort().map((name) => [name, process.env[name] ?? '']))
  const environmentDigest = digest({
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    environment
  })
  const worktreeFingerprint = digest({
    commit,
    inputDigest,
    status: git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...options.paths])
  })
  const consumerId = String(options.consumer
    ?? process.env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID
    ?? process.env.FSUSBLOG_CURRENT_TIER
    ?? `${options.key}-consumer`)
  const controller = new AbortController()
  const abort = (signal) => controller.abort(Object.assign(new Error(`received ${signal}`), { name: 'AbortError', signal }))
  const onSigint = () => abort('SIGINT')
  const onSigterm = () => abort('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  try {
    const result = await runBoundExecution({
      runId,
      key: options.key,
      command,
      cwd,
      inputDigest,
      environmentDigest,
      outputContract: options.outputs,
      requiredOutputs: options.outputs,
      commit,
      worktreeFingerprint,
      testIds: options.testIds,
      consumerId
    }, async () => spawnCommand(command, cwd, controller.signal))
    console.log(`[physical-execution] ${result.status} key=${options.key} receipt=${result.receiptFile} projection=${result.projectionFile}`)
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`[physical-execution] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = Number.isInteger(error?.exitCode) && error.exitCode > 0 ? error.exitCode : 1
})
