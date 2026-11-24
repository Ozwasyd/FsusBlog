import { encodeFrame, ProtocolError } from './aeds.ts'
import { decodePod, isNonZeroUuid, toHex, writePod } from './binary.ts'
import { type CanvasGraphHeader, decodeCanvasGraphReceipt } from './canvas-graph.ts'
import { post } from './internal/http.ts'
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
  check(isNonZeroUuid(value), 'identifier')
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
  return decodePod(payload, input => {
    const checksum = digest(input.text(64)), sourceRevision = input.i64(), title = input.text(WireLimits.TitleBytes)
    const nodeCount = input.i32(), edgeCount = input.i32(), count = input.i32()
    check(sourceRevision > 0n && title.length > 0 && title.length <= 128 && !/^\p{White_Space}|\p{White_Space}$/u.test(title) &&
      !/\p{Cc}|<[\s\S]*>/u.test(title), 'plan metadata')
    check(nodeCount >= 0 && nodeCount <= 10_000 && edgeCount >= 0 && edgeCount <= 10_000 &&
      count >= 0 && count <= nodeCount && count <= WireLimits.CanvasBundleMaxReferences, 'plan counts')
    const references = Array.from({ length: count }, (_, index) => {
      const slot = input.i32(), kind = referenceKinds[input.i32()], pinned = input.bool()
      const anchor = input.text(WireLimits.CanvasGraphAnchorBytes) || null
      check(slot === index + 1 && kind !== undefined &&
        (kind === 'article-reference' ? anchor === null : anchor !== null && /^[a-z]/.test(anchor) && !/[^a-z0-9-]/.test(anchor)), 'reference')
      return { slot, kind, pinned, anchor }
    })
    return { digest: checksum, sourceRevision, title, nodeCount, edgeCount, references }
  })
}

export function encodeCanvasBundleExecute(command: CanvasBundleExecute): Uint8Array {
  return writePod(output => {
    check(command.mappings.length <= WireLimits.CanvasBundleMaxReferences, 'mapping count')
    output.uuid(uuid(command.canvasId)).uuid(uuid(command.commandId)).text(digest(command.digest), 64).i32(command.mappings.length)
    for (const [index, mapping] of command.mappings.entries()) {
      check(mapping.slot === index + 1 && mapping.articleId > 0 &&
        (mapping.pinnedRevision === null || mapping.pinnedRevision > 0n), 'mapping')
      output.i32(mapping.slot).i32(mapping.articleId).i64(mapping.pinnedRevision ?? 0n)
    }
    output.bytes(bytes(command.bundle))
  })
}

export const canvasBundle = {
  downloadHref(id: string, revision: bigint): string {
    check(revision > 0n && BigInt.asIntN(64, revision) === revision, 'export revision')
    return `${WireRoutes.CanvasBundleExport.replace('{id:guid}', uuid(id))}?revision=${revision}`
  },

  async plan(bundle: Uint8Array, signal?: AbortSignal): Promise<CanvasBundlePlan> {
    const body = encodeFrame(FrameType.CanvasBundleIntake, bytes(bundle))
    const expected = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', body.subarray(WireHeader.HeaderSize))))
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
