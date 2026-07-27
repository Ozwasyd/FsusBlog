#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { relative, root } from './lib/matrix.mjs'

const matrixFile = path.join(root, 'tests/frontend/fixtures/ux-viewport-matrix.json')
const docsFile = path.join(root, 'docs/testing.md')
const outFile = path.join(path.resolve(process.env.FSUSBLOG_DOCS_EVIDENCE_DIR || path.join(root, '.tmp/docs')), 'viewport-doc-sync.json')
const matrix = JSON.parse(fs.readFileSync(matrixFile, 'utf8'))
const docs = fs.readFileSync(docsFile, 'utf8')
const errors = []

if (matrix.version !== 'fsusblog-ux-viewport-matrix-v1') {
  errors.push(`unexpected viewport matrix version: ${matrix.version}`)
}

if (!docs.includes('tests/frontend/fixtures/ux-viewport-matrix.json')) {
  errors.push('docs/testing.md must name the viewport registry source')
}

for (const viewport of matrix.viewports.filter((item) => item.screenshotBaseline)) {
  const token = `${viewport.width}x${viewport.height}`
  if (!docs.includes(token)) {
    errors.push(`docs/testing.md must mention screenshot baseline viewport ${viewport.name} ${token}`)
  }
}

const summary = {
  status: errors.length === 0 ? 'ok' : 'failed',
  generatedAt: new Date().toISOString(),
  source: relative(matrixFile),
  docs: relative(docsFile),
  screenshotBaselines: matrix.viewports
    .filter((item) => item.screenshotBaseline)
    .map((item) => ({ name: item.name, width: item.width, height: item.height })),
  errors
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)

if (errors.length > 0) {
  for (const error of errors) console.error(`[viewport-doc-sync] ${error}`)
  process.exit(1)
}
console.log('[viewport-doc-sync] ok')
