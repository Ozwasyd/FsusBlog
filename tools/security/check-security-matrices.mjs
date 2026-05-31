#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'))
const checks = [
  {
    file: 'security/asvs-v5.0.0-matrix.yml',
    listKey: 'requirements',
    idPattern: /^ASVS-\d+\.\d+\.\d+$/,
    label: 'ASVS'
  },
  {
    file: 'security/wstg-v4.2-matrix.yml',
    listKey: 'scenarios',
    idPattern: /^WSTG-v42-[A-Z]+-\d+$/,
    label: 'WSTG'
  },
  {
    file: 'security/webauthn-matrix.yml',
    listKey: 'scenarios',
    idPattern: /^WEBAUTHN-[A-Z-]+$/,
    label: 'WebAuthn'
  }
]

const errors = []

function fail(message) {
  errors.push(`[security-matrix] ${message}`)
}

function repoPathExists(value) {
  if (value.startsWith('.tmp/')) return true
  if (value.startsWith('src/frontend/test-results/')) return true
  return fs.existsSync(path.join(root, value))
}

function parseEntries(text) {
  const lines = text.split(/\r?\n/)
  const entries = []
  let current = null
  let currentSection = null

  for (const line of lines) {
    const idMatch = line.match(/^\s*-\s+id:\s+(.+?)\s*$/)
    if (idMatch) {
      current = {
        id: idMatch[1].trim(),
        fields: new Set(['id']),
        paths: []
      }
      entries.push(current)
      currentSection = null
      continue
    }

    if (!current) continue

    const fieldMatch = line.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):/)
    if (fieldMatch) {
      current.fields.add(fieldMatch[1])
      currentSection = fieldMatch[1]
      continue
    }

    const pathMatch = line.match(/^\s{6}-\s+(.+?)\s*$/)
    if (pathMatch && ['code', 'tests', 'evidence'].includes(currentSection)) {
      current.paths.push({
        section: currentSection,
        value: pathMatch[1].trim()
      })
    }
  }

  return entries
}

for (const check of checks) {
  const absolute = path.join(root, check.file)
  if (!fs.existsSync(absolute)) {
    fail(`missing ${check.file}`)
    continue
  }

  const text = fs.readFileSync(absolute, 'utf8')
  if (!text.includes(`${check.listKey}:`)) {
    fail(`${check.file} is missing ${check.listKey}`)
  }

  const entries = parseEntries(text)
  if (entries.length === 0) {
    fail(`${check.file} has no entries`)
    continue
  }

  for (const entry of entries) {
    if (!check.idPattern.test(entry.id)) {
      fail(`${check.file} has invalid ${check.label} id: ${entry.id}`)
    }

    for (const field of ['owner', 'status', 'code', 'tests', 'evidence']) {
      if (!entry.fields.has(field)) {
        fail(`${check.file} ${entry.id} is missing ${field}`)
      }
    }

    for (const section of ['code', 'tests', 'evidence']) {
      if (!entry.paths.some((item) => item.section === section)) {
        fail(`${check.file} ${entry.id} has empty ${section}`)
      }
    }

    for (const item of entry.paths) {
      if (!repoPathExists(item.value)) {
        fail(`${check.file} ${entry.id} references missing ${item.section} path: ${item.value}`)
      }
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error)
  process.exit(1)
}

console.log('[security-matrix] ok')
