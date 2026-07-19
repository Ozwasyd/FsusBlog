import type {
  SecurityChallengeCancelPodRequest,
  SecurityChallengeIssuePodRequest,
  SecurityChallengeVerifyPodRequest
} from '@/contracts/binaryApi'

const textEncoder = new TextEncoder()

export function encodeSecurityChallengeIssueRequest(request: SecurityChallengeIssuePodRequest): Uint8Array {
  return encodeSlicePod([
    request.action,
    request.routeKey,
    request.deviceFingerprint,
    request.attributesJson,
    request.capabilityManifestVersion
  ], 40)
}

export function encodeSecurityChallengeVerifyRequest(request: SecurityChallengeVerifyPodRequest): Uint8Array {
  if (!isUuidV7(request.envelopeId)) {
    throw new TypeError('security_challenge_envelope_id_invalid')
  }

  const bytes = encodeSlicePod([
    request.envelopeId,
    request.challengeId,
    request.action,
    request.routeKey,
    request.providerPayloadJson
  ], 44, 4)
  bytes[0] = request.kind
  return bytes
}

export function encodeSecurityChallengeCancelRequest(request: SecurityChallengeCancelPodRequest): Uint8Array {
  if (!isUuidV7(request.envelopeId)) {
    throw new TypeError('security_challenge_envelope_id_invalid')
  }

  return encodeSlicePod([
    request.envelopeId,
    request.action,
    request.routeKey,
    request.deviceFingerprint,
    request.policyVersion
  ], 40)
}

function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
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
