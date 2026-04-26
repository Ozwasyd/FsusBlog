#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REQUIRED_PAGE_IDS = ['1', '2', '3', '4', '5']

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function extractPageIdsFromValidatorBlock(source, fileLabel) {
  const markerMatch = /const\s+entryValidators\b/.exec(source)
  assert(markerMatch && typeof markerMatch.index === 'number', `${fileLabel} missing entryValidators symbol`)
  const markerIndex = markerMatch.index

  const openIndex = source.indexOf('{', markerIndex)
  assert(openIndex >= 0, `${fileLabel} missing entryValidators opening brace`)

  let depth = 0
  let closeIndex = -1
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        closeIndex = i
        break
      }
    }
  }

  assert(closeIndex > openIndex, `${fileLabel} missing entryValidators closing brace`)
  const block = source.slice(openIndex + 1, closeIndex)
  const ids = new Set()
  for (const match of block.matchAll(/\b([1-5])\s*:/g)) {
    ids.add(match[1])
  }
  return ids
}

function ensureCoverage(ids, label) {
  for (const id of REQUIRED_PAGE_IDS) {
    assert(ids.has(id), `${label} missing pageId=${id} validator`)
  }
}

function main() {
  const root = resolve(process.cwd())
  const srcHelper = resolve(root, 'src/helpers/publicAotBundle.ts')
  const scriptHelper = resolve(root, 'scripts/public-hydration-bundle.mjs')

  const srcText = readFileSync(srcHelper, 'utf8')
  const scriptText = readFileSync(scriptHelper, 'utf8')

  const srcIds = extractPageIdsFromValidatorBlock(srcText, 'src/helpers/publicAotBundle.ts')
  const scriptIds = extractPageIdsFromValidatorBlock(scriptText, 'scripts/public-hydration-bundle.mjs')

  ensureCoverage(srcIds, 'src/helpers/publicAotBundle.ts')
  ensureCoverage(scriptIds, 'scripts/public-hydration-bundle.mjs')

  console.log('[check-public-pageid-coverage] ok (1..5)')
}

try {
  main()
} catch (error) {
  console.error('[check-public-pageid-coverage] failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}
