import { AppErrorCode, createAppError } from '@/utils/appError';
import {
    SecurityChallengeKind,
    PerceptionCharacterV3Representation,
    type PerceptionCharacterV3IssuePayload,
    type SecurityChallengeAssignment,
    type SecurityChallengeDecision,
    type SecurityChallengeIssueResponse,
  type SecurityChallengeProviderPayload,
  type SecurityChallengeVerifyResponse
} from '@/contracts/binaryApi';
import { readByte, readFixedUtf8, readInt32, readInt64Number, readSliceRef, readSliceText } from '@/codecs/binary/reader';

const decoder = new TextDecoder('utf-8', { fatal: true });

const SECURITY_CHALLENGE_ISSUE_RESPONSE_POD_SIZE = 148;
const SECURITY_CHALLENGE_ASSIGNMENT_POD_SIZE = 664;
const SECURITY_CHALLENGE_PROVIDER_PAYLOAD_POD_SIZE = 72;
const SECURITY_CHALLENGE_VERIFY_RESPONSE_POD_SIZE = 968;
const PERCEPTION_CHARACTER_V3_ISSUE_POD_SIZE = 256;
const PERCEPTION_CHARACTER_V3_ALGORITHM = 'fsu.challenge/perception-character-raster@v3';
const PERCEPTION_CHARACTER_V3_VISUAL_BYTES = 512 * 192;
const PERCEPTION_CHARACTER_V3_MAX_AUDIO_BYTES = 256 * 1024;
const PERCEPTION_CHARACTER_V3_MAX_STATE_BYTES = 2048;
const PERCEPTION_CHARACTER_V3_MAX_ENCODED_BYTES =
    PERCEPTION_CHARACTER_V3_ISSUE_POD_SIZE + 4 + 128 + 64 + PERCEPTION_CHARACTER_V3_MAX_AUDIO_BYTES + PERCEPTION_CHARACTER_V3_MAX_STATE_BYTES;

export function mapSecurityJsonFromPayload<T = unknown>(payload: Uint8Array): T
{
    try
{
    return JSON.parse(decoder.decode(payload)) as T;
  } catch {
    throw createAppError(AppErrorCode.ProtocolFailure, 'security_json_payload_invalid');
  }
}

