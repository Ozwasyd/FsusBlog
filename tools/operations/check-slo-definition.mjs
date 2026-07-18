#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { parseYamlDocument } from '../yaml/parse-document.mjs'

const root = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'))
const sloFile = path.join(root, 'config/observability/slo.yml')
const errors = []

function fail(message) {
  errors.push(`[slo-definition] ${message}`)
}

if (!fs.existsSync(sloFile)) {
  fail('missing config/observability/slo.yml')
} else {
  const text = fs.readFileSync(sloFile, 'utf8')
  if (!text.includes('version: fsusblog-slo-v1')) fail('config/observability/slo.yml has invalid version')
  let document = {}
  try {
    document = parseYamlDocument(text, { source: 'config/observability/slo.yml' })
  } catch (error) {
    fail(`config/observability/slo.yml is invalid YAML: ${error.message}`)
  }
  const entries = Array.isArray(document.slos)
    ? document.slos.map((entry) => ({
        id: String(entry?.id ?? ''),
        fields: new Map(Object.entries(entry ?? {}).map(([key, value]) => [key, String(value)]))
      }))
    : []
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
