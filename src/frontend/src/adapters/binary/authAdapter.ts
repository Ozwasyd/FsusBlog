import { BinaryReader, readByte, readFixedUtf8, readInt32, readIsoDate64, readSliceRef, readSliceText } from '@/codecs/binary/reader';
import type { AuthLoginFlow, CurrentUserSnapshot, MfaChallengeResult, MfaProfile, MfaSetupStart, MfaSetupVerify, RecoveryKeyCreateResponse, RecoveryKeyVerifyResponse, UserSessionSummary } from '@/contracts/binaryApi';
import { createAppError, AppErrorCode } from '@/utils/appError';

import { readArrayEnvelope } from './envelopeReaders';
import { AUTH_LOGIN_FLOW_POD_SIZE, CURRENT_USER_SNAPSHOT_POD_SIZE, IDENTITY_ACCOUNT_SNAPSHOT_POD_SIZE, MFA_CHALLENGE_RESULT_POD_SIZE, MFA_PROFILE_POD_SIZE, MFA_RECOVERY_CODE_POD_SIZE, MFA_SETUP_START_POD_SIZE, MFA_SETUP_VERIFY_POD_SIZE, RECOVERY_KEY_CREATE_RESPONSE_POD_SIZE, RECOVERY_KEY_VERIFY_RESPONSE_POD_SIZE, USER_SESSION_SUMMARY_POD_SIZE } from './types';

interface AdminCurrentUserSnapshot {
    accountId: number;
    identityKind: string;
    status: number;
    banReason: string | null;
    deletedAt: string | null;
}

const DEFAULT_IDENTITY_KIND = 'anonymous_account';

function normalizeIdentityKind(value: string): string
{
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : DEFAULT_IDENTITY_KIND;
}

export function mapAuthLoginFlowFromPayload(payload: Uint8Array): AuthLoginFlow
{
    if (payload.byteLength !== AUTH_LOGIN_FLOW_POD_SIZE)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'auth_login_flow_payload_invalid');
    }

    const authPhase = readByte(payload, 4);
    const mfaMode = readByte(payload, 5);
    const hasChallengeToken = readByte(payload, 6) === 1;
    const hasIdentityKind = readByte(payload, 7) === 1;
    return {
        accountId: readInt32(payload, 0),
        identityKind: hasIdentityKind ? normalizeIdentityKind(readFixedUtf8(payload, 8, 64)) : DEFAULT_IDENTITY_KIND,
        authPhase: authPhase === 2 ? 'mfa_required' : authPhase === 3 ? 'enrollment_required' : 'authenticated',
        mfaMode: mfaMode === 1 ? 'risk' : mfaMode === 2 ? 'standard' : null,
        challengeToken: hasChallengeToken ? readFixedUtf8(payload, 104, 64) : null
    };
}

export function mapCurrentUserSnapshotFromPayload(payload: Uint8Array): AdminCurrentUserSnapshot
{
    if (payload.byteLength !== CURRENT_USER_SNAPSHOT_POD_SIZE)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'current_user_snapshot_payload_invalid');
    }

    const hasDeletedAt = readByte(payload, 16) === 1;
    const hasIdentityKind = readByte(payload, 17) === 1;
    const banReason = readFixedUtf8(payload, 116, 256);
    return {
        accountId: readInt32(payload, 0),
        identityKind: hasIdentityKind ? normalizeIdentityKind(readFixedUtf8(payload, 20, 64)) : DEFAULT_IDENTITY_KIND,
        status: readInt32(payload, 4),
        deletedAt: hasDeletedAt ? readIsoDate64(payload, 8) : null,
        banReason: banReason.length > 0 ? banReason : null
    };
}