export function mapSecurityChallengeIssueResponseFromPayload(payload: Uint8Array): SecurityChallengeIssueResponse {
  if (payload.byteLength < SECURITY_CHALLENGE_ISSUE_RESPONSE_POD_SIZE) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'security_challenge_issue_payload_short');
  }

  const assignmentCount = readByte(payload, 1);
  const providerPayloadCount = readUint16(payload, 2);
  if (assignmentCount > 8 || providerPayloadCount > 8) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'security_challenge_issue_count_invalid');
  }

  const assignmentsOffset = SECURITY_CHALLENGE_ISSUE_RESPONSE_POD_SIZE;
  const providerPodsOffset = assignmentsOffset + assignmentCount * SECURITY_CHALLENGE_ASSIGNMENT_POD_SIZE;
  const blobOffset = providerPodsOffset + providerPayloadCount * SECURITY_CHALLENGE_PROVIDER_PAYLOAD_POD_SIZE;
  if (payload.byteLength < blobOffset + 4) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'security_challenge_issue_payload_truncated');
  }

  const assignments: SecurityChallengeAssignment[] = [];
  for (let index = 0; index < assignmentCount; index += 1) {
    assignments.push(readSecurityChallengeAssignment(payload, assignmentsOffset + index * SECURITY_CHALLENGE_ASSIGNMENT_POD_SIZE));
  }

    const blob = readBinaryPodBlob(payload, blobOffset, 'security_challenge_issue_payload_truncated');
    const providerPayloads: SecurityChallengeProviderPayload[] = [];
    const assignmentsById = new Map(assignments.map((assignment) => [assignment.challengeId, assignment]));
    for (let index = 0; index < providerPayloadCount; index += 1)
{
        const offset = providerPodsOffset + index * SECURITY_CHALLENGE_PROVIDER_PAYLOAD_POD_SIZE;
        const challengeId = readFixedUtf8(payload, offset, 64);
        const assignment = assignmentsById.get(challengeId);
        if (!assignment)
{
            throw createAppError(AppErrorCode.ProtocolFailure, 'security_challenge_provider_payload_challenge_mismatch');
        }
        const payloadBytes = readSliceBytesStrict(
            blob,
            readSliceRef(payload, offset + 64),
            'security_challenge_provider_payload_slice_invalid',
      assignment.kind === SecurityChallengeKind.PerceptionCharacterV3 ? PERCEPTION_CHARACTER_V3_MAX_ENCODED_BYTES : Number.MAX_SAFE_INTEGER
        );
        providerPayloads.push(assignment.kind === SecurityChallengeKind.PerceptionCharacterV3
            ? {
          challengeId,
          payload: {},
          perceptionCharacterV3: mapPerceptionCharacterV3IssuePayload(payloadBytes, {
            challengeId,
            envelopeId: readFixedUtf8(payload, 20, 64),
            policyVersion: readFixedUtf8(payload, 84, 64)
          })
        }
            : {
          challengeId,
          payload: parseProviderPayloadJson(decodeUtf8Strict(payloadBytes, 'security_challenge_provider_payload_invalid'))
        });
    }
    const assignmentIds = new Set(assignments.map((assignment) => assignment.challengeId));
    const providerPayloadIds = new Set<string>();
  for (const providerPayload of providerPayloads) {
    if (!assignmentIds.has(providerPayload.challengeId) || providerPayloadIds.has(providerPayload.challengeId)) {
      throw createAppError(AppErrorCode.ProtocolFailure, 'security_challenge_provider_payload_challenge_mismatch');
    }
    providerPayloadIds.add(providerPayload.challengeId);
  }

  return {
    decision: mapSecurityChallengeDecision(readByte(payload, 0)),
    riskScore: readInt32(payload, 4),
    effectiveRiskScore: readInt32(payload, 8),
    escalationLevel: readInt32(payload, 12),
    retryAfterMs: readInt32(payload, 16),
    policyVersion: readFixedUtf8(payload, 84, 64),
    envelope: assignmentCount > 0
      ? {
          envelopeId: readFixedUtf8(payload, 20, 64),
          policyVersion: readFixedUtf8(payload, 84, 64),
          assignments
        }
      : null,
    providerPayloads
    };
}

