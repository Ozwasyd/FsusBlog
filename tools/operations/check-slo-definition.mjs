#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'))
const sloFile = path.join(root, 'config/slo.yml')
const errors = []

function fail(message) {
  errors.push(`[slo-definition] ${message}`)
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

if (!fs.existsSync(sloFile)) {
  fail('missing config/slo.yml')
} else {
  const text = fs.readFileSync(sloFile, 'utf8')
  if (!text.includes('version: fsusblog-slo-v1')) fail('config/slo.yml has invalid version')
  const entries = parseEntries(text)
  const required = [
    'availability',
    'error-rate',
    'http-p95-latency',
    'http-p99-latency',
    'notification-stream-reconnect-success-rate',
    'aot-hit-rate',
    'search-rebuild-success-rate',
    'scheduled-publish-delay',
    'redis-prefix-registry-fallback',
    'public-hot-read-sensitive-bypass'
  ]
  const ids = new Set(entries.map((entry) => entry.id))
  for (const id of required) {
    if (!ids.has(id)) fail(`missing SLO ${id}`)
  }

  for (const entry of entries) {
    for (const field of ['objective', 'window', 'source', 'alert']) {
      if (!entry.fields.get(field)) fail(`${entry.id} is missing ${field}`)
    }
    const objective = Number(entry.fields.get('objective'))
    const unit = entry.fields.get('unit') ?? ''
    if (!Number.isFinite(objective) || objective < 0 || (objective === 0 && unit !== 'events')) {
      fail(`${entry.id} has invalid objective`)
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error)
  process.exit(1)
}

console.log('[slo-definition] ok')
