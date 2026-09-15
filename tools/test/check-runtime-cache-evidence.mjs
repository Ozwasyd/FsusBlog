#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { digest, loadRuntimeCacheCatalog, sealReceipt, validateRuntimeCacheReceiptSet } from './runtime-cache-evidence-contract.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function parseArgs(args) {
  const result = {
    receiptDir: path.join(root, '.tmp/perf/runtime-cache/receipts'),
    summary: path.join(root, '.tmp/release-evidence/runtime-cache-summary.json')
  }
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--receipt-dir') result.receiptDir = path.resolve(root, args[++i] ?? '')
    else if (args[i] === '--summary') result.summary = path.resolve(root, args[++i] ?? '')
    else throw new Error(`unknown argument: ${args[i]}`)
  }
  return result
}

function contained(rootPath, candidate) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidate))
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function assertDirectory(directory, evidenceRoot) {
  if (!contained(evidenceRoot, directory)) throw new Error('receipt directory escapes the current runtime-cache evidence root')
  if (!fs.existsSync(directory)) throw new Error(`receipt directory is missing: ${directory}`)
  const metadata = fs.lstatSync(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('receipt directory must be a real non-symlink directory')
  const physicalRoot = fs.realpathSync(evidenceRoot)
  const physicalDirectory = fs.realpathSync(directory)
  if (!contained(physicalRoot, physicalDirectory)) throw new Error('receipt directory physical path escapes the current runtime-cache evidence root')
}

function readRegularReceipt(file) {
  const metadata = fs.lstatSync(file)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`receipt must be a regular non-symlink file: ${path.basename(file)}`)
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''))
}

function findJsonArtifacts(directory, results = []) {
  if (!fs.existsSync(directory)) return results
  const metadata = fs.lstatSync(directory)
  if (metadata.isSymbolicLink()) {
    results.push(directory)
    return results
  }
  if (metadata.isFile()) {
    if (directory.endsWith('.json')) results.push(directory)
    return results
  }
  if (!metadata.isDirectory()) return results
  for (const entry of fs.readdirSync(directory)) findJsonArtifacts(path.join(directory, entry), results)
  return results
}

function writeSummary(file, summary, repositoryRoot) {
  const summaryRoot = path.resolve(repositoryRoot, '.tmp/release-evidence')
  if (!contained(summaryRoot, file)) throw new Error('summary path escapes .tmp/release-evidence')
  fs.mkdirSync(summaryRoot, { recursive: true })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const physicalRoot = fs.realpathSync(summaryRoot)
  const physicalParent = fs.realpathSync(path.dirname(file))
  if (physicalParent !== physicalRoot && !contained(physicalRoot, physicalParent)) throw new Error('summary physical path escapes .tmp/release-evidence')
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

export function checkRuntimeCacheEvidence(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? root)
  const evidenceRoot = path.resolve(repositoryRoot, '.tmp/perf/runtime-cache')
  const receiptDir = path.resolve(options.receiptDir ?? path.join(evidenceRoot, 'receipts'))
  const summaryFile = path.resolve(options.summary ?? path.join(repositoryRoot, '.tmp/release-evidence/runtime-cache-summary.json'))
  const catalog = options.catalog ?? loadRuntimeCacheCatalog(options.catalogPath)
  const expectedNames = new Set(catalog.scenarios.map((scenario) => `${scenario.id}.json`))
  const errors = []
  const receipts = []

  try { assertDirectory(receiptDir, evidenceRoot) } catch (error) { errors.push(error.message) }
  if (errors.length === 0) {
    const entries = fs.readdirSync(receiptDir, { withFileTypes: true })
    for (const entry of entries) {
      const file = path.join(receiptDir, entry.name)
      if (!expectedNames.has(entry.name)) {
        errors.push(`unexpected or legacy artifact contaminates receipt directory: ${entry.name}`)
        continue
      }
      try { receipts.push(readRegularReceipt(file)) } catch (error) { errors.push(error.message) }
    }
    for (const expected of expectedNames) if (!entries.some((entry) => entry.name === expected)) errors.push(`missing receipt file: ${expected}`)
  }

  const legacyRoots = options.legacyRoots ?? [path.join(repositoryRoot, '.tmp/perf/backend-qps')]
  for (const legacyRoot of legacyRoots) {
    for (const artifact of findJsonArtifacts(path.resolve(legacyRoot))) errors.push(`legacy backend-qps artifact contamination: ${path.relative(repositoryRoot, artifact)}`)
  }
  errors.push(...validateRuntimeCacheReceiptSet(receipts, {
    catalog,
    repositoryRoot,
    expectedSource: options.expectedSource
  }))

  const summaryPayload = {
    schema: 'fsusblog.runtime-cache-evidence-summary.v2',
    status: errors.length === 0 ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    runId: receipts.length > 0 ? receipts[0].runId : null,
    scenarioIds: catalog.scenarios.map((scenario) => scenario.id),
    receiptDigests: Object.fromEntries(receipts.map((receipt) => [receipt.scenarioId, receipt.contentDigest])),
    catalogDigest: digest(catalog),
    errors
  }
  const summary = sealReceipt(summaryPayload)
  writeSummary(summaryFile, summary, repositoryRoot)
  if (summary.status !== 'passed') throw new Error(errors.join('\n') || 'runtime cache evidence failed closed')
  return summary
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkRuntimeCacheEvidence(parseArgs(process.argv.slice(2)))
  } catch (error) {
    console.error(`[runtime-cache-evidence] ${error.message}`)
    process.exitCode = 1
  }
}
