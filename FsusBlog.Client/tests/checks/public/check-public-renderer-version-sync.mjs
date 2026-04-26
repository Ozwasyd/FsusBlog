#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function extractVersion(source, label) {
  const match = source.match(/PUBLIC_RENDERER_VERSION\s*=\s*['"]([^'"]+)['"]/)
  assert(match && match[1], `${label} missing PUBLIC_RENDERER_VERSION`)
  return match[1]
}

function main() {
  const clientRoot = resolve(process.cwd())
  const srcFile = resolve(clientRoot, 'src/public-renderers/renderPublicPage.ts')
  const scriptFile = resolve(clientRoot, 'scripts/public-hydration-bundle.mjs')

  const srcSource = readFileSync(srcFile, 'utf8')
  const scriptSource = readFileSync(scriptFile, 'utf8')

  const srcVersion = extractVersion(srcSource, 'src/public-renderers/renderPublicPage.ts')
  const scriptVersion = extractVersion(scriptSource, 'scripts/public-hydration-bundle.mjs')

  assert(
    srcVersion === scriptVersion,
    `PUBLIC_RENDERER_VERSION mismatch: src=${srcVersion}, scripts=${scriptVersion}`
  )

  console.log(`[check-public-renderer-version-sync] ok (${srcVersion})`)
}

try {
  main()
} catch (error) {
  console.error('[check-public-renderer-version-sync] failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}

