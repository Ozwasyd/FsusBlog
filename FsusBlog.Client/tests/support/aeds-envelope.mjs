const UTF8_DECODER = new TextDecoder()
const AEDS_MAGIC = 0x53444541
const FRAME_API_ENVELOPE = 250
const FRAME_API_ERROR = 251

function readUInt32(view, offset) {
  return view.getUint32(offset, true)
}

function readUInt16(view, offset) {
  return view.getUint16(offset, true)
}

function readInt32(view, offset) {
  return view.getInt32(offset, true)
}

export async function readJsonLikeResponse(response) {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/octet-stream')) {
    return await response.json()
  }

  const envelope = decodeBinaryEnvelope(await response.arrayBuffer())
  return envelope.bodyJson ?? null
}

export function decodeBinaryEnvelope(buffer) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 24) {
    throw new Error('aeds_frame_too_short')
  }

  const magic = readUInt32(view, 0)
  if (magic !== AEDS_MAGIC) {
    throw new Error('aeds_magic_mismatch')
  }

  const frameType = readUInt16(view, 6)
  if (frameType !== FRAME_API_ENVELOPE && frameType !== FRAME_API_ERROR) {
    throw new Error(`aeds_frame_type_unsupported:${frameType}`)
  }

  const payloadLength = readUInt32(view, 12)
  if (payloadLength !== bytes.byteLength - 24) {
    throw new Error('aeds_payload_length_mismatch')
  }

  const payload = bytes.subarray(24)
  if (payload.byteLength < 10) {
    throw new Error('aeds_envelope_payload_too_short')
  }

  const payloadView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  let offset = 0
  const statusCode = readInt32(payloadView, offset)
  offset += 4
  const contentTypeLength = readUInt16(payloadView, offset)
  offset += 2
  if (offset + contentTypeLength > payload.byteLength) {
    throw new Error('aeds_content_type_out_of_range')
  }

  const nestedContentType = UTF8_DECODER.decode(payload.subarray(offset, offset + contentTypeLength))
  offset += contentTypeLength
  const bodyLength = readInt32(payloadView, offset)
  offset += 4
  if (bodyLength < 0 || offset + bodyLength > payload.byteLength) {
    throw new Error('aeds_body_out_of_range')
  }

  const bodyBytes = payload.subarray(offset, offset + bodyLength)
  const bodyText = bodyBytes.byteLength > 0 ? UTF8_DECODER.decode(bodyBytes) : ''
  let bodyJson = null
  if (bodyText && nestedContentType.toLowerCase().includes('application/json')) {
    bodyJson = JSON.parse(bodyText)
  }

  return {
    frameType,
    statusCode,
    contentType: nestedContentType,
    bodyBytes,
    bodyText,
    bodyJson
  }
}
