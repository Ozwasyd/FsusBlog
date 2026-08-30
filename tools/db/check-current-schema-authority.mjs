#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const canonicalRelative = 'src/backend/Infrastructure/SchemaMigration/CurrentSchemaCanonicalModel.cs'
const inspectorRelative = 'src/backend/Infrastructure/SchemaMigration/SchemaModelInspector.cs'

function sourceFiles(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(absolute)
      return entry.isFile() && entry.name.endsWith('.cs') ? [absolute] : []
    })
}

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].length
}

export function validateCurrentSchemaAuthority(root) {
  const errors = []
  const backendRoot = path.join(root, 'src/backend')
  const files = sourceFiles(backendRoot)
  const sources = files.map((absolute) => ({
    absolute,
    relative: path.relative(root, absolute).replaceAll(path.sep, '/'),
    source: fs.readFileSync(absolute, 'utf8')
  }))
  const canonical = sources.find((entry) => entry.relative === canonicalRelative)
  const inspector = sources.find((entry) => entry.relative === inspectorRelative)
  if (!canonical) errors.push(`missing canonical current schema authority: ${canonicalRelative}`)
  if (!inspector) errors.push(`missing runtime current schema adapter: ${inspectorRelative}`)
  if (!canonical || !inspector) return errors

  const combined = sources.map((entry) => entry.source).join('\n')
  for (const [label, pattern] of [
    ['CurrentSchemaCanonicalAuthority', /\b(?:static\s+)?class\s+CurrentSchemaCanonicalAuthority\b/gu],
    ['CurrentSchemaProjection', /\brecord\s+CurrentSchemaProjection\b/gu],
    ['RuntimeEntitySchemaAdapter', /\bclass\s+RuntimeEntitySchemaAdapter\b/gu],
    ['GeneratedCurrentSchemaProjectionAdapter', /\bclass\s+GeneratedCurrentSchemaProjectionAdapter\b/gu],
    ['MigrationTargetSchemaAdapter', /\bclass\s+MigrationTargetSchemaAdapter\b/gu],
    ['CurrentSchemaIndependentVerifier', /\b(?:static\s+)?class\s+CurrentSchemaIndependentVerifier\b/gu]
  ]) {
    const count = occurrences(combined, pattern)
    if (count !== 1) errors.push(`${label} must have exactly one production declaration; found ${count}`)
  }

  if (occurrences(canonical.source, /\bCurrentSchemaProjection\s+Generate\s*\(/gu) !== 1) {
    errors.push('canonical current schema authority must expose exactly one projection generator')
  }
  if (/SchemaMigration(?:Registry|Manifest|Descriptor)|GetDescriptors\s*\(/u.test(canonical.source)) {
    errors.push('migration catalog or descriptor cannot define current schema authority')
  }
  if (/\b(?:File|Directory)\.|tests\/|Fixtures\/|docs\//u.test(canonical.source)) {
    errors.push('current schema authority cannot be reconstructed from files, docs or test fixtures')
  }

  for (const entry of sources) {
    if (entry.relative === canonicalRelative || entry.relative === inspectorRelative) continue
    if (/new\s+SchemaTableModel\s*\(|CurrentSchemaCanonicalAuthority\.Extract\s*\(/u.test(entry.source)) {
      errors.push(`hand-written or second current schema producer is forbidden: ${entry.relative}`)
    }
  }
  if (!/CurrentSchemaCanonicalAuthority\.Extract\s*\(entityTypes\)/u.test(inspector.source)) {
    errors.push('runtime inspector must consume the canonical current schema extractor')
  }
  if (/SchemaMigration(?:Registry|Manifest)|GetDescriptors\s*\(/u.test(inspector.source)) {
    errors.push('runtime inspector cannot infer current schema from migration catalogs')
  }

  return errors
}

function main() {
  const rootArgumentIndex = process.argv.indexOf('--root')
  const root = rootArgumentIndex >= 0
    ? path.resolve(process.argv[rootArgumentIndex + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const errors = validateCurrentSchemaAuthority(root)
  if (errors.length > 0) {
    for (const error of errors) console.error(`[current-schema-authority] ${error}`)
    process.exitCode = 1
    return
  }
  console.log('[current-schema-authority] ok canonical=1 adapters=3 verifier=1')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
