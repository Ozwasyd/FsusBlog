import { strict as assert } from 'node:assert'
import {
  defaultCanvasViewport,
  type CanvasGraphEdge,
  type CanvasGraphHeader,
  type CanvasNode,
} from '../../src/Contracts/canvas-graph.ts'

export const defaultNodeGeo = { x: 1000, y: 2000, width: 17000, height: 10000 }

export const canvasUuid = (n: number, prefix = '33333333') =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`

export const canvasHeader = (overrides: Partial<CanvasGraphHeader> = {}): CanvasGraphHeader => ({
  id: canvasUuid(1),
  revision: 1n,
  title: 'Test Canvas',
  viewport: defaultCanvasViewport,
  deleted: false,
  nodeCount: 0,
  edgeCount: 0,
  touchedAt: 1_700_000_000_000,
  ...overrides,
})

export const canvasNote = (
  n: number,
  text = `Note ${n}`,
  geometry = defaultNodeGeo,
  prefix?: string,
): CanvasNode => ({ id: canvasUuid(n, prefix), kind: 'plain-text-note', geometry, text })

export const canvasArticleRef = (
  n: number,
  articleId: number,
  pinnedRevision: bigint | null = null,
  geometry = defaultNodeGeo,
  prefix?: string,
): Extract<CanvasNode, { kind: 'article-reference' }> => ({
  id: canvasUuid(n, prefix),
  kind: 'article-reference',
  geometry,
  articleId,
  pinnedRevision,
})

export const canvasFrame = (
  n: number,
  memberIds: string[] = [],
  text = `Frame ${n}`,
  geometry = { x: 0, y: 0, width: 20_000, height: 15_000 },
  prefix?: string,
): CanvasNode => ({ id: canvasUuid(n, prefix), kind: 'group-frame', geometry, text, memberIds })

export const canvasEdge = (
  id: number,
  sourceNodeId: string,
  targetNodeId: string,
  kind: CanvasGraphEdge['kind'] = 'visual-only',
  order = 0,
  label: string | null = null,
  prefix?: string,
): CanvasGraphEdge => ({ id: canvasUuid(id, prefix), kind, sourceNodeId, targetNodeId, order, label })

export async function flushMicrotasks(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

export function expectFields<T extends object>(actual: T | undefined, expected: Partial<T>): void {
  assert.ok(actual !== undefined)
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual((actual as Record<string, unknown>)[key], value, key)
}
