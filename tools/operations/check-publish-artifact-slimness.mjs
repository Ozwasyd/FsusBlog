#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  loadStaticClientPayloadBudget,
  parsePositiveFiniteSafeBudget,
  resolveStaticPayloadBudgetExecution
} from './static-client-payload-budget.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const defaultPublishDir = path.join(rootDir, 'src', 'backend', 'bin', 'Release', 'net10.0', 'publish')
const defaultOutFile = path.join(rootDir, '.tmp', 'release-evidence', 'publish-artifacts-summary.json')
const staticClientPayloadBudget = loadStaticClientPayloadBudget()
const budgetOverrideEnvironmentNames = [
  'FSUSBLOG_PUBLISH_CLIENT_RUNTIME_MAX_MIB',
  'FSUSBLOG_PUBLISH_WWWROOT_MAX_MIB',
  'FSUSBLOG_PUBLISH_MAX_FILE_COUNT'
]
const budgetExecution = resolveStaticPayloadBudgetExecution(process.env, budgetOverrideEnvironmentNames)
const budgetAuthority = {
  schema: staticClientPayloadBudget.schema,
  budgetModel: staticClientPayloadBudget.budgetModel,
  baseline: staticClientPayloadBudget.baseline,
  ...budgetExecution
}

const defaultBudgets = {
  clientRuntimeMaxBytes: parsePositiveFiniteSafeBudget(
    process.env.FSUSBLOG_PUBLISH_CLIENT_RUNTIME_MAX_MIB,
    'FSUSBLOG_PUBLISH_CLIENT_RUNTIME_MAX_MIB',
    { defaultValue: 50, multiplier: 1024 * 1024 }
  ),
  wwwRootMaxBytes: process.env.FSUSBLOG_PUBLISH_WWWROOT_MAX_MIB === undefined
    ? staticClientPayloadBudget.maxTotalBytes
    : parsePositiveFiniteSafeBudget(
        process.env.FSUSBLOG_PUBLISH_WWWROOT_MAX_MIB,
        'FSUSBLOG_PUBLISH_WWWROOT_MAX_MIB',
        { multiplier: 1024 * 1024 }
      ),
  wwwRootMaxFileCount: staticClientPayloadBudget.maxFileCount,
  maxFileCount: parsePositiveFiniteSafeBudget(
    process.env.FSUSBLOG_PUBLISH_MAX_FILE_COUNT,
    'FSUSBLOG_PUBLISH_MAX_FILE_COUNT',
    { defaultValue: 5000 }
  )
}

function parseArgs(argv) {
  const options = {
    publishDir: process.env.FSUSBLOG_PUBLISH_DIR || defaultPublishDir,
    outFile: process.env.FSUSBLOG_PUBLISH_ARTIFACT_SUMMARY || defaultOutFile,
    requirePublishDir: false,
    selfTest: false
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--publish-dir') {
      options.publishDir = argv[++i]
      continue
    }
    if (arg === '--out') {
      options.outFile = argv[++i]
      continue
    }
    if (arg === '--require-publish-dir') {
      options.requirePublishDir = true
      continue
    }
    if (arg === '--self-test') {
      options.selfTest = true
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }

  options.publishDir = path.resolve(options.publishDir)
  options.outFile = path.resolve(options.outFile)
  return options
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function relativePath(from, to) {
  const rel = toPosix(path.relative(from, to))
  return rel.length === 0 ? '.' : rel
}

function collectFiles(dir) {
  const files = []
  if (!fs.existsSync(dir)) {
    return files
  }

  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath)
        files.push({ path: fullPath, bytes: stat.size })
      }
    }
  }

  return files
}

function sumBytes(files) {
  return files.reduce((sum, file) => sum + file.bytes, 0)
}

function largestFiles(files, baseDir, count = 20) {
  return [...files]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, count)
    .map((file) => ({
      path: relativePath(baseDir, file.path),
      bytes: file.bytes
    }))
}

function isForbiddenClientRuntimePath(rel) {
  const normalized = toPosix(rel)
  return normalized === 'src'
    || normalized.startsWith('src/')
    || normalized === 'tests'
    || normalized.startsWith('tests/')
    || normalized === 'coverage'
    || normalized.startsWith('coverage/')
    || normalized === '.vite'
    || normalized.startsWith('.vite/')
    || normalized === 'node_modules'
    || normalized.startsWith('node_modules/')
    || normalized === 'dist'
    || normalized.startsWith('dist/')
    || /^wasm\/build[^/]*(?:\/|$)/u.test(normalized)
    || normalized.startsWith('wasm/.artifacts/')
    || normalized.startsWith('wasm/.cmake/')
    || normalized.startsWith('wasm/.emscripten-cache/')
    || normalized.endsWith('.tsbuildinfo')
    || normalized.endsWith('.map')
}

