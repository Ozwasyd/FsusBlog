#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadRuntimeCacheCatalog, validateRuntimeCacheReceiptSet } from './runtime-cache-evidence-contract.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function parseArgs(args) {
  const result = { receiptDir: path.join(root, '.tmp/perf/runtime-cache'), summary: path.join(root, '.tmp/release-evidence/runtime-cache-summary.json') }
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--receipt-dir') result.receiptDir = path.resolve(root, args[++i])
    else if (args[i] === '--summary') result.summary = path.resolve(root, args[++i])
    else throw new Error(`unknown argument: ${args[i]}`)
  }
  return result
}

export function checkRuntimeCacheEvidence(options = {}) {
  const catalog = options.catalog ?? loadRuntimeCacheCatalog(options.catalogPath)
  const receipts = catalog.scenarios.map((scenario) => {
    const file = path.join(options.receiptDir, `${scenario.id}.json`)
    if (!fs.existsSync(file)) return { schema: null, scenarioId: scenario.id, __missing: true }
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''))
  })
  const errors = []
  for (const receipt of receipts) if (receipt.__missing) errors.push(`missing receipt file: ${receipt.scenarioId}.json`)
  const present = receipts.filter((receipt) => !receipt.__missing)
  errors.push(...validateRuntimeCacheReceiptSet(present, { catalog, repositoryRoot: options.repositoryRoot ?? root, expectedSource: options.expectedSource }))
  const summary = {
    schema: 'fsusblog.runtime-cache-evidence-summary.v1',
    status: errors.length === 0 && present.every((receipt) => receipt.status === 'passed') ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    scenarioIds: catalog.scenarios.map((scenario) => scenario.id),
    receiptDigests: Object.fromEntries(present.map((receipt) => [receipt.scenarioId, receipt.contentDigest])),
    errors
  }
  fs.mkdirSync(path.dirname(options.summary), { recursive: true })
  fs.writeFileSync(options.summary, `${JSON.stringify(summary, null, 2)}\n`)
  if (summary.status !== 'passed') throw new Error(errors.join('\n') || 'one or more runtime cache scenarios failed')
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
