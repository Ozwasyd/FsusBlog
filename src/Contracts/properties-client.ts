import { encodeFrame, ProtocolError } from './aeds.ts'
import { decodePod, ZERO_UUID } from './binary.ts'
import { post } from './internal/http.ts'
import {
  decodePropertyCommandReceipt, encodePropertyDefinitionCommand, encodePropertyTextCommand,
  encodePropertyWorkspaceRequest, FrameType, WireLimits, WireRoutes,
  type PropertyDefinitionCommand, type PropertyTextCommand, type PropertyWorkspaceRequest,
} from './wire.generated.ts'

export type { PropertyDefinitionCommand, PropertyTextCommand, PropertyWorkspaceRequest } from './wire.generated.ts'

export type EditableProperty = {
  definitionId: string
  definitionRevision: bigint
  machineKey: string
  label: string
  deprecated: boolean
  value: string | null
}

export type PropertyWorkspace = {
  articleId: number
  articleRevision: bigint
  schemaRevision: bigint
  valueRevision: bigint
  nextKey: string
  fields: EditableProperty[]
}

const machineKey = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/

export function decodePropertyWorkspace(payload: Uint8Array): PropertyWorkspace {
  return decodePod(payload, reader => {
    const articleId = reader.i32(), articleRevision = reader.i64(), schemaRevision = reader.i64(), valueRevision = reader.i64()
    const nextKey = reader.text(WireLimits.PropertyKeyBytes), size = reader.i32()
    if (articleId <= 0 || articleRevision <= 0n || schemaRevision < 0n || valueRevision < 0n ||
        size < 0 || size > WireLimits.PropertyPageSize)
      throw new ProtocolError('Invalid property page')
    const fields: EditableProperty[] = [], ids = new Set<string>()
    let previous = ''
    for (let i = 0; i < size; i++) {
      const item = {
        definitionId: reader.uuid(), definitionRevision: reader.i64(),
        machineKey: reader.text(WireLimits.PropertyKeyBytes), label: reader.text(WireLimits.PropertyLabelBytes),
        deprecated: reader.bool(), value: reader.optional(r => r.text(WireLimits.PropertyValueBytes)),
      }
      if (item.definitionId === ZERO_UUID || ids.has(item.definitionId) || item.definitionRevision <= 0n ||
          !machineKey.test(item.machineKey) || item.machineKey <= previous || !item.label.trim())
        throw new ProtocolError('Invalid property item')
      ids.add(item.definitionId)
      previous = item.machineKey
      fields.push(item)
    }
    if (nextKey && (size < WireLimits.PropertyPageSize || nextKey !== previous)) throw new ProtocolError('Invalid property cursor')
    return { articleId, articleRevision, schemaRevision, valueRevision, nextKey, fields }
  })
}

function readReceipt(payload: Uint8Array) {
  const receipt = decodePropertyCommandReceipt(payload)
  if (receipt.definitionId === ZERO_UUID || receipt.schemaRevision <= 0n || receipt.revision <= 0n)
    throw new ProtocolError('Invalid property receipt')
  return receipt
}

export const propertyApi = {
  workspace(input: PropertyWorkspaceRequest, signal?: AbortSignal) {
    return post(WireRoutes.PropertyWorkspace, FrameType.PropertyWorkspace, decodePropertyWorkspace,
      signal, encodeFrame(FrameType.PropertyWorkspaceRequest, encodePropertyWorkspaceRequest(input)))
  },
  definition(input: PropertyDefinitionCommand, signal?: AbortSignal) {
    return post(WireRoutes.PropertyDefinitionCommand, FrameType.PropertyCommandReceipt, readReceipt,
      signal, encodeFrame(FrameType.PropertyDefinitionCommand, encodePropertyDefinitionCommand(input)))
  },
  text(input: PropertyTextCommand, signal?: AbortSignal) {
    return post(WireRoutes.PropertyTextCommand, FrameType.PropertyCommandReceipt, readReceipt,
      signal, encodeFrame(FrameType.PropertyTextCommand, encodePropertyTextCommand(input)))
  },
}