export function mapPerceptionCharacterV3IssuePayload(
    payload: Uint8Array,
    expected?: { challengeId: string; envelopeId: string; policyVersion: string; }
): PerceptionCharacterV3IssuePayload
{
    if (payload.byteLength < PERCEPTION_CHARACTER_V3_ISSUE_POD_SIZE + 4)
{
        throw protocolFailure('perception_character_v3_issue_payload_short');
    }

    const representation = readByte(payload, 0);
    const attemptBudget = readByte(payload, 1);
    const physicalWidth = readUint16(payload, 2);
    const physicalHeight = readUint16(payload, 4);
    const displayWidth = readUint16(payload, 6);
    const displayHeight = readUint16(payload, 8);
    const reserved = readUint16(payload, 10);
    const mediaByteCount = readInt32(payload, 12);
    const issuedAtUnixMs = readInt64Number(payload, 16);
    const expiresAtUnixMs = readInt64Number(payload, 24);
    const challengeId = readFixedUtf8(payload, 32, 64);
    const envelopeId = readFixedUtf8(payload, 96, 64);
    const policyVersion = readFixedUtf8(payload, 160, 64);

    if ((representation !== PerceptionCharacterV3Representation.Visual && representation !== PerceptionCharacterV3Representation.Audio) ||
      attemptBudget !== 2 || reserved !== 0 || mediaByteCount <= 0 ||
      !Number.isSafeInteger(issuedAtUnixMs) || !Number.isSafeInteger(expiresAtUnixMs) || expiresAtUnixMs <= issuedAtUnixMs ||
      !isUuidV7(challengeId) || !isUuidV7(envelopeId) || !policyVersion.trim())
{
        throw protocolFailure('perception_character_v3_issue_contract_invalid');
    }
    if (expected && (challengeId !== expected.challengeId || envelopeId !== expected.envelopeId || policyVersion !== expected.policyVersion))
{
        throw protocolFailure('perception_character_v3_issue_identity_mismatch');
    }

    const blob = readBinaryPodBlob(payload, PERCEPTION_CHARACTER_V3_ISSUE_POD_SIZE, 'perception_character_v3_issue_payload_truncated');
    const algorithmBytes = readSliceBytesStrict(blob, readSliceRef(payload, 224), 'perception_character_v3_algorithm_slice_invalid', 128);
    const mediaTypeBytes = readSliceBytesStrict(blob, readSliceRef(payload, 232), 'perception_character_v3_media_type_slice_invalid', 64);
    const mediaRef = readSliceRef(payload, 240);
    const mediaMaximum = representation === PerceptionCharacterV3Representation.Visual
        ? PERCEPTION_CHARACTER_V3_VISUAL_BYTES
        : PERCEPTION_CHARACTER_V3_MAX_AUDIO_BYTES;
    if (mediaRef.length !== mediaByteCount || mediaRef.length > mediaMaximum)
{
        throw protocolFailure('perception_character_v3_media_size_invalid');
    }
    const mediaBytes = readSliceBytesStrict(blob, mediaRef, 'perception_character_v3_media_slice_invalid', mediaMaximum);
    const stateBytes = readSliceBytesStrict(blob, readSliceRef(payload, 248), 'perception_character_v3_state_slice_invalid', PERCEPTION_CHARACTER_V3_MAX_STATE_BYTES);
    const algorithm = decodeUtf8Strict(algorithmBytes, 'perception_character_v3_algorithm_invalid');
    const mediaType = decodeUtf8Strict(mediaTypeBytes, 'perception_character_v3_media_type_invalid');
    const stateToken = decodeUtf8Strict(stateBytes, 'perception_character_v3_state_invalid');

    if (algorithm !== PERCEPTION_CHARACTER_V3_ALGORITHM || !stateToken ||
      (representation === PerceptionCharacterV3Representation.Visual &&
        (mediaType !== 'application/x-fsus-gray8' || mediaBytes.byteLength !== PERCEPTION_CHARACTER_V3_VISUAL_BYTES ||
          physicalWidth !== 512 || physicalHeight !== 192 || displayWidth !== 320 || displayHeight !== 120)) ||
      (representation === PerceptionCharacterV3Representation.Audio &&
        (mediaType !== 'audio/wav' || physicalWidth !== 0 || physicalHeight !== 0 || displayWidth !== 0 || displayHeight !== 0)))
{
        throw protocolFailure('perception_character_v3_issue_shape_invalid');
    }
    const typedMediaType = representation === PerceptionCharacterV3Representation.Visual
        ? 'application/x-fsus-gray8' as const
        : 'audio/wav' as const;

    return {
        algorithm,
        challengeId,
        envelopeId,
        representation,
        mediaType: typedMediaType,
        mediaBytes,
        physicalWidth,
        physicalHeight,
        displayWidth,
        displayHeight,
        attemptBudget: 2,
        policyVersion,
        issuedAtUnixMs,
        expiresAtUnixMs,
        stateToken
    };
}

