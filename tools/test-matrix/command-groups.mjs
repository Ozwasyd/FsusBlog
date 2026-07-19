import fs from 'node:fs'
import path from 'node:path'

import { parseMatrix } from './parse-matrix.mjs'

export function loadTestMatrix(root) {
  return parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
}

export function resolveCommandGroup(matrix, groupId) {
  const id = String(groupId ?? '').trim()
  if (!id) throw new Error('matrix command group id is required')
  const group = matrix?.commandGroups?.[id]
  if (!group) throw new Error(`unknown matrix command group: ${id}`)
  if (group.lane !== id) throw new Error(`matrix command group ${id} must own lane ${id}`)
  return structuredClone(group)
}

export function loadCommandGroup(root, groupId) {
  return resolveCommandGroup(loadTestMatrix(root), groupId)
}
