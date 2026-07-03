#!/usr/bin/env node

import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { resolve, relative, extname } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const repoRoot = resolve(process.cwd(), '../..')
const distDir = resolve(repoRoot, 'src/frontend/dist')
const evidenceDir = resolve(repoRoot, '.tmp/frontend')
const budgets = {
  totalBytes: Number(process.env.FSUSBLOG_ASSET_TOTAL_BUDGET_BYTES || 80 * 1024 * 1024),
  jsBytes: Number(process.env.FSUSBLOG_ASSET_JS_BUDGET_BYTES || 900 * 1024),
  cssBytes: Number(process.env.FSUSBLOG_ASSET_CSS_BUDGET_BYTES || 600 * 1024),
  appCssBytes: Number(process.env.FSUSBLOG_ASSET_APP_CSS_BUDGET_BYTES || 680 * 1024),
  wasmBytes: Number(process.env.FSUSBLOG_ASSET_WASM_BUDGET_BYTES || 220 * 1024),
  jsGzipBytes: Number(process.env.FSUSBLOG_ASSET_JS_GZIP_BUDGET_BYTES || 300 * 1024),
  jsBrotliBytes: Number(process.env.FSUSBLOG_ASSET_JS_BROTLI_BUDGET_BYTES || 260 * 1024),
  wasmGzipBytes: Number(process.env.FSUSBLOG_ASSET_WASM_GZIP_BUDGET_BYTES || 110 * 1024),
  wasmBrotliBytes: Number(process.env.FSUSBLOG_ASSET_WASM_BROTLI_BUDGET_BYTES || 95 * 1024),
  adminRouteChunkBytes: Number(process.env.FSUSBLOG_ASSET_ADMIN_ROUTE_CHUNK_BUDGET_BYTES || 430 * 1024),
  adminRouteChunkGzipBytes: Number(process.env.FSUSBLOG_ASSET_ADMIN_ROUTE_CHUNK_GZIP_BUDGET_BYTES || 120 * 1024),
  adminRouteChunkBrotliBytes: Number(process.env.FSUSBLOG_ASSET_ADMIN_ROUTE_CHUNK_BROTLI_BUDGET_BYTES || 95 * 1024),
  echartsVendorBytes: Number(process.env.FSUSBLOG_ASSET_ECHARTS_VENDOR_BUDGET_BYTES || 430 * 1024),
  echartsVendorGzipBytes: Number(process.env.FSUSBLOG_ASSET_ECHARTS_VENDOR_GZIP_BUDGET_BYTES || 135 * 1024),
  echartsVendorBrotliBytes: Number(process.env.FSUSBLOG_ASSET_ECHARTS_VENDOR_BROTLI_BUDGET_BYTES || 115 * 1024),
  elementPlusVendorBytes: Number(process.env.FSUSBLOG_ASSET_ELEMENT_PLUS_VENDOR_BUDGET_BYTES || 1220 * 1024),
  elementPlusVendorGzipBytes: Number(process.env.FSUSBLOG_ASSET_ELEMENT_PLUS_VENDOR_GZIP_BUDGET_BYTES || 370 * 1024),
  elementPlusVendorBrotliBytes: Number(process.env.FSUSBLOG_ASSET_ELEMENT_PLUS_VENDOR_BROTLI_BUDGET_BYTES || 310 * 1024)
}

async function walk(dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      const relativeDir = relative(repoRoot, fullPath).replaceAll('\\', '/')
      if (relativeDir === 'src/frontend/dist/server') {
        continue
      }
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
  if (isAdminRouteChunk(file)) return budgets.adminRouteChunkBytes
  if (isEchartsVendorChunk(file)) return budgets.echartsVendorBytes
  if (isElementPlusVendorChunk(file)) return budgets.elementPlusVendorBytes
  if (isFullAppCss(file)) return budgets.appCssBytes
  if (file.ext === '.js') return budgets.jsBytes
  if (file.ext === '.css') return budgets.cssBytes
  if (file.ext === '.wasm') return budgets.wasmBytes
  return null
}

function compressedBudgetFor(file, kind) {
  if (isAdminRouteChunk(file) && kind === 'gzip') return budgets.adminRouteChunkGzipBytes
  if (isAdminRouteChunk(file) && kind === 'brotli') return budgets.adminRouteChunkBrotliBytes
  if (isEchartsVendorChunk(file) && kind === 'gzip') return budgets.echartsVendorGzipBytes
  if (isEchartsVendorChunk(file) && kind === 'brotli') return budgets.echartsVendorBrotliBytes
  if (isElementPlusVendorChunk(file) && kind === 'gzip') return budgets.elementPlusVendorGzipBytes
  if (isElementPlusVendorChunk(file) && kind === 'brotli') return budgets.elementPlusVendorBrotliBytes
  if (file.ext === '.js' && kind === 'gzip') return budgets.jsGzipBytes
  if (file.ext === '.js' && kind === 'brotli') return budgets.jsBrotliBytes
  if (file.ext === '.wasm' && kind === 'gzip') return budgets.wasmGzipBytes
  if (file.ext === '.wasm' && kind === 'brotli') return budgets.wasmBrotliBytes
  return null
}

function isAdminRouteChunk(file) {
  return file.ext === '.js' && /(?:^|\/)route-admin(?:-[a-z0-9]+)?-[A-Za-z0-9_-]+\.js$/u.test(file.path)
}

function isEchartsVendorChunk(file) {
  return file.ext === '.js' && /(?:^|\/)(?:vendor-echarts|echartsRuntime\.bundle)-[A-Za-z0-9_-]+\.js$/u.test(file.path)
}

function isElementPlusVendorChunk(file) {
  return file.ext === '.js' && /(?:^|\/)vendor-element-plus-[A-Za-z0-9_-]+\.js$/u.test(file.path)
}

function isFullAppCss(file) {
  return file.ext === '.css' && /(?:^|\/)fullApp-[A-Za-z0-9_-]+\.css$/u.test(file.path)
}

const files = await walk(distDir)
const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
const violations = []
const compressed = []

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

  if (['.js', '.wasm'].includes(file.ext)) {
    const bytes = await readFile(resolve(repoRoot, file.path))
    const gzipBytes = gzipSync(bytes).byteLength
    const brotliBytes = brotliCompressSync(bytes).byteLength
    compressed.push({
      path: file.path,
      gzipBytes,
      brotliBytes
    })

    for (const [kind, actualBytes] of [['gzip', gzipBytes], ['brotli', brotliBytes]]) {
      const compressedBudget = compressedBudgetFor(file, kind)
      if (compressedBudget !== null && actualBytes > compressedBudget) {
        violations.push({
          path: `${file.path}.${kind}`,
          bytes: actualBytes,
          budgetBytes: compressedBudget
        })
      }
    }
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
  compressedLargest: compressed
    .sort((a, b) => Math.max(b.gzipBytes, b.brotliBytes) - Math.max(a.gzipBytes, a.brotliBytes))
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
