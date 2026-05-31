#!/usr/bin/env node

import { readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { resolve, relative, extname } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')
const distDir = resolve(repoRoot, 'src/frontend/dist')
const evidenceDir = resolve(repoRoot, '.tmp/frontend')
const budgets = {
  totalBytes: Number(process.env.FSUSBLOG_ASSET_TOTAL_BUDGET_BYTES || 80 * 1024 * 1024),
  jsBytes: Number(process.env.FSUSBLOG_ASSET_JS_BUDGET_BYTES || 900 * 1024),
  cssBytes: Number(process.env.FSUSBLOG_ASSET_CSS_BUDGET_BYTES || 600 * 1024),
  wasmBytes: Number(process.env.FSUSBLOG_ASSET_WASM_BUDGET_BYTES || 220 * 1024)
}

async function walk(dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(fullPath, files)
    } else {
      const info = await stat(fullPath)
      files.push({
        path: relative(repoRoot, fullPath).replaceAll('\\', '/'),
        bytes: info.size,
        ext: extname(entry.name)
      })
    }
  }
  return files
}

function budgetFor(file) {
  if (file.ext === '.js') return budgets.jsBytes
  if (file.ext === '.css') return budgets.cssBytes
  if (file.ext === '.wasm') return budgets.wasmBytes
  return null
}

const files = await walk(distDir)
const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
const violations = []

if (totalBytes > budgets.totalBytes) {
  violations.push({
    path: 'src/frontend/dist',
    bytes: totalBytes,
    budgetBytes: budgets.totalBytes
  })
}

for (const file of files) {
  const budgetBytes = budgetFor(file)
  if (budgetBytes !== null && file.bytes > budgetBytes) {
    violations.push({
      path: file.path,
      bytes: file.bytes,
      budgetBytes
    })
  }
}

const summary = {
  status: violations.length === 0 ? 'ok' : 'blocked',
  generatedAt: new Date().toISOString(),
  budgets,
  totalBytes,
  largest: files
    .filter((file) => ['.js', '.css', '.wasm'].includes(file.ext))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 20),
  violations
}

await mkdir(evidenceDir, { recursive: true })
await writeFile(resolve(evidenceDir, 'asset-size-budget.json'), `${JSON.stringify(summary, null, 2)}\n`)

if (violations.length > 0) {
  console.error(`[check-asset-size-budget] blocked ${JSON.stringify(violations, null, 2)}`)
  process.exit(1)
}

console.log(`[check-asset-size-budget] ok | total=${totalBytes} bytes | files=${files.length}`)
