import { encodeFrame, ProtocolError } from './aeds.ts'
import { PodReader, PodWriter } from './binary.ts'
import { request } from './client.ts'
import { decodePowChallenge, encodePowProof, solveScopedPow } from './pow.ts'
import { FrameType, WireHeaders, WireLimits, WireRoutes } from './wire.generated.ts'

export type AdminTagMetadata = Readonly<{ id: number; revision: bigint; name: string; description: string; changed: boolean }>
export type AdminTagMetadataEdit = Readonly<{ id: number; expectedRevision: bigint; requestId: string; name: string; description: string }>

const encoder = new TextEncoder()
export function normalizeTagMetadata(name: string, description: string) {
  const display = name.trim().normalize('NFC'), summary = description.trim()
  if (!display || encoder.encode(display).length > WireLimits.AdminTagNameBytes || /[\p{Cc}/\\]|%2f|%5c/iu.test(display) ||
      /^[0-9]+$/.test(display) || summary.includes('\0') || Array.from(summary).length > 500)
    throw new ProtocolError('Use a valid tag name and a description of at most 500 characters.')
  return { name: display, description: summary }
}

export async function tagMetadataAvailable(signal: AbortSignal): Promise<boolean> {
  const response = await fetch(WireRoutes.AdminTagMetadataAvailability, { signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  return response.status === 204
}

function readMetadata(bytes: Uint8Array, id: number): AdminTagMetadata {
  const reader = new PodReader(bytes)
  const result = { id: reader.i32(), revision: reader.i64(), name: reader.text(WireLimits.TaxonomyNameBytes),
    description: reader.text(WireLimits.TaxonomyDescriptionBytes), changed: reader.bool() }
  reader.finish()
  if (result.id !== id || id <= 0 || result.revision < 0n || !result.name) throw new ProtocolError('Invalid tag metadata response.')
  return result
}

export function currentTagMetadata(id: number, signal: AbortSignal) {
  return request(WireRoutes.AdminTagMetadata.replace('{id:int}', String(id)), FrameType.AdminTagMetadata,
    bytes => readMetadata(bytes, id), signal)
}

export async function changeTagMetadata(edit: AdminTagMetadataEdit, signal: AbortSignal) {
  const normalized = normalizeTagMetadata(edit.name, edit.description)
  const writer = new PodWriter()
  writer.i32(edit.id)
  writer.i64(edit.expectedRevision)
  writer.uuid(edit.requestId)
  writer.text(normalized.name, WireLimits.AdminTagNameBytes)
  writer.text(normalized.description, WireLimits.TaxonomyDescriptionBytes)
  const frame = encodeFrame(FrameType.AdminTagMetadataCommand, writer.finish())
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
  const path = WireRoutes.AdminTagMetadataPow.replace('{id:int}', String(edit.id))
  const challenge = await request(path, FrameType.PowChallenge, decodePowChallenge, signal, 'POST', frame,
    { [WireHeaders.PowClientNonce]: nonce })
  const proof = await solveScopedPow(challenge, nonce, signal)
  return request(WireRoutes.AdminTagMetadata.replace('{id:int}', String(edit.id)), FrameType.AdminTagMetadata,
    bytes => {
      const result = readMetadata(bytes, edit.id)
      if (result.name !== normalized.name || result.description !== normalized.description ||
          (result.changed ? result.revision <= edit.expectedRevision : result.revision !== edit.expectedRevision))
        throw new ProtocolError('The tag metadata receipt does not match the request.')
      return result
    }, signal, 'PUT', frame, { [WireHeaders.PowProof]: encodePowProof(challenge, proof, nonce) })
}
