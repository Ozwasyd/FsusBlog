import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMatrix, parseMatrixValue as parseValue } from '../../test-matrix/parse-matrix.mjs'

export const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'))
export { parseMatrix, parseValue }

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
