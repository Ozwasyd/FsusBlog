#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { loadNativeGovernance, validateNativeReceipt } from './native-test-governance.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function parseArgs(argv) {
  const options = {
    profile: null,
    runs: parsePositiveInteger(process.env.FSUSBLOG_NATIVE_FUZZ_RUNS ?? '1000', 'FSUSBLOG_NATIVE_FUZZ_RUNS'),
    jobs: parsePositiveInteger(process.env.FSUSBLOG_NATIVE_JOBS ?? '1', 'FSUSBLOG_NATIVE_JOBS'),
    out: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--profile') options.profile = argv[++index]
    else if (argument === '--runs') options.runs = parsePositiveInteger(argv[++index], '--runs')
    else if (argument === '--jobs') options.jobs = parsePositiveInteger(argv[++index], '--jobs')
    else if (argument === '--out') options.out = path.resolve(root, argv[++index])
    else throw new Error(`unknown argument: ${argument}`)
  }
  if (!options.profile) throw new Error('--profile is required')
  return options
}

function commandPath(command) {
  const result = spawnSync('which', [command], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function commandVersion(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout || result.stderr).trim() : null
}

function sourceCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : '0'.repeat(40)
}

function fileSetDigest(paths) {
  const rows = paths.map((relative) => {
    const absolute = path.join(root, relative)
    return `${relative}\0${sha256(fs.readFileSync(absolute))}`
  })
  return sha256(rows.sort().join('\n'))
}

function walk(relativeDirectory) {
  const absolute = path.join(root, relativeDirectory)
  if (!fs.existsSync(absolute)) return []
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(relativeDirectory, entry.name)
    return entry.isDirectory() ? walk(relative) : [relative]
  }).sort()
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.capture === true ? 'pipe' : 'inherit',
    env: options.env ?? process.env
  })
  return result.status ?? 1
}

function writeReceipt(out, receipt) {
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const { catalog } = loadNativeGovernance(root)
  const profile = catalog.profiles.find((entry) => entry.id === options.profile)
  const target = catalog.targets.find((entry) => entry.profile === options.profile)
  if (!profile || !target) throw new Error(`unknown native profile: ${options.profile}`)
  const corpus = target.corpusId ? catalog.corpora.find((entry) => entry.id === target.corpusId) : null
  const corpusFiles = corpus ? walk(corpus.path) : []
  const sourceInputs = [target.source, ...catalog.supportAssets.map((entry) => entry.path), ...corpusFiles]
  const compilerName = options.profile === 'fuzz-sanitizer'
    ? (process.env.FSUSBLOG_NATIVE_FUZZ_CXX ?? 'clang++')
    : (process.env.CXX ?? 'c++')
  const compilerPath = commandPath(compilerName)
  const cmakePath = commandPath('cmake')
  const ctestPath = commandPath('ctest')
  const missing = [
    !compilerPath ? `compiler:${compilerName}` : null,
    !cmakePath ? 'tool:cmake' : null,
    options.profile === 'smoke' && !ctestPath ? 'tool:ctest' : null
  ].filter(Boolean)
  const crashDirectory = `.tmp/native-tests/${options.profile}/crashes`
  const runtimeCorpusDirectory = `.tmp/native-tests/${options.profile}/corpus`
  const buildDirectory = path.join(root, '.tmp/native-tests', options.profile, 'build')
  const receiptPath = options.out ?? path.join(root, profile.receipt)
  const receipt = {
    schema: 'fsusblog.native-test-receipt.v1',
    profile: profile.id,
    testId: target.testId,
    target: target.cmakeTarget,
    source: {
      commit: sourceCommit(),
      inputDigest: fileSetDigest(sourceInputs)
    },
    toolchain: {
      compilerPath: compilerPath ?? compilerName,
      compilerVersion: compilerPath ? commandVersion(compilerPath) : 'unavailable',
      cmakeVersion: cmakePath ? commandVersion(cmakePath) : 'unavailable'
    },
    flags: {
      sanitizers: profile.sanitizers,
      fuzzer: options.profile === 'fuzz-sanitizer' ? [`-runs=${options.runs}`, `-jobs=${options.jobs}`] : []
    },
    corpus: {
      id: corpus?.id ?? 'empty-smoke-corpus',
      files: corpusFiles,
      identity: fileSetDigest(corpusFiles)
    },
    crashArtifacts: {
      path: crashDirectory,
      count: 0,
      digest: sha256('')
    },
    resources: {
      runs: options.profile === 'fuzz-sanitizer' ? options.runs : null,
      jobs: options.jobs,
      fixedTimeGate: false
    },
    preflight: {
      status: missing.length === 0 ? 'ready' : 'blocked',
      missing,
      missingReason: missing.length === 0 ? null : `native capability unavailable: ${missing.join(', ')}`
    },
    outcome: missing.length === 0 ? 'failed' : 'blocked'
  }

  if (missing.length > 0) {
    writeReceipt(receiptPath, receipt)
    console.error(receipt.preflight.missingReason)
    process.exitCode = 2
    return
  }

  fs.rmSync(buildDirectory, { recursive: true, force: true })
  fs.mkdirSync(buildDirectory, { recursive: true })
  fs.rmSync(path.join(root, crashDirectory), { recursive: true, force: true })
  fs.mkdirSync(path.join(root, crashDirectory), { recursive: true })
  if (corpus) {
    fs.rmSync(path.join(root, runtimeCorpusDirectory), { recursive: true, force: true })
    fs.mkdirSync(path.join(root, runtimeCorpusDirectory), { recursive: true })
    fs.cpSync(path.join(root, corpus.path), path.join(root, runtimeCorpusDirectory), { recursive: true })
  }
  const configureArgs = [
    '-S', root,
    '-B', buildDirectory,
    '-DCMAKE_BUILD_TYPE=RelWithDebInfo',
    `-DCMAKE_CXX_COMPILER=${compilerPath}`,
    `-DFSUSBLOG_ENABLE_FUZZING=${options.profile === 'fuzz-sanitizer' ? 'ON' : 'OFF'}`,
    `-DFSUSBLOG_ENABLE_SANITIZERS=${options.profile === 'fuzz-sanitizer' ? 'ON' : 'OFF'}`
  ]
  let status = run(cmakePath, configureArgs)
  if (status === 0) status = run(cmakePath, ['--build', buildDirectory, '--target', target.cmakeTarget, '--parallel', String(options.jobs)])
  if (status === 0 && options.profile === 'smoke') {
    status = run(ctestPath, ['--test-dir', buildDirectory, '--output-on-failure', '-R', `^${target.ctestName}$`])
  } else if (status === 0) {
    const executable = path.join(buildDirectory, 'tests/native', target.cmakeTarget)
    status = run(executable, [
      `-runs=${options.runs}`,
      `-jobs=${options.jobs}`,
      `-artifact_prefix=${path.join(root, crashDirectory)}/`,
      path.join(root, runtimeCorpusDirectory)
    ])
  }

  const crashes = walk(crashDirectory)
  receipt.crashArtifacts.count = crashes.length
  receipt.crashArtifacts.digest = fileSetDigest(crashes)
  receipt.outcome = status === 0 ? 'passed' : 'failed'
  writeReceipt(receiptPath, receipt)
  const receiptErrors = validateNativeReceipt(receipt, profile, target)
  if (receiptErrors.length > 0) throw new Error(`native receipt is invalid:\n${receiptErrors.join('\n')}`)
  if (status !== 0) process.exitCode = status
}

main()
