import { AppErrorCode, createAppError } from '@/utils/appError';
import { readByte, readFixedUtf8, readInt32, readInt64Number, readSliceRef, readSliceText } from './reader';

const textEncoder = new TextEncoder();

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const SecurityChallengeKind = {
  Unknown: 0,
  Sha256PowV1: 1,
  Argon2IdPoSpaceV1: 2,
  CaptchaV1: 3,
  HumanReadProofV1: 4,
  PasskeyStepUpV1: 5,
  AdminPasskeyStepUpV1: 6,
  RecoveryKeyProofV1: 7,
  AnonymousCredentialProofV1: 8,
  ZkAnonymousCommentProofV1: 9,
  PerceptionCharacterV2: 10,
  PerceptionLocalizationV2: 11,
  PerceptionMicroInteractionV2: 12,
  PerceptionTextTaskV2: 13
} as const;

export type SecurityChallengeKind = typeof SecurityChallengeKind[keyof typeof SecurityChallengeKind];

export type SecurityChallengeDecision = 'unknown' | 'allow' | 'challenge' | 'stepUp' | 'queueForModeration' | 'throttle' | 'block';

export interface SecurityChallengeAssignment {
  challengeId: string;
  traceparent: string;
  tenantId: string;
  kind: SecurityChallengeKind;
  escalationLevel: number;
  action: string;
  routeKey: string;
  subjectHash: string;
  clientIpHash: string;
  deviceFpHash: string;
  issuedAtUnixMs: number;
  expiresAtUnixMs: number;
}

export interface SecurityChallengeEnvelope {
  envelopeId: string;
  policyVersion: string;
  assignments: SecurityChallengeAssignment[];
}

export interface SecurityChallengeProviderPayload {
  challengeId: string;
  payload: Record<string, string>;
}

export interface SecurityChallengeIssueResponse {
  decision: SecurityChallengeDecision;
  riskScore: number;
  effectiveRiskScore: number;
  escalationLevel: number;
  policyVersion: string;
  retryAfterMs: number;
  envelope: SecurityChallengeEnvelope | null;
  providerPayloads: SecurityChallengeProviderPayload[];
}

export interface SecurityChallengeVerifyResponse {
  verified: boolean;
  challengeId: string;
  kind: SecurityChallengeKind;
  policyVersion: string;
  proofToken: string;
  reason: string;
  retryAfterMs: number;
}

export interface SecurityChallengeIssuePodRequest {
  action: string;
  routeKey: string;
  deviceFingerprint: string;
  attributesJson: string;
}

export interface SecurityChallengeVerifyPodRequest {
  challengeId: string;
  kind: SecurityChallengeKind;
  action: string;
  routeKey: string;
  providerPayloadJson: string;
}

const SECURITY_CHALLENGE_ISSUE_RESPONSE_POD_SIZE = 148;
const SECURITY_CHALLENGE_ASSIGNMENT_POD_SIZE = 664;
const SECURITY_CHALLENGE_PROVIDER_PAYLOAD_POD_SIZE = 72;
const SECURITY_CHALLENGE_VERIFY_RESPONSE_POD_SIZE = 152;

export function encodeSecurityJsonRequest(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value ?? {}));
}

export function mapSecurityJsonFromPayload<T = unknown>(payload: Uint8Array): T {
  try {
    return JSON.parse(decoder.decode(payload)) as T;
  } catch {
    throw createAppError(AppErrorCode.ProtocolFailure, 'security_json_payload_invalid');
  }
}

export function encodeSecurityChallengeIssueRequest(request: SecurityChallengeIssuePodRequest): Uint8Array {
  return encodeSlicePod([
    request.action,
    request.routeKey,
    request.deviceFingerprint,
    request.attributesJson
  ], 32);
}

export function encodeSecurityChallengeVerifyRequest(request: SecurityChallengeVerifyPodRequest): Uint8Array {
  const bytes = encodeSlicePod([
    request.challengeId,
    request.action,
    request.routeKey,
    request.providerPayloadJson
  ], 36, 4);
  bytes[0] = request.kind;
  return bytes;
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
  for (let index = 0; index < providerPayloadCount; index += 1) {
    const offset = providerPodsOffset + index * SECURITY_CHALLENGE_PROVIDER_PAYLOAD_POD_SIZE;
    providerPayloads.push({
      challengeId: readFixedUtf8(payload, offset, 64),
      payload: parseProviderPayloadJson(readSliceText(blob, readSliceRef(payload, offset + 64)))
    });
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

export function mapSecurityChallengeVerifyResponseFromPayload(payload: Uint8Array): SecurityChallengeVerifyResponse {
  if (payload.byteLength < SECURITY_CHALLENGE_VERIFY_RESPONSE_POD_SIZE) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'security_challenge_verify_payload_short');
  }

  const blob = readBinaryPodBlob(payload, SECURITY_CHALLENGE_VERIFY_RESPONSE_POD_SIZE, 'security_challenge_verify_payload_truncated');
  return {
    verified: readByte(payload, 0) === 1,
    kind: mapSecurityChallengeKind(readByte(payload, 1)),
    retryAfterMs: readInt32(payload, 4),
    challengeId: readFixedUtf8(payload, 8, 64),
    policyVersion: readFixedUtf8(payload, 72, 64),
    proofToken: readSliceText(blob, readSliceRef(payload, 136)),
    reason: readSliceText(blob, readSliceRef(payload, 144))
  };
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

function encodeSlicePod(values: string[], headerBytes: number, firstSliceOffset = 0): Uint8Array {
  const encodedValues = values.map((value) => textEncoder.encode(value ?? ''));
  const blobBytes = encodedValues.reduce((total, value) => total + value.byteLength, 0);
  const bytes = new Uint8Array(headerBytes + 4 + blobBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let blobOffset = 0;
  for (let index = 0; index < encodedValues.length; index += 1) {
    const sliceOffset = firstSliceOffset + index * 8;
    view.setInt32(sliceOffset, blobOffset, true);
    view.setInt32(sliceOffset + 4, encodedValues[index].byteLength, true);
    bytes.set(encodedValues[index], headerBytes + 4 + blobOffset);
    blobOffset += encodedValues[index].byteLength;
  }
  view.setInt32(headerBytes, blobBytes, true);
  return bytes;
}

function readUint16(bytes: Uint8Array, offset: number): number {
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