function collectForbiddenClientRuntimeEntries(dir) {
  const forbidden = []
  if (!fs.existsSync(dir)) {
    return forbidden
  }

  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      const rel = relativePath(dir, fullPath)
      if (isForbiddenClientRuntimePath(rel)) {
        forbidden.push(rel)
      }
      if (entry.isDirectory()) {
        stack.push(fullPath)
      }
    }
  }

  return forbidden.sort()
}

function validatePublishDir(publishDir, budgets = defaultBudgets, requirePublishDir = false) {
  if (!fs.existsSync(publishDir)) {
    return {
      status: requirePublishDir ? 'blocked' : 'missing',
      publishDir,
      budgets,
      budgetAuthority,
      wwwrootBytes: 0,
      wwwrootFileCount: 0,
      clientRuntimeBytes: 0,
      totalPublishBytes: 0,
      fileCount: 0,
      largestFiles: [],
      violations: requirePublishDir ? [`publish directory is missing: ${publishDir}`] : []
    }
  }

  const wwwrootDir = path.join(publishDir, 'wwwroot')
  const clientRuntimeDir = path.join(publishDir, 'FsusBlog.ClientRuntime')
  const publishFiles = collectFiles(publishDir)
  const wwwrootFiles = collectFiles(wwwrootDir)
  const clientRuntimeFiles = collectFiles(clientRuntimeDir)
  const hasClientAssets = fs.existsSync(path.join(wwwrootDir, 'index.html')) || fs.existsSync(clientRuntimeDir)
  const violations = []
  const forbiddenClientRuntimeEntries = collectForbiddenClientRuntimeEntries(clientRuntimeDir)

  if (!hasClientAssets) {
    return {
      status: 'skipped',
      publishDir,
      budgets,
      budgetAuthority,
      wwwrootBytes: sumBytes(wwwrootFiles),
      wwwrootFileCount: wwwrootFiles.length,
      clientRuntimeBytes: 0,
      totalPublishBytes: sumBytes(publishFiles),
      fileCount: publishFiles.length,
      largestFiles: largestFiles(publishFiles, publishDir),
      violations: []
    }
  }

  const requiredRuntimeFiles = [
    'server/package.json',
    'server/public-ssr.mjs',
    'server/server-public-ssr.bundle.mjs',
    'server/server-public-ssr.worker-core.mjs',
    'package/package.json',
    'package/package-lock.json'
  ]
  for (const rel of requiredRuntimeFiles) {
    if (!fs.existsSync(path.join(clientRuntimeDir, rel))) {
      violations.push(`missing ClientRuntime required file: ${rel}`)
    }
  }
  if (!fs.existsSync(path.join(wwwrootDir, 'index.html'))) {
    violations.push('missing wwwroot/index.html')
  }
  if (forbiddenClientRuntimeEntries.length > 0) {
    violations.push(...forbiddenClientRuntimeEntries.map((rel) => `forbidden ClientRuntime entry: ${rel}`))
  }

  const clientRuntimeBytes = sumBytes(clientRuntimeFiles)
  const wwwrootBytes = sumBytes(wwwrootFiles)
  const totalPublishBytes = sumBytes(publishFiles)
  if (clientRuntimeBytes > budgets.clientRuntimeMaxBytes) {
    violations.push(`ClientRuntime exceeds budget: ${clientRuntimeBytes} bytes > ${budgets.clientRuntimeMaxBytes} bytes`)
  }
  if (wwwrootBytes > budgets.wwwRootMaxBytes) {
    violations.push(`wwwroot exceeds budget: ${wwwrootBytes} bytes > ${budgets.wwwRootMaxBytes} bytes`)
  }
  if (wwwrootFiles.length > budgets.wwwRootMaxFileCount) {
    violations.push(`wwwroot file count exceeds budget: ${wwwrootFiles.length} > ${budgets.wwwRootMaxFileCount}`)
  }
  if (publishFiles.length > budgets.maxFileCount) {
    violations.push(`publish file count exceeds budget: ${publishFiles.length} > ${budgets.maxFileCount}`)
  }

  return {
    status: violations.length === 0 ? 'ok' : 'blocked',
    publishDir,
    budgets,
    budgetAuthority,
    wwwrootBytes,
    wwwrootFileCount: wwwrootFiles.length,
    clientRuntimeBytes,
    totalPublishBytes,
    fileCount: publishFiles.length,
    largestFiles: largestFiles(publishFiles, publishDir),
    clientRuntime: {
      fileCount: clientRuntimeFiles.length,
      forbiddenFiles: forbiddenClientRuntimeEntries,
      nodeModulesPresent: forbiddenClientRuntimeEntries.some((rel) => rel === 'node_modules' || rel.startsWith('node_modules/'))
    },
    violations
  }
}

