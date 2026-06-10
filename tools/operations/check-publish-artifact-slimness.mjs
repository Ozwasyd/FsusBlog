#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const defaultPublishDir = path.join(rootDir, 'src', 'backend', 'bin', 'Release', 'net10.0', 'publish')
const defaultOutFile = path.join(rootDir, '.tmp', 'release-evidence', 'publish-artifacts-summary.json')

const defaultBudgets = {
  clientRuntimeMaxMiB: Number(process.env.FSUSBLOG_PUBLISH_CLIENT_RUNTIME_MAX_MIB || 50),
  wwwRootMaxMiB: Number(process.env.FSUSBLOG_PUBLISH_WWWROOT_MAX_MIB || 80),
  maxFileCount: Number(process.env.FSUSBLOG_PUBLISH_MAX_FILE_COUNT || 5000)
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
      wwwrootBytes: 0,
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
      wwwrootBytes: sumBytes(wwwrootFiles),
      clientRuntimeBytes: 0,
      totalPublishBytes: sumBytes(publishFiles),
      fileCount: publishFiles.length,
      largestFiles: largestFiles(publishFiles, publishDir),
      violations: []
    }
  }

  const requiredRuntimeFiles = [
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
  if (clientRuntimeBytes > budgets.clientRuntimeMaxMiB * 1024 * 1024) {
    violations.push(`ClientRuntime exceeds budget: ${clientRuntimeBytes} bytes > ${budgets.clientRuntimeMaxMiB} MiB`)
  }
  if (wwwrootBytes > budgets.wwwRootMaxMiB * 1024 * 1024) {
    violations.push(`wwwroot exceeds budget: ${wwwrootBytes} bytes > ${budgets.wwwRootMaxMiB} MiB`)
  }
  if (publishFiles.length > budgets.maxFileCount) {
    violations.push(`publish file count exceeds budget: ${publishFiles.length} > ${budgets.maxFileCount}`)
  }

  return {
    status: violations.length === 0 ? 'ok' : 'blocked',
    publishDir,
    budgets,
    wwwrootBytes,
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