export function mapSecurityChallengeVerifyResponseFromPayload(payload: Uint8Array): SecurityChallengeVerifyResponse
{
    if (payload.byteLength < SECURITY_CHALLENGE_VERIFY_RESPONSE_POD_SIZE)
{
        throw createAppError(AppErrorCode.ProtocolFailure, 'security_challenge_verify_payload_short');
  }

  const verifiedRaw = readByte(payload, 0);
  const envelopeCompletedRaw = readByte(payload, 2);
  if (verifiedRaw > 1 || envelopeCompletedRaw > 1) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'security_challenge_verify_boolean_invalid');
  }

  const blob = readBinaryPodBlob(payload, SECURITY_CHALLENGE_VERIFY_RESPONSE_POD_SIZE, 'security_challenge_verify_payload_truncated');
  const hasNextAssignment = readByte(payload, 3);
  if (hasNextAssignment > 1) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'security_challenge_verify_boolean_invalid');
  }
  const nextAssignment = hasNextAssignment === 1 ? readSecurityChallengeAssignment(payload, 232) : null;
  let nextProviderPayload: SecurityChallengeProviderPayload | null = null;
  if (nextAssignment) {
    const challengeId = readFixedUtf8(payload, 896, 64);
    if (challengeId) {
      if (challengeId !== nextAssignment.challengeId) {
        throw createAppError(AppErrorCode.ProtocolFailure, 'security_challenge_provider_payload_challenge_mismatch');
      }
      const payloadBytes = readSliceBytesStrict(
        blob,
        readSliceRef(payload, 960),
        'security_challenge_provider_payload_slice_invalid',
        nextAssignment.kind === SecurityChallengeKind.PerceptionCharacterV3 ? PERCEPTION_CHARACTER_V3_MAX_ENCODED_BYTES : Number.MAX_SAFE_INTEGER);
      nextProviderPayload = nextAssignment.kind === SecurityChallengeKind.PerceptionCharacterV3
        ? {
            challengeId,
            payload: {},
            perceptionCharacterV3: mapPerceptionCharacterV3IssuePayload(payloadBytes, {
              challengeId,
              envelopeId: readFixedUtf8(payload, 16, 64),
              policyVersion: readFixedUtf8(payload, 144, 64)
            })
          }
        : { challengeId, payload: parseProviderPayloadJson(decodeUtf8Strict(payloadBytes, 'security_challenge_provider_payload_invalid')) };
    }
  }
  const response: SecurityChallengeVerifyResponse = {
    verified: verifiedRaw === 1,
    kind: mapSecurityChallengeKind(readByte(payload, 1)),
    envelopeCompleted: envelopeCompletedRaw === 1,
    retryAfterMs: readInt32(payload, 4),
    completedCount: readInt32(payload, 8),
    memberCount: readInt32(payload, 12),
    envelopeId: readFixedUtf8(payload, 16, 64),
    challengeId: readFixedUtf8(payload, 80, 64),
    policyVersion: readFixedUtf8(payload, 144, 64),
    proofToken: readSliceText(blob, readSliceRef(payload, 208)),
    reason: readSliceText(blob, readSliceRef(payload, 216)),
    expiresAtUnixMs: readInt64Number(payload, 224),
    nextAssignment,
    nextProviderPayload
  };

  if (!isValidSecurityChallengeVerifyResponse(response)) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'security_challenge_verify_contract_invalid');
  }

  return response;
}

function isValidSecurityChallengeVerifyResponse(response: SecurityChallengeVerifyResponse): boolean {
  if (!isUuidV7(response.envelopeId) || !isCompatibleChallengeId(response.kind, response.challengeId)) {
    return false;
  }
  if (response.kind === SecurityChallengeKind.Unknown || !response.policyVersion.trim() || !response.reason.trim()) {
    return false;
  }
  if (!Number.isInteger(response.completedCount) || !Number.isInteger(response.memberCount) ||
      response.memberCount <= 0 || response.memberCount > 8 ||
      response.completedCount < 0 || response.completedCount > response.memberCount ||
      response.retryAfterMs < 0) {
    return false;
  }

  const expectedCompleted = response.verified && response.completedCount === response.memberCount;
  return response.envelopeCompleted === expectedCompleted &&
    (response.envelopeCompleted ? response.proofToken.trim().length > 0 : response.proofToken.length === 0) &&
    (!response.envelopeCompleted || !response.nextAssignment) &&
    (!response.nextProviderPayload || response.nextProviderPayload.challengeId === response.nextAssignment?.challengeId);
}

