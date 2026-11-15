import { encodeFrame, ProtocolError } from './aeds.ts'
import { PodReader, PodWriter } from './binary.ts'
import { request } from './client.ts'
import { decodePowChallenge, encodePowProof, solveScopedPow } from './pow.ts'
import { FrameType, WireHeaders, WireLimits, WireRoutes } from './wire.generated.ts'

export type AdminMetadataKind = 'tag' | 'category'
export type AdminTaxonomyMetadata = Readonly<{ id: number; revision: bigint; name: string; description: string; changed: boolean }>
export type AdminTaxonomyMetadataEdit = Readonly<{ id: number; expectedRevision: bigint; requestId: string; name: string; description: string }>

const encoder = new TextEncoder()
const invalidDescription = (description: string) => description.includes('\0') || Array.from(description).length > 500
const nameLimit = (kind: AdminMetadataKind) => kind === 'tag' ? WireLimits.AdminTagNameBytes : WireLimits.AdminCategoryNameBytes

export function normalizeTaxonomyMetadata(kind: AdminMetadataKind, name: string, description: string) {
  // The category store uses .NET Trim and keeps case and normalization form.
  const trim = (value: string) => kind === 'tag' ? value.trim() : value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
  const display = kind === 'tag' ? trim(name).normalize('NFC') : trim(name)
  const summary = trim(description)
  if (!display || encoder.encode(display).length > nameLimit(kind) || /\p{Cc}/u.test(display)
      || kind === 'tag' && (/[\/\\]|%2f|%5c/iu.test(display) || /^[0-9]+$/.test(display))
      || invalidDescription(summary))
    throw new ProtocolError(`Use a valid ${kind} name and a description of at most 500 characters.`)
  return { name: display, description: summary }
}

export async function taxonomyMetadataAvailable(kind: AdminMetadataKind, signal: AbortSignal): Promise<boolean> {
  const path = kind === 'tag' ? WireRoutes.AdminTagMetadataAvailability : WireRoutes.AdminCategoryMetadataAvailability
  const response = await fetch(path, { signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  return response.status === 204
}

function readMetadata(bytes: Uint8Array, kind: AdminMetadataKind, id: number): AdminTaxonomyMetadata {
  const reader = new PodReader(bytes)
  const result = { id: reader.i32(), revision: reader.i64(), name: reader.text(WireLimits.TaxonomyNameBytes),
    description: reader.text(WireLimits.TaxonomyDescriptionBytes), changed: reader.bool() }
  reader.finish()
  if (result.id <= 0 || id !== 0 && result.id !== id || result.revision < 0n || !result.name)
    throw new ProtocolError(`Invalid ${kind} metadata response.`)
  return result
}

function metadataRoutes(kind: AdminMetadataKind, id: number) {
  const tag = kind === 'tag'
  if (id === 0) {
    return {
      command: tag ? FrameType.AdminTagCreateCommand : FrameType.AdminCategoryMetadataCommand,
      receipt: tag ? FrameType.AdminTagMetadata : FrameType.AdminCategoryMetadata,
      path: tag ? WireRoutes.AdminTagCreate : WireRoutes.AdminCategoryCreate,
      pow: tag ? WireRoutes.AdminTagCreatePow : WireRoutes.AdminCategoryCreatePow,
    }
  }
  return {
    command: tag ? FrameType.AdminTagMetadataCommand : FrameType.AdminCategoryMetadataCommand,
    receipt: tag ? FrameType.AdminTagMetadata : FrameType.AdminCategoryMetadata,
    path: (tag ? WireRoutes.AdminTagMetadata : WireRoutes.AdminCategoryMetadata).replace('{id:int}', String(id)),
    pow: (tag ? WireRoutes.AdminTagMetadataPow : WireRoutes.AdminCategoryMetadataPow).replace('{id:int}', String(id)),
  }
}

export function currentTaxonomyMetadata(kind: AdminMetadataKind, id: number, signal: AbortSignal) {
  if (id <= 0) throw new ProtocolError(`Invalid ${kind} metadata ID.`)
  const routes = metadataRoutes(kind, id)
  return request(routes.path, routes.receipt, bytes => readMetadata(bytes, kind, id), signal)
}

export async function changeTaxonomyMetadata(kind: AdminMetadataKind, edit: AdminTaxonomyMetadataEdit, signal: AbortSignal) {
  const creating = edit.id === 0
  if (creating ? edit.expectedRevision !== 0n : edit.id <= 0 || edit.expectedRevision < 0n)
    throw new ProtocolError(`Invalid ${kind} metadata coordinates.`)
  const normalized = normalizeTaxonomyMetadata(kind, edit.name, edit.description)
  const routes = metadataRoutes(kind, edit.id)
  const writer = new PodWriter()
  writer.i32(edit.id)
  writer.i64(edit.expectedRevision)
  writer.uuid(edit.requestId)
  writer.text(normalized.name, nameLimit(kind))
  writer.text(normalized.description, WireLimits.TaxonomyDescriptionBytes)
  const frame = encodeFrame(routes.command, writer.finish())
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
  const challenge = await request(routes.pow, FrameType.PowChallenge, decodePowChallenge, signal, 'POST', frame,
    { [WireHeaders.PowClientNonce]: nonce })
  const proof = await solveScopedPow(challenge, nonce, signal)
  return request(routes.path, routes.receipt,
    bytes => {
      const result = readMetadata(bytes, kind, edit.id)
      if (result.name !== normalized.name || result.description !== normalized.description || creating && !result.changed ||
          (result.changed ? result.revision <= edit.expectedRevision : result.revision !== edit.expectedRevision))
        throw new ProtocolError(`The ${kind} metadata receipt does not match the request.`)
      return result
    }, signal, creating ? 'POST' : 'PUT', frame, { [WireHeaders.PowProof]: encodePowProof(challenge, proof, nonce) })
}
