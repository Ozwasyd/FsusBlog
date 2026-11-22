import { encodeFrame, ProtocolError } from './aeds.ts'
import { PodReader, PodWriter } from './binary.ts'
import { type CanvasGraphHeader, decodeCanvasGraphReceipt } from './canvas-graph.ts'
import { post } from './internal/http-methods.ts'
import { FrameType, WireHeader, WireLimits, WireRoutes } from './wire.generated.ts'

const referenceKinds = ['article-reference', 'heading-reference', 'block-reference'] as const

export type CanvasBundleReference = {
  slot: number
  kind: typeof referenceKinds[number]
  pinned: boolean
  anchor: string | null
}

export type CanvasBundlePlan = {
  digest: string
  sourceRevision: bigint
  title: string
  nodeCount: number
  edgeCount: number
  references: CanvasBundleReference[]
}

export type CanvasBundleMapping = {
  slot: number
  articleId: number
  pinnedRevision: bigint | null
}

export type CanvasBundleExecute = {
  canvasId: string
  commandId: string
  digest: string
  mappings: readonly CanvasBundleMapping[]
  bundle: Uint8Array
}

function check(valid: boolean, field: string): asserts valid {
  if (!valid) throw new ProtocolError(`Invalid Canvas bundle ${field}`)
}

function uuid(value: string): string {
  check(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) && value !== '00000000-0000-0000-0000-000000000000', 'identifier')
  return value.toLowerCase()
}

function digest(value: string): string {
  check(value.length === 64 && !/[^0-9a-f]/.test(value), 'digest')
  return value
}

function bytes(value: Uint8Array): Uint8Array {
  check(value.length > 0 && value.length <= WireLimits.CanvasBundleBytes, 'byte length')
  return value
}

export function decodeCanvasBundlePlan(payload: Uint8Array): CanvasBundlePlan {
  const input = new PodReader(payload)
  const checksum = digest(input.text(64))
  const sourceRevision = input.i64()
  const title = input.text(WireLimits.TitleBytes)
  const nodeCount = input.i32()
  const edgeCount = input.i32()
  const count = input.i32()
  check(sourceRevision > 0n && title.length > 0 && title.length <= 128 && !/^\p{White_Space}|\p{White_Space}$/u.test(title) &&
    !/\p{Cc}|<[\s\S]*>/u.test(title), 'plan metadata')
  check(nodeCount >= 0 && nodeCount <= 10_000 && edgeCount >= 0 && edgeCount <= 10_000 &&
    count >= 0 && count <= nodeCount && count <= WireLimits.CanvasBundleMaxReferences, 'plan counts')
  const references = Array.from({ length: count }, (_, index) => {
    const slot = input.i32()
    const kind = referenceKinds[input.i32()]
    const pinned = input.bool()
    const anchor = input.text(WireLimits.CanvasGraphAnchorBytes) || null
    check(slot === index + 1 && kind !== undefined &&
      (kind === 'article-reference' ? anchor === null : anchor !== null && /^[a-z]/.test(anchor) && !/[^a-z0-9-]/.test(anchor)), 'reference')
    return { slot, kind, pinned, anchor }
  })
  input.finish()
  return { digest: checksum, sourceRevision, title, nodeCount, edgeCount, references }
}

export function encodeCanvasBundleExecute(command: CanvasBundleExecute): Uint8Array {
  const output = new PodWriter()
  output.uuid(uuid(command.canvasId))
  output.uuid(uuid(command.commandId))
  output.text(digest(command.digest), 64)
  check(command.mappings.length <= WireLimits.CanvasBundleMaxReferences, 'mapping count')
  output.i32(command.mappings.length)
  for (const [index, mapping] of command.mappings.entries()) {
    check(mapping.slot === index + 1 && mapping.articleId > 0 &&
      (mapping.pinnedRevision === null || mapping.pinnedRevision > 0n), 'mapping')
    output.i32(mapping.slot)
    output.i32(mapping.articleId)
    output.i64(mapping.pinnedRevision ?? 0n)
  }
  output.bytes(bytes(command.bundle))
  return output.finish()
}

export const canvasBundle = {
  downloadHref(id: string, revision: bigint): string {
    check(revision > 0n && BigInt.asIntN(64, revision) === revision, 'export revision')
    const path = WireRoutes.CanvasBundleExport.replace('{id:guid}', uuid(id))
    return `${path}?revision=${revision}`
  },

  async plan(bundle: Uint8Array, signal?: AbortSignal): Promise<CanvasBundlePlan> {
    const body = encodeFrame(FrameType.CanvasBundleIntake, bytes(bundle))
    const hash = await crypto.subtle.digest('SHA-256', body.subarray(WireHeader.HeaderSize))
    const expected = Array.from(new Uint8Array(hash), part => part.toString(16).padStart(2, '0')).join('')
    return post(WireRoutes.CanvasBundlePlan, FrameType.CanvasBundlePlan, payload => {
      const plan = decodeCanvasBundlePlan(payload)
      check(plan.digest === expected, 'plan digest')
      return plan
    }, signal, body)
  },

  import(command: CanvasBundleExecute, signal?: AbortSignal): Promise<CanvasGraphHeader> {
    const canvasId = uuid(command.canvasId)
    const body = encodeFrame(FrameType.CanvasBundleExecute, encodeCanvasBundleExecute(command))
    return post(WireRoutes.CanvasBundleExecute, FrameType.CanvasGraphReceipt, payload => {
      const receipt = decodeCanvasGraphReceipt(payload)
      check(receipt.id === canvasId && receipt.revision === 1n && !receipt.deleted, 'import receipt')
      return receipt
    }, signal, body)
  },
}
