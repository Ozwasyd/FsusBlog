#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const clientRoot = process.cwd()
const repoRoot = resolve(clientRoot, '..')
const clientSrcRoot = join(clientRoot, 'src')
const serverRoot = join(repoRoot, 'FsusBlog.Server')

const violations = []

function walkFiles(dir, output = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'bin' || entry === 'obj') {
      continue
    }

    const fullPath = join(dir, entry)
    const stats = statSync(fullPath)

    if (stats.isDirectory()) {
      walkFiles(fullPath, output)
      continue
    }

    output.push(fullPath)
  }

  return output
}

function report(filePath, message) {
  violations.push(`${relative(repoRoot, filePath).replaceAll('\\', '/')}: ${message}`)
}

for (const filePath of walkFiles(clientSrcRoot)) {
  if (!/\.(ts|tsx|vue|js|mjs)$/.test(filePath)) {
    continue
  }

  const source = readFileSync(filePath, 'utf8')
  if (source.includes('signalr:')) {
    report(filePath, 'legacy signalr window event bus residue detected')
  }

  if (source.includes("window.dispatchEvent(new CustomEvent('signalr:")
    || source.includes('window.dispatchEvent(new CustomEvent("signalr:')) {
    report(filePath, 'legacy signalr dispatchEvent residue detected')
  }
}

for (const filePath of walkFiles(serverRoot)) {
  if (!filePath.endsWith('.cs')) {
    continue
  }

  const source = readFileSync(filePath, 'utf8')
  if (source.includes('Response.Body.FlushAsync(')) {
    report(filePath, 'direct Response.Body.FlushAsync detected in server stream path')
  }
}

for (const line of violations) {
  console.error(`[sse-runtime] ${line}`)
}

if (violations.length > 0) {
  process.exit(1)
}

console.log('[sse-runtime] ok')