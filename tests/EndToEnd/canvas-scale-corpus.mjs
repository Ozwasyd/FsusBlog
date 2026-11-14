import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export const CANVAS_SCALE_NEAR_NOTE = 'Canvas scale nearby note'
export const CANVAS_SCALE_FAR_NOTE = 'Canvas scale distant note'
export const CANVAS_SCALE_FIRST_EDGE = 'Canvas scale first connection'
export const CANVAS_SCALE_FAR_EDGE = 'Canvas scale distant connection'
export const CANVAS_SCALE_HEADING_ANCHOR = 'scale-heading'
export const CANVAS_SCALE_BLOCK_ANCHOR = 'scale-block'
export const CANVAS_SCALE_ARTICLE_SOURCE = `# Canvas scale heading ^${CANVAS_SCALE_HEADING_ANCHOR}

Canvas scale block ^${CANVAS_SCALE_BLOCK_ANCHOR}
`

const title = 'Canvas scale 10000 nodes and edges'
const nodeCount = 10_000
const edgeCount = 10_000
const sourceRevision = 1

// Slot numbers are one-based and local to this fixture. Geometry uses Canvas
// hundredths of a unit. The first five cards can be exercised without panning.
export const CANVAS_SCALE_LOCATIONS = Object.freeze({
  firstArticle: Object.freeze({ slot: 1, x: 3_500, y: 13_000 }),
  pinnedHeading: Object.freeze({ slot: 2, x: 14_000, y: 3_500 }),
  currentBlock: Object.freeze({ slot: 3, x: 3_500, y: 22_500 }),
  nearNote: Object.freeze({ slot: 4, x: 3_500, y: 3_500 }),
  secondArticle: Object.freeze({ slot: 6, x: 14_000, y: 13_000 }),
  farReference: Object.freeze({ slot: 9_998, x: 3_515_000, y: 3_500_000 }),
  farNote: Object.freeze({ slot: 9_999, x: 3_500_000, y: 3_500_000 }),
})

const specialPositions = new Map(Object.values(CANVAS_SCALE_LOCATIONS).map(position => [position.slot, position]))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function geometry(slot) {
  const special = specialPositions.get(slot)
  if (special) return [special.x, special.y, 9_000, 7_500]
  if (slot === 5) return [1_800, 1_800, 12_300, 20_500]
  // 120 overlapping cards occupy a separate part of the first viewport, and
  // more visible edges are supplied than the board is allowed to mount.
  if (slot >= 7 && slot <= 126) {
    const n = slot - 7
    return [24_000 + (n % 12) * 800, 12_000 + Math.floor(n / 12) * 700, 9_000, 7_500]
  }
  const index = slot - 1
  return [51_000 + (index % 100) * 27_000, 46_000 + Math.floor(index / 100) * 27_000, 9_000, 7_500]
}

function canvasPackage() {
  const references = []
  const nodes = Array.from({ length: nodeCount }, (_, index) => {
    const slot = index + 1
    const kind = index % 5
    const box = geometry(slot)
    if (kind < 3) {
      const anchor = kind === 1 ? CANVAS_SCALE_HEADING_ANCHOR : kind === 2 ? CANVAS_SCALE_BLOCK_ANCHOR : null
      const pinned = kind === 1 || kind === 2 && Math.floor(index / 5) % 2 === 1
      const article = kind === 1 || slot === 6 || Math.floor(index / 5) % 2 === 1 ? 1 : 0
      references.push({ slot: references.length + 1, article, pinned })
      return [kind, ...box, references.length, anchor, pinned, null, []]
    }
    if (kind === 3) {
      const text = slot === 4 ? CANVAS_SCALE_NEAR_NOTE : slot === 9_999 ? CANVAS_SCALE_FAR_NOTE : `Canvas scale note ${slot}`
      return [kind, ...box, 0, null, false, text, []]
    }
    return [kind, ...box, 0, null, false, `Canvas scale group ${slot}`, [slot - 4, slot - 1]]
  })
  const edges = Array.from({ length: edgeCount }, (_, order) => {
    if (order === 0) return [1, 1, 6, order, CANVAS_SCALE_FIRST_EDGE]
    if (order === 1) return [0, 4, 3, order, 'Canvas scale near visual connection']
    if (order === edgeCount - 1) return [0, 9_999, 9_998, order, CANVAS_SCALE_FAR_EDGE]
    const kind = order % 2 === 0 ? 1 : 0
    if (order < 260) return [kind, 7 + order % 80, 7 + (order + 13) % 80, order, null]
    const from = order + 1
    return [kind, from, (from + 136) % nodeCount + 1, order, null]
  })

  // Keep the public fixture independent of local article IDs, state, and time.
  // This ASCII test fixture emits the exact field order in CanvasPortableBundle.
  const envelope = JSON.stringify({
    kind: 'authoring-canvas', version: 1, encoding: 'utf-8', newlines: 'preserve',
    sourceRevision, title, viewport: [0, 0, 1000], nodes, edges,
  }).slice(0, -1)
  const checksum = sha256(envelope)
  const bundle = Buffer.from(`${envelope},"sha256":"${checksum}"}`, 'utf8')
  return { bundle, checksum, digest: sha256(bundle), references }
}

export function createCanvasScaleCorpus({ first, second }) {
  for (const target of [first, second]) {
    assert(Number.isInteger(target?.id) && target.id > 0 && target.id <= 2_147_483_647, 'A local article ID is required')
    assert(typeof target.revision === 'bigint' && target.revision > 0n, 'An exact local article revision is required')
  }
  assert.notEqual(first.id, second.id, 'Scale source and target must be separate articles')

  const { bundle, checksum, digest, references } = canvasPackage()
  const targets = [first, second]
  const mappings = references.map(({ slot, article, pinned }) => ({
    slot,
    articleId: targets[article].id,
    pinnedRevision: pinned ? targets[article].revision : null,
  }))
  return {
    title, bundle, mappings, digest, checksum, nodeCount, edgeCount, sourceRevision: BigInt(sourceRevision),
    anchorHeading: CANVAS_SCALE_HEADING_ANCHOR, anchorBlock: CANVAS_SCALE_BLOCK_ANCHOR,
  }
}
