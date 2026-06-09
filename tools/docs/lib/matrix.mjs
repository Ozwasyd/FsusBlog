import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'))

export function parseValue(raw) {
  const value = String(raw ?? '').trim()
  if (value === '[]') return []
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((item) => parseValue(item))
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/u.test(value)) return Number(value)
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

export function parseMatrix(text) {
  const matrix = { tiers: [] }
  let current = null
  let inTiers = false

  for (const rawLine of text.split(/\r?\n/u)) {
    const withoutComment = rawLine.replace(/\s+#.*$/u, '')
    if (!withoutComment.trim()) continue

    const topMatch = withoutComment.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/u)
    if (topMatch && !rawLine.startsWith(' ')) {
      const [, key, value] = topMatch
      if (key === 'tiers') {
        inTiers = true
        current = null
        continue
      }
      matrix[key] = parseValue(value)
      continue
    }

    if (!inTiers) continue

    const itemMatch = withoutComment.match(/^\s{2}-\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/u)
    if (itemMatch) {
      current = {}
      matrix.tiers.push(current)
      current[itemMatch[1]] = parseValue(itemMatch[2])
      continue
    }

    const fieldMatch = withoutComment.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/u)
    if (fieldMatch && current) {
      current[fieldMatch[1]] = parseValue(fieldMatch[2])
    }
  }

  return matrix
}

export function loadMatrix(file = path.join(root, 'tests/matrix.yml')) {
  return parseMatrix(fs.readFileSync(file, 'utf8'))
}

export function tierMap(matrix) {
  return new Map(matrix.tiers.map((tier) => [tier.id, tier]))
}

export function planTier(matrix, requestedId) {
  const byId = tierMap(matrix)
  const targetId = requestedId === 'coverage' ? 'coverage-gate' : requestedId
  if (!byId.has(targetId)) throw new Error(`unknown tier: ${requestedId}`)

  const planned = []
  const visited = new Set()

  function visit(id) {
    if (visited.has(id)) return
    const tier = byId.get(id)
    if (!tier) throw new Error(`missing dependency: ${id}`)
    for (const dep of tier.dependsOn ?? []) visit(dep)
    visited.add(id)
    planned.push(tier)
  }

  visit(targetId)
  return planned
}

export function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}