function writeSummary(outFile, summary) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
}

function writeFixture(root, files) {
  for (const [rel, contents] of Object.entries(files)) {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents)
  }
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-publish-slimness-'))
  try {
    const publishDir = path.join(tmp, 'publish')
    writeFixture(publishDir, {
      'wwwroot/index.html': '<!doctype html>',
      'wwwroot/assets/app.js': 'console.log(1)',
      'FsusBlog.ClientRuntime/server/package.json': '{"private":true,"type":"module"}',
      'FsusBlog.ClientRuntime/server/public-ssr.mjs': 'export const PUBLIC_RENDERER_VERSION = "test"',
      'FsusBlog.ClientRuntime/server/server-public-ssr.bundle.mjs': 'import "./public-ssr.mjs"',
      'FsusBlog.ClientRuntime/server/server-public-ssr.worker-core.mjs': 'export {}',
      'FsusBlog.ClientRuntime/package/package.json': '{}',
      'FsusBlog.ClientRuntime/package/package-lock.json': '{}'
    })
    const ok = validatePublishDir(publishDir, defaultBudgets, true)
    if (ok.status !== 'ok') {
      throw new Error(`expected valid fixture to pass: ${ok.violations.join('; ')}`)
    }

    const overBudgetFile = path.join(publishDir, 'wwwroot', 'assets', 'over-budget.bin')
    fs.writeFileSync(overBudgetFile, '')
    fs.truncateSync(overBudgetFile, staticClientPayloadBudget.maxTotalBytes + 1)
    const overBudget = validatePublishDir(publishDir, defaultBudgets, true)
    if (overBudget.status !== 'blocked' || !overBudget.violations.some((violation) => violation.includes('wwwroot exceeds budget'))) {
      throw new Error('expected audited static-client baseline growth to block')
    }
    fs.rmSync(overBudgetFile)

    const overFileCountDir = path.join(publishDir, 'wwwroot', 'file-count-fixture')
    fs.mkdirSync(overFileCountDir)
    for (let index = 0; index < staticClientPayloadBudget.maxFileCount; index += 1) {
      fs.writeFileSync(path.join(overFileCountDir, String(index)), '')
    }
    const overFileCount = validatePublishDir(publishDir, defaultBudgets, true)
    if (overFileCount.status !== 'blocked' || !overFileCount.violations.some((violation) => violation.includes('wwwroot file count exceeds budget'))) {
      throw new Error('expected audited static-client file-count growth to block')
    }
    fs.rmSync(overFileCountDir, { recursive: true, force: true })

    writeFixture(publishDir, {
      'FsusBlog.ClientRuntime/src/main.ts': 'export {}'
    })
    const blocked = validatePublishDir(publishDir, defaultBudgets, true)
    if (blocked.status !== 'blocked' || !blocked.violations.some((violation) => violation.includes('src/main.ts'))) {
      throw new Error('expected forbidden frontend source to block')
    }

    fs.rmSync(path.join(publishDir, 'FsusBlog.ClientRuntime', 'src'), { recursive: true, force: true })
    fs.mkdirSync(path.join(publishDir, 'FsusBlog.ClientRuntime', 'node_modules'), { recursive: true })
    const blockedEmptyNodeModules = validatePublishDir(publishDir, defaultBudgets, true)
    if (blockedEmptyNodeModules.status !== 'blocked' || !blockedEmptyNodeModules.violations.some((violation) => violation.includes('node_modules'))) {
      throw new Error('expected empty node_modules directory to block')
    }

    const missing = validatePublishDir(path.join(tmp, 'missing'), defaultBudgets, false)
    if (missing.status !== 'missing') {
      throw new Error('expected missing publish dir to be reported as missing without failure')
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  console.log('[publish-slimness] self-test ok')
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.selfTest) {
    runSelfTest()
    return
  }

  const summary = validatePublishDir(options.publishDir, defaultBudgets, options.requirePublishDir)
  writeSummary(options.outFile, summary)
  if (summary.status === 'blocked') {
    for (const violation of summary.violations) {
      console.error(`[publish-slimness] violation: ${violation}`)
    }
    process.exit(1)
  }

  console.log(`[publish-slimness] ${summary.status} | files=${summary.fileCount} totalBytes=${summary.totalPublishBytes} runtimeBytes=${summary.clientRuntimeBytes} out=${relativePath(rootDir, options.outFile)}`)
}

main()
