#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { parseMatrix } from '../test-matrix/parse-matrix.mjs'
import { validateNativeCatalog } from './native-test-catalog-validation.mjs'
import { validateNativeMatrix } from './native-test-matrix-validation.mjs'

export { validateNativeReceipt } from './native-test-receipt.mjs'

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export function validateNativeGovernance({ root, catalog, matrix }) {
  return [
    ...validateNativeCatalog({ root, catalog }),
    ...validateNativeMatrix({ catalog, matrix })
  ]
}

export function loadNativeGovernance(root = moduleRoot) {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/native-test-assets.json'), 'utf8'))
  const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
  return { catalog, matrix }
}

function main() {
  const { catalog, matrix } = loadNativeGovernance(moduleRoot)
  const errors = validateNativeGovernance({ root: moduleRoot, catalog, matrix })
  if (errors.length > 0) {
    console.error(`native test governance failed (${errors.length} errors):`)
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }
  console.log(`native test governance passed (${catalog.targets.length} targets, ${catalog.corpora.length} corpus, ${catalog.profiles.length} profiles)`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
