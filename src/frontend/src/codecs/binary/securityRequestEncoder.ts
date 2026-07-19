import type {
  SecurityChallengeIssuePodRequest,
  SecurityChallengeVerifyPodRequest
} from '@/contracts/binaryApi'

const textEncoder = new TextEncoder()

export function encodeSecurityChallengeIssueRequest(request: SecurityChallengeIssuePodRequest): Uint8Array {
  return encodeSlicePod([
    request.action,
    request.routeKey,
    request.deviceFingerprint,
    request.attributesJson
  ], 32)
}

export function encodeSecurityChallengeVerifyRequest(request: SecurityChallengeVerifyPodRequest): Uint8Array {
  const bytes = encodeSlicePod([
    request.challengeId,
    request.action,
    request.routeKey,
    request.providerPayloadJson
  ], 36, 4)
  bytes[0] = request.kind
  return bytes
}

function encodeSlicePod(values: string[], headerBytes: number, firstSliceOffset = 0): Uint8Array {
  const encodedValues = values.map((value) => textEncoder.encode(value ?? ''))
  const blobBytes = encodedValues.reduce((total, value) => total + value.byteLength, 0)
  const bytes = new Uint8Array(headerBytes + 4 + blobBytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let blobOffset = 0
  for (let index = 0; index < encodedValues.length; index += 1) {
    const sliceOffset = firstSliceOffset + index * 8
    view.setInt32(sliceOffset, blobOffset, true)
    view.setInt32(sliceOffset + 4, encodedValues[index].byteLength, true)
    bytes.set(encodedValues[index], headerBytes + 4 + blobOffset)
    blobOffset += encodedValues[index].byteLength
  }
  view.setInt32(headerBytes, blobBytes, true)
  return bytes
}
