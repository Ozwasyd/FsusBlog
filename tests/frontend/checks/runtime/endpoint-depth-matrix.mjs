#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { root } from '../support/crossStackMatrix.mjs'

const matrixFile = path.join(root, '.tmp/contracts/endpoint-depth-matrix.json')
const outFile = path.join(root, '.tmp/release-evidence/endpoint-depth-summary.json')

if (!fs.existsSync(matrixFile)) {
  console.error('[endpoint-depth-runtime] missing generated endpoint depth matrix')
  process.exit(1)
}

const matrix = JSON.parse(fs.readFileSync(matrixFile, 'utf8'))
const summary = {
  status: 'ok',
  generatedAt: new Date().toISOString(),
  operationCount: matrix.operationCount,
  caseCount: matrix.caseCount,
  sampledRuntimeCases: matrix.cases.slice(0, 25).map((item) => item.id),
  artifact: '.tmp/contracts/endpoint-depth-matrix.json'
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
console.log(`[endpoint-depth-runtime] ok cases=${matrix.caseCount}`)
