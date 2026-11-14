import { encodeFrame, ProtocolError } from './aeds.ts'
import { PodReader } from './binary.ts'
import { request } from './client.ts'
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
const emptyGuid = '00000000-0000-0000-0000-000000000000'

export function decodePropertyWorkspace(payload: Uint8Array): PropertyWorkspace {
  const reader = new PodReader(payload)
  const articleId = reader.i32()
  const articleRevision = reader.i64()
  const schemaRevision = reader.i64()
  const valueRevision = reader.i64()
  const nextKey = reader.text(WireLimits.PropertyKeyBytes)
  const size = reader.i32()
  if (articleId <= 0 || articleRevision <= 0n || schemaRevision < 0n || valueRevision < 0n ||
      size < 0 || size > WireLimits.PropertyPageSize)
    throw new ProtocolError('Invalid property page')
  const fields: EditableProperty[] = []
  const ids = new Set<string>()
  let previous = ''
  for (let i = 0; i < size; i++) {
    const item = {
      definitionId: reader.uuid(),
      definitionRevision: reader.i64(),
      machineKey: reader.text(WireLimits.PropertyKeyBytes),
      label: reader.text(WireLimits.PropertyLabelBytes),
      deprecated: reader.bool(),
      value: reader.bool() ? reader.text(WireLimits.PropertyValueBytes) : null,
    }
    if (item.definitionId === emptyGuid || ids.has(item.definitionId) || item.definitionRevision <= 0n ||
        !machineKey.test(item.machineKey) || item.machineKey <= previous || !item.label.trim())
      throw new ProtocolError('Invalid property item')
    ids.add(item.definitionId)
    previous = item.machineKey
    fields.push(item)
  }
  if (nextKey && (size < WireLimits.PropertyPageSize || nextKey !== previous)) throw new ProtocolError('Invalid property cursor')
  reader.finish()
  return { articleId, articleRevision, schemaRevision, valueRevision, nextKey, fields }
}

function readReceipt(payload: Uint8Array) {
  const receipt = decodePropertyCommandReceipt(payload)
  if (receipt.definitionId === emptyGuid || receipt.schemaRevision <= 0n || receipt.revision <= 0n)
    throw new ProtocolError('Invalid property receipt')
  return receipt
}

export const propertyApi = {
  workspace(input: PropertyWorkspaceRequest, signal?: AbortSignal) {
    return request(WireRoutes.PropertyWorkspace, FrameType.PropertyWorkspace, decodePropertyWorkspace,
      signal, 'POST', encodeFrame(FrameType.PropertyWorkspaceRequest, encodePropertyWorkspaceRequest(input)))
  },
  definition(input: PropertyDefinitionCommand, signal?: AbortSignal) {
    return request(WireRoutes.PropertyDefinitionCommand, FrameType.PropertyCommandReceipt, readReceipt,
      signal, 'POST', encodeFrame(FrameType.PropertyDefinitionCommand, encodePropertyDefinitionCommand(input)))
  },
  text(input: PropertyTextCommand, signal?: AbortSignal) {
    return request(WireRoutes.PropertyTextCommand, FrameType.PropertyCommandReceipt, readReceipt,
      signal, 'POST', encodeFrame(FrameType.PropertyTextCommand, encodePropertyTextCommand(input)))
  },
}