function isCompatibleChallengeId(_kind: SecurityChallengeKind, value: string): boolean
{
    return isUuidVersion(value, '7');
}

function isUuidV7(value: string): boolean {
    return isUuidVersion(value, '7');
}

function isUuidVersion(value: string, version: '7'): boolean
{
    return new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-${version}[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, 'iu').test(value);
}

function readBinaryPodBlob(payload: Uint8Array, offset: number, errorCode: string): Uint8Array {
  if (offset + 4 > payload.byteLength) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }

  const length = readInt32(payload, offset);
  const blobStart = offset + 4;
  const blobEnd = blobStart + length;
  if (length < 0 || blobEnd > payload.byteLength || blobEnd !== payload.byteLength) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }

    return payload.subarray(blobStart, blobEnd);
}

function readSliceBytesStrict(blob: Uint8Array, slice: { offset: number; length: number; }, errorCode: string, maximum = Number.MAX_SAFE_INTEGER): Uint8Array
{
    if (!Number.isInteger(slice.offset) || !Number.isInteger(slice.length) || slice.offset < 0 || slice.length < 0 ||
      slice.length > maximum || slice.offset > blob.byteLength - slice.length)
{
        throw protocolFailure(errorCode);
    }
    return blob.subarray(slice.offset, slice.offset + slice.length);
}

function decodeUtf8Strict(bytes: Uint8Array, errorCode: string): string
{
    try
{
        return decoder.decode(bytes);
    }
 catch
{
        throw protocolFailure(errorCode);
    }
}

function protocolFailure(errorCode: string): ReturnType<typeof createAppError>
{
    return createAppError(AppErrorCode.ProtocolFailure, errorCode);
}

function readUint16(bytes: Uint8Array, offset: number): number
{
    return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readSecurityChallengeAssignment(payload: Uint8Array, offset: number): SecurityChallengeAssignment {
  return {
    kind: mapSecurityChallengeKind(readByte(payload, offset)),
    escalationLevel: readInt32(payload, offset + 4),
    issuedAtUnixMs: readInt64Number(payload, offset + 8),
    expiresAtUnixMs: readInt64Number(payload, offset + 16),
    challengeId: readFixedUtf8(payload, offset + 24, 64),
    traceparent: readFixedUtf8(payload, offset + 88, 128),
    tenantId: readFixedUtf8(payload, offset + 216, 64),
    action: readFixedUtf8(payload, offset + 280, 64),
    routeKey: readFixedUtf8(payload, offset + 344, 128),
    subjectHash: readFixedUtf8(payload, offset + 472, 64),
    clientIpHash: readFixedUtf8(payload, offset + 536, 64),
    deviceFpHash: readFixedUtf8(payload, offset + 600, 64)
  };
}

function parseProviderPayloadJson(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw createAppError(AppErrorCode.ProtocolFailure, 'security_challenge_provider_payload_not_object');
    }
    const result: Record<string, string> = {};
    for (const [key, raw] of Object.entries(parsed)) {
      result[key] = typeof raw === 'string' ? raw : String(raw);
    }
    return result;
  } catch {
    throw createAppError(AppErrorCode.ProtocolFailure, 'security_challenge_provider_payload_invalid');
  }
}

function mapSecurityChallengeKind(value: number): SecurityChallengeKind {
  return Object.values(SecurityChallengeKind).includes(value as SecurityChallengeKind)
    ? value as SecurityChallengeKind
    : SecurityChallengeKind.Unknown;
}

function mapSecurityChallengeDecision(value: number): SecurityChallengeDecision {
  switch (value) {
    case 1:
      return 'allow';
    case 2:
      return 'challenge';
    case 3:
      return 'stepUp';
    case 4:
      return 'queueForModeration';
    case 5:
      return 'throttle';
    case 6:
      return 'block';
    default:
      return 'unknown';
  }
}