export function mapIdentityAccountSnapshotFromPayload(payload: Uint8Array): Omit<CurrentUserSnapshot, 'accessExpiresAtUtc'>
{
    const reader = new BinaryReader(payload);
    const pod = reader.readSpan(IDENTITY_ACCOUNT_SNAPSHOT_POD_SIZE);
    const blob = reader.readBlob();

    if (reader.remaining() !== 0)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'identity_account_snapshot_trailing_payload_invalid');
    }

    for (const flagOffset of [20, 21, 22, 23, 24, 25, 26, 27])
    {
        if (readByte(pod, flagOffset) > 1)
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'identity_account_snapshot_flag_invalid');
        }
    }

    const hasPublicHandle = readByte(pod, 20) === 1;
    const hasTotpStepUpEnabled = readByte(pod, 23) === 1;
    const hasAnonymousCredential = readByte(pod, 25) === 1;
    const hasDeletedAt = readByte(pod, 26) === 1;
    const hasBanReason = readByte(pod, 27) === 1;
    const accountId = readInt32(pod, 0);
    const optionalText = (value: string): string | null => value.length > 0 ? value : null;

    return {
        accountId,
        identityKind: optionalText(readSliceText(blob, readSliceRef(pod, 56))) ?? 'anonymous_account',
        publicHandle: hasPublicHandle ? optionalText(readSliceText(blob, readSliceRef(pod, 32))) : null,
        passkeyEnabled: readByte(pod, 21) === 1,
        recoveryEnabled: readByte(pod, 22) === 1,
        totpStepUpEnabled: hasTotpStepUpEnabled ? readByte(pod, 24) === 1 : null,
        anonymousCredentialStatus: hasAnonymousCredential ? optionalText(readSliceText(blob, readSliceRef(pod, 40))) : null,
        anonymousCredentialLevel: hasAnonymousCredential ? optionalText(readSliceText(blob, readSliceRef(pod, 48))) : null,
        status: readInt32(pod, 8),
        banReason: hasBanReason ? optionalText(readSliceText(blob, readSliceRef(pod, 64))) : null,
        deletedAt: hasDeletedAt ? readIsoDate64(pod, 12) : null
    };
}

export function mapUserSessionsFromPayload(payload: Uint8Array): UserSessionSummary[]
{
    const reader = new BinaryReader(payload);
    return readArrayEnvelope(reader, () => readUserSessionSummary(reader), 'auth_session_count_invalid', 'auth_session_trailing_payload_invalid');
}

export function mapPowChallengeFromPayload(payload: Uint8Array): { salt: string; difficulty: number; timestamp: number; signature: string; }
{
    if (payload.byteLength !== 204)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'pow_challenge_payload_invalid');
    }

    return {
        salt: readFixedUtf8(payload, 0, 64),
        difficulty: readInt32(payload, 64),
        timestamp: Number(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigInt64(68, true)),
        signature: readFixedUtf8(payload, 76, 128)
    };
}

export function mapMfaSetupStartFromPayload(payload: Uint8Array): MfaSetupStart
{
    const reader = new BinaryReader(payload);
    const pod = reader.readSpan(MFA_SETUP_START_POD_SIZE);
    const blob = reader.readBlob();
    const result = {
        enabled: readByte(pod, 0) === 1,
        secret: readSliceText(blob, readSliceRef(pod, 4)),
        otpAuthUrl: readSliceText(blob, readSliceRef(pod, 12)),
        issuer: readSliceText(blob, readSliceRef(pod, 20)),
        account: readSliceText(blob, readSliceRef(pod, 28))
    };

    if (reader.remaining() !== 0)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'mfa_setup_start_trailing_payload_invalid');
    }

    return result;
}

export function mapMfaSetupVerifyFromPayload(payload: Uint8Array): MfaSetupVerify
{
    if (payload.byteLength < MFA_SETUP_VERIFY_POD_SIZE)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'mfa_setup_verify_payload_invalid');
    }

    const enabled = readByte(payload, 0) === 1;
    const count = readInt32(payload, 4);
    if (count < 0 || payload.byteLength !== MFA_SETUP_VERIFY_POD_SIZE + count * MFA_RECOVERY_CODE_POD_SIZE)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'mfa_recovery_code_count_invalid');
    }

    const recoveryCodes: string[] = [];
    for (let i = 0; i < count; i += 1)
    {
        recoveryCodes.push(readFixedUtf8(payload, MFA_SETUP_VERIFY_POD_SIZE + i * MFA_RECOVERY_CODE_POD_SIZE, MFA_RECOVERY_CODE_POD_SIZE));
    }
    return { enabled, recoveryCodes };
}

