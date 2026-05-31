#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..'))
const matrixFile = path.join(root, 'tests/matrix.yml')
const testSh = fs.readFileSync(path.join(root, 'tools/test.sh'), 'utf8')
const errors = []

function fail(message) {
  errors.push(`[test-matrix] ${message}`)
}

function parseEntries(text) {
  const entries = []
  let current = null
  for (const line of text.split(/\r?\n/)) {
    const idMatch = line.match(/^\s*-\s+id:\s+(.+?)\s*$/)
    if (idMatch) {
      current = { id: idMatch[1], fields: new Map([['id', idMatch[1]]]) }
      entries.push(current)
      continue
    }
    if (!current) continue
    const fieldMatch = line.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (fieldMatch) current.fields.set(fieldMatch[1], fieldMatch[2])
  }
  return entries
}

if (!fs.existsSync(matrixFile)) {
  fail('missing tests/matrix.yml')
} else {
  const entries = parseEntries(fs.readFileSync(matrixFile, 'utf8'))
  const requiredTiers = [
    'fast',
    'integration',
    'ci',
    'coverage-gate',
    'release',
    'acceptance',
    'visual',
    'security',
    'resilience',
    'load',
    'production'
  ]
  const ids = new Set(entries.map((entry) => entry.id))
  for (const tier of requiredTiers) {
    if (!ids.has(tier)) fail(`missing tier ${tier}`)
  }

  for (const entry of entries) {
    for (const field of ['owner', 'command', 'script', 'evidence']) {
      if (!entry.fields.get(field)) fail(`${entry.id} is missing ${field}`)
    }
    const command = entry.fields.get('command') ?? ''
    if (!command.includes(`./tools/test.sh ${entry.id}`) && !(entry.id === 'coverage-gate' && command.includes('./tools/test.sh coverage-gate'))) {
      fail(`${entry.id} command does not delegate to tools/test.sh`)
    }
    const script = entry.fields.get('script') ?? ''
    if (script && !fs.existsSync(path.join(root, script))) {
      fail(`${entry.id} script path does not exist: ${script}`)
    }
    if (!testSh.includes(`${entry.id})`) && !testSh.includes(`${entry.id}|`)) {
      fail(`${entry.id} is not handled by tools/test.sh`)
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error)
  process.exit(1)
}

console.log('[test-matrix] ok')
