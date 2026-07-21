import { SecurityChallengeKind } from '@/contracts/binaryApi';
import type {
    PerceptionCharacterV3VerifyPayload,
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
    if (!isUuidV7(request.envelopeId))
{
        throw new TypeError('security_challenge_envelope_id_invalid');
    }
    if ((request.kind === SecurityChallengeKind.PerceptionCharacterV3) !== Boolean(request.perceptionCharacterV3))
{
        throw new TypeError('security_challenge_verify_union_invalid');
    }

    const providerPayload = request.perceptionCharacterV3
        ? encodePerceptionCharacterV3Verify(request.perceptionCharacterV3)
        : request.providerPayloadJson;
    const bytes = encodeSlicePod([
        request.envelopeId,
        request.challengeId,
        request.action,
        request.routeKey,
        providerPayload
    ], 44, 4);
    bytes[0] = request.kind;
    return bytes;
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
    return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function encodePerceptionCharacterV3Verify(request: PerceptionCharacterV3VerifyPayload): Uint8Array
{
    if (!isUuidV7(request.challengeId) || !isUuidV7(request.envelopeId))
{
        throw new TypeError('perception_character_v3_identity_invalid');
    }
    if (request.algorithm !== 'fsu.challenge/perception-character-raster@v3' ||
      (request.representation !== 1 && request.representation !== 2) ||
      request.answer.length > 32 || !request.stateToken || textEncoder.encode(request.stateToken).byteLength > 2048)
{
        throw new TypeError('perception_character_v3_verify_invalid');
    }

    const bytes = encodeSlicePod([
        request.algorithm,
        request.answer,
        request.stateToken
    ], 156, 132);
    bytes[0] = request.representation;
    writeFixedUtf8(bytes, 4, 64, request.challengeId);
    writeFixedUtf8(bytes, 68, 64, request.envelopeId);
    return bytes;
}

function writeFixedUtf8(target: Uint8Array, offset: number, length: number, value: string): void
{
    const encoded = textEncoder.encode(value);
    if (encoded.byteLength > length) {throw new TypeError('security_challenge_fixed_utf8_overflow')};
    target.set(encoded, offset);
}

function encodeSlicePod(values: Array<string | Uint8Array>, headerBytes: number, firstSliceOffset = 0): Uint8Array
{
    const encodedValues = values.map((value) => typeof value === 'string' ? textEncoder.encode(value) : value);
    const blobBytes = encodedValues.reduce((total, value) => total + value.byteLength, 0);
    const bytes = new Uint8Array(headerBytes + 4 + blobBytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
