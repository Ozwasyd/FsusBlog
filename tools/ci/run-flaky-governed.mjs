#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const retryPolicy = new Map([
  ['acceptance-playwright', { allowedRetries: 1, classification: 'unknown-flaky' }],
  ['visual-playwright', { allowedRetries: 1, classification: 'unknown-flaky' }],
  ['ux-viewport-smoke', { allowedRetries: 1, classification: 'unknown-flaky' }],
  ['cross-browser-smoke', { allowedRetries: 1, classification: 'unknown-flaky' }]
])

function usage() {
  console.error('Usage: node tools/ci/run-flaky-governed.mjs --suite <suite> [--test <name>] -- <command> [args...]')
}

function parseArgs(args) {
  const options = { suite: null, test: null }
  let index = 0
  for (; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      index += 1
      break
    }
    if (arg === '--suite') options.suite = args[++index]
    else if (arg.startsWith('--suite=')) options.suite = arg.slice('--suite='.length)
    else if (arg === '--test') options.test = args[++index]
    else if (arg.startsWith('--test=')) options.test = arg.slice('--test='.length)
    else throw new Error(`unknown option: ${arg}`)
  }
  const command = args.slice(index)
  if (!options.suite) throw new Error('missing --suite')
  if (command.length === 0) throw new Error('missing command after --')
  return { ...options, command }
}

function evidenceFile(suite) {
  const safeSuite = String(suite).replace(/[^A-Za-z0-9_.-]/g, '-')
  return path.join(root, '.tmp/release-evidence/flaky', `${safeSuite}.json`)
}

function writeEvidence({ suite, test, classification, retryCount, finalStatus, command, attempts }) {
  const file = evidenceFile(suite)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({
    schema: 'fsusblog.ci.flaky.v1',
    suite,
    test,
    classification,
    issue: 134,
    retryCount,
    finalStatus,
    command: command.join(' '),
    attempts,
    localReproduction: `node tools/ci/run-flaky-governed.mjs --suite ${suite} -- ${command.join(' ')}`,
    generatedAt: new Date().toISOString()
  }, null, 2)}\n`)
}

function runCommand(command) {
  const startedAt = Date.now()
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    env: process.env,
    stdio: 'inherit'
  })
  return {
    status: result.status ?? 1,
    durationMs: Math.max(0, Date.now() - startedAt)
  }
}

function main() {
  const { suite, test, command } = parseArgs(process.argv.slice(2))
  const policy = retryPolicy.get(suite) ?? { allowedRetries: 0, classification: 'regression' }
  const attempts = []

  for (let attempt = 0; attempt <= policy.allowedRetries; attempt += 1) {
    console.error(`[flaky:${suite}] attempt ${attempt + 1}/${policy.allowedRetries + 1}: ${command.join(' ')}`)
    const result = runCommand(command)
    attempts.push({ attempt: attempt + 1, status: result.status === 0 ? 'success' : 'failure', durationMs: result.durationMs })
    if (result.status === 0) {
      if (attempt > 0) {
        writeEvidence({
          suite,
          test,
          classification: policy.classification,
          retryCount: attempt,
          finalStatus: 'passed-after-retry',
          command,
          attempts
        })
      }
      return
    }
  }

  writeEvidence({
    suite,
    test,
    classification: policy.allowedRetries > 0 ? policy.classification : 'regression',
    retryCount: policy.allowedRetries,
    finalStatus: policy.allowedRetries > 0 ? 'failed-after-retry' : 'failed-no-retry',
    command,
    attempts
  })
  process.exit(attempts.at(-1)?.status === 'success' ? 0 : 1)
}

try {
  main()
} catch (error) {
  usage()
  console.error(`[flaky] ${error.message}`)
  process.exit(2)
}
