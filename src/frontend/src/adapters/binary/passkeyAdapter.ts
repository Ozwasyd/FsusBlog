import type { PasskeyCredentialSummary, PasskeyLoginBeginResponse, PasskeyRegisterBeginResponse } from '@/api/auth';
import { BinaryReader, readByte, readFixedUtf8, readInt32, readIsoDate64, readSliceRef, readSliceText } from './reader';
import { PASSKEY_CREDENTIAL_DESCRIPTOR_POD_SIZE, PASSKEY_CREDENTIAL_SUMMARY_POD_SIZE, PASSKEY_LOGIN_BEGIN_POD_SIZE, PASSKEY_PUBLIC_KEY_CREDENTIAL_PARAM_POD_SIZE, PASSKEY_REGISTER_BEGIN_POD_SIZE } from './types';
import { AppErrorCode, createAppError } from '@/utils/appError';

type DescriptorEnvelope = { pod: Uint8Array; transports: number[] };

export function mapPasskeyRegisterBeginFromPayload(payload: Uint8Array): PasskeyRegisterBeginResponse {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(PASSKEY_REGISTER_BEGIN_POD_SIZE);
  const paramCount = readInt32(pod, 8);
  const excludeCount = readInt32(pod, 12);
  if (paramCount < 0 || excludeCount < 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'passkey_register_begin_count_invalid');
  }

  const params: Array<{ type: 'public-key'; alg: number }> = [];
  for (let i = 0; i < paramCount; i += 1) {
    const param = reader.readSpan(PASSKEY_PUBLIC_KEY_CREDENTIAL_PARAM_POD_SIZE);
    params.push({ type: credentialTypeToText(readInt32(param, 0)), alg: readInt32(param, 4) });
  }

  const descriptors = readDescriptors(reader, excludeCount);
  const blob = reader.readBlob();
  const attachment = readByte(pod, 32) === 1 ? authenticatorAttachmentToText(readInt32(pod, 28)) : undefined;
  return {
    sessionKey: readFixedUtf8(pod, 36, 64),
    options: {
      rp: {
        id: readSliceText(blob, readSliceRef(pod, 100)),
        name: readSliceText(blob, readSliceRef(pod, 108))
      },
      user: {
        id: bytesToBase64Url(readBytes(blob, pod, 132)),
        name: readSliceText(blob, readSliceRef(pod, 116)),
        displayName: readSliceText(blob, readSliceRef(pod, 124))
      },
      challenge: bytesToBase64Url(readBytes(blob, pod, 140)),
      pubKeyCredParams: params,
      timeout: Number(new DataView(pod.buffer, pod.byteOffset, pod.byteLength).getBigUint64(0, true)),
      attestation: attestationToText(readInt32(pod, 16)),
      authenticatorSelection: {
        ...(attachment ? { authenticatorAttachment: attachment } : {}),
        residentKey: residentKeyToText(readInt32(pod, 20)),
        requireResidentKey: readByte(pod, 33) === 1,
        userVerification: userVerificationToText(readInt32(pod, 24))
      },
      excludeCredentials: descriptors.map((descriptor) => descriptorToView(descriptor, blob))
    }
  };
}

export function mapPasskeyLoginBeginFromPayload(payload: Uint8Array): PasskeyLoginBeginResponse {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(PASSKEY_LOGIN_BEGIN_POD_SIZE);
  const allowCount = readInt32(pod, 8);
  if (allowCount < 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'passkey_login_begin_count_invalid');
  }

  const descriptors = readDescriptors(reader, allowCount);
  const blob = reader.readBlob();
  const userVerification = readInt32(pod, 12);
  return {
    challengeToken: readFixedUtf8(pod, 20, 64),
    options: {
      challenge: bytesToBase64Url(readBytes(blob, pod, 92)),
      timeout: Number(new DataView(pod.buffer, pod.byteOffset, pod.byteLength).getBigUint64(0, true)),
      rpId: readSliceText(blob, readSliceRef(pod, 84)),
      ...(userVerification >= 0 ? { userVerification: userVerificationToText(userVerification) } : {}),
      allowCredentials: descriptors.map((descriptor) => descriptorToView(descriptor, blob))
    }
  };
}

