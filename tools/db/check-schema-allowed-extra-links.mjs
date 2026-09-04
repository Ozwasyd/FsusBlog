#!/usr/bin/env node
// Guard SchemaAllowedExtraLinkNames.generated.cs (Server-side migration link
// register) against drift: the register is derived from
// src/migration/Definitions/*.cs and must stay re-generatable.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const rootIndex = process.argv.indexOf('--root')
const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : defaultRoot
const failures = []

function fail(message) {
  failures.push(message)
}

function read(path) {
  const fullPath = join(root, path)
  if (!existsSync(fullPath)) {
    fail(`missing required path: ${path}`)
    return ''
  }
  return readFileSync(fullPath, 'utf8')
}

const generatedPath = 'src/backend/Infrastructure/SchemaMigration/SchemaAllowedExtraLinkNames.generated.cs'
const definitionsDir = 'src/migration/Definitions'
const generated = read(generatedPath)

const headerDigest = generated.match(/Source digest: sha256:([0-9a-f]{64})/)?.[1]
if (!headerDigest) {
  fail('generated link register is missing the source digest header')
}

const generatedNames = new Set(
  [...generated.matchAll(/"((?:idx|ux|fk|ck)_[a-z0-9_]+)"/g)].map((match) => match[1]),
)
if (generatedNames.size === 0) {
  fail('generated link register declares no names')
}

let definitionSource = ''
if (existsSync(join(root, definitionsDir))) {
  for (const file of readdirSync(join(root, definitionsDir))) {
    if (file.endsWith('.cs')) {
      definitionSource += readFileSync(join(root, definitionsDir, file), 'utf8')
    }
  }
}

// A link name must appear in Definitions as an index/constraint construct.
const definitionsText = definitionSource
for (const name of generatedNames) {
  if (!definitionsText.includes(name)) {
    fail(`link ${name} is not declared in src/migration/Definitions`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[schema-allowed-extra-links] ${failure}`)
  }
  process.exitCode = 1
} else {
  console.log(`[schema-allowed-extra-links] ok (${generatedNames.size} names)`)
}