export function mapMfaProfileFromPayload(payload: Uint8Array): MfaProfile
{
    if (payload.byteLength !== MFA_PROFILE_POD_SIZE)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'mfa_profile_payload_invalid');
    }

    return {
        enabled: readByte(payload, 8) === 1,
        verifiedAt: readByte(payload, 9) === 1 ? readIsoDate64(payload, 0) : null
    };
}

export function mapMfaChallengeResultFromPayload(payload: Uint8Array): MfaChallengeResult
{
    if (payload.byteLength !== MFA_CHALLENGE_RESULT_POD_SIZE)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'mfa_challenge_result_payload_invalid');
    }

    const hasProofToken = readByte(payload, 5) === 1;
    const hasUser = readByte(payload, 6) === 1;
    const hasIdentityKind = readByte(payload, 7) === 1;
    return {
        verified: readByte(payload, 4) === 1,
        action: readFixedUtf8(payload, 104, 64),
        proofToken: hasProofToken ? readFixedUtf8(payload, 168, 128) : null,
        user: hasUser ? {
      accountId: readInt32(payload, 0),
      identityKind: hasIdentityKind ? normalizeIdentityKind(readFixedUtf8(payload, 8, 64)) : DEFAULT_IDENTITY_KIND
    } : null
    };
}

export function mapRecoveryKeyCreateResponseFromPayload(payload: Uint8Array): RecoveryKeyCreateResponse
{
    const reader = new BinaryReader(payload);
    const pod = reader.readSpan(RECOVERY_KEY_CREATE_RESPONSE_POD_SIZE);
    const blob = reader.readBlob();
    const recoveryKey = readSliceText(blob, readSliceRef(pod, 16));

    if (!recoveryKey || reader.remaining() !== 0)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'recovery_key_create_payload_invalid');
    }

    return {
        keyVersion: readInt32(pod, 0),
        createdAt: readIsoDate64(pod, 8),
        recoveryKey
    };
}

export function mapRecoveryKeyVerifyResponseFromPayload(payload: Uint8Array): RecoveryKeyVerifyResponse
{
    if (payload.byteLength !== RECOVERY_KEY_VERIFY_RESPONSE_POD_SIZE)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'recovery_key_verify_payload_invalid');
    }

    const recoverySessionToken = readFixedUtf8(payload, 16, 128);
    if (!recoverySessionToken)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'recovery_key_verify_response_invalid');
    }

    return {
        expiresAt: readIsoDate64(payload, 8),
        recoverySessionToken
    };
}

function readUserSessionSummary(reader: BinaryReader): UserSessionSummary
{
    const pod = reader.readSpan(USER_SESSION_SUMMARY_POD_SIZE);
    const hasLastSeenAt = readByte(pod, 17) === 1;
    const hasPasskeyFriendlyName = readByte(pod, 18) === 1;
    if (readByte(pod, 16) > 1 || readByte(pod, 17) > 1 || readByte(pod, 18) > 1 || readByte(pod, 19) !== 0)
    {
        throw createAppError(AppErrorCode.Validation, 'auth_session_flags_invalid');
    }
    return {
        createdAt: readIsoDate64(pod, 0),
        lastSeenAt: hasLastSeenAt ? readIsoDate64(pod, 8) : null,
        isCurrent: readByte(pod, 16) === 1,
        sessionId: readFixedUtf8(pod, 20, 64),
        deviceLabel: readFixedUtf8(pod, 84, 64),
        authenticationMethod: readFixedUtf8(pod, 148, 32) as UserSessionSummary['authenticationMethod'],
        authenticationStrength: readFixedUtf8(pod, 180, 32) as UserSessionSummary['authenticationStrength'],
        durationPolicy: readFixedUtf8(pod, 212, 32) as UserSessionSummary['durationPolicy'],
        passkeyFriendlyName: hasPasskeyFriendlyName ? readFixedUtf8(pod, 244, 256) : null
    };
}
