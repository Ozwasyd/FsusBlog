#!/usr/bin/env node
import fs from 'node:fs'
import {
  buildOpenApiFromMatrix,
  generatedMatrixFromOpenApi,
  generatedMatrixPath,
  loadMatrix,
  loadOpenApi,
  loadProtocol,
  writeJson
} from './lib/openapi-contracts.mjs'

const args = process.argv.slice(2)
const check = args.includes('--check')
const writeOpenApiIndex = args.indexOf('--write-openapi')
const writeOpenApiPath = writeOpenApiIndex >= 0 ? args[writeOpenApiIndex + 1] : null

if (writeOpenApiPath) {
  writeJson(writeOpenApiPath, buildOpenApiFromMatrix(loadMatrix(), loadProtocol()))
  process.exit(0)
}

const generated = generatedMatrixFromOpenApi(loadOpenApi(), loadMatrix())
const text = `${JSON.stringify(generated, null, 2)}\n`

if (check) {
  const current = fs.existsSync(generatedMatrixPath) ? fs.readFileSync(generatedMatrixPath, 'utf8') : ''
  if (current !== text) {
    console.error('[cross-stack-contract] generated matrix drifted; run tools/contracts/generate-cross-stack-contract.mjs')
    process.exit(1)
  }
  console.log('[cross-stack-contract] generated matrix in sync')
} else {
  fs.mkdirSync(new URL('../../tests/frontend/fixtures/', import.meta.url), { recursive: true })
  fs.writeFileSync(generatedMatrixPath, text)
  console.log(`[cross-stack-contract] wrote ${generatedMatrixPath}`)
}