export function mapPasskeyCredentialListFromPayload(payload: Uint8Array): PasskeyCredentialSummary[] {
  const reader = new BinaryReader(payload);
  const count = reader.readInt32();
  if (count < 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'passkey_credential_count_invalid');
  }

  const pods: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    pods.push(reader.readSpan(PASSKEY_CREDENTIAL_SUMMARY_POD_SIZE));
  }
  const blob = reader.readBlob();
  return pods.map((pod) => ({
    id: readInt32(pod, 0),
    deviceFriendlyName: readByte(pod, 4) === 1 ? readSliceText(blob, readSliceRef(pod, 88)) : null,
    createdAt: readIsoDate64(pod, 8),
    lastUsedAt: readByte(pod, 5) === 1 ? readIsoDate64(pod, 16) : null,
    aaGuid: readFixedUtf8(pod, 24, 64),
    backupEligible: readByte(pod, 6) === 1,
    backupState: readByte(pod, 7) === 1
  }));
}

function readDescriptors(reader: BinaryReader, count: number): DescriptorEnvelope[] {
  const descriptors: DescriptorEnvelope[] = [];
  for (let i = 0; i < count; i += 1) {
    const pod = reader.readSpan(PASSKEY_CREDENTIAL_DESCRIPTOR_POD_SIZE);
    const transportCount = reader.readInt32();
    if (transportCount < 0 || transportCount !== readInt32(pod, 4)) {
      throw createAppError(AppErrorCode.ProtocolFailure, 'passkey_descriptor_transport_count_invalid');
    }

    const transports: number[] = [];
    for (let transportIndex = 0; transportIndex < transportCount; transportIndex += 1) {
      transports.push(reader.readInt32());
    }
    descriptors.push({ pod, transports });
  }
  return descriptors;
}

function descriptorToView(descriptor: DescriptorEnvelope, blob: Uint8Array): { type: 'public-key'; id: string; transports?: string[] } {
  const transports = descriptor.transports.map(transportToText).filter(Boolean) as string[];
  return {
    type: credentialTypeToText(readInt32(descriptor.pod, 0)),
    id: bytesToBase64Url(readSliceBytes(blob, readSliceRef(descriptor.pod, 8))),
    ...(transports.length > 0 ? { transports } : {})
  };
}

function readBytes(blob: Uint8Array, pod: Uint8Array, offset: number): Uint8Array {
  return readSliceBytes(blob, readSliceRef(pod, offset));
}

function readSliceBytes(blob: Uint8Array, slice: { offset: number; length: number }): Uint8Array {
  if (slice.offset < 0 || slice.length < 0 || slice.offset + slice.length > blob.byteLength) {
    return new Uint8Array(0);
  }
  return blob.subarray(slice.offset, slice.offset + slice.length);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function credentialTypeToText(value: number): 'public-key' {
  if (value !== 0) throw createAppError(AppErrorCode.ProtocolFailure, 'passkey_credential_type_invalid');
  return 'public-key';
}

function attestationToText(value: number): 'none' | 'indirect' | 'direct' | 'enterprise' {
  return value === 1 ? 'indirect' : value === 2 ? 'direct' : value === 3 ? 'enterprise' : 'none';
}

function residentKeyToText(value: number): 'required' | 'preferred' | 'discouraged' {
  return value === 1 ? 'preferred' : value === 2 ? 'discouraged' : 'required';
}

function userVerificationToText(value: number): 'required' | 'preferred' | 'discouraged' {
  return value === 1 ? 'preferred' : value === 2 ? 'discouraged' : 'required';
}

function authenticatorAttachmentToText(value: number): 'platform' | 'cross-platform' {
  return value === 1 ? 'cross-platform' : 'platform';
}

function transportToText(value: number): string | null {
  return ['usb', 'nfc', 'ble', 'smart-card', 'hybrid', 'internal'][value] ?? null;
}
