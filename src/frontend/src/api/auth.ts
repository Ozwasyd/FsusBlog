import { requestBinaryOnly } from '@/composition/binaryTransport';
import type {
    AuthLoginFlow,
    CurrentUserSnapshot,
    MfaChallengeResult,
    MfaProfile,
    MfaSetupStart,
    MfaSetupVerify,
    PasskeyCredentialSummary,
    PasskeyLoginBeginResponse,
    PasskeyRegisterBeginResponse,
    PasskeySignalState,
    RecoveryKeyCreateResponse,
    RecoveryKeyVerifyRequest,
    RecoveryKeyVerifyResponse,
    UserLocalePreference,
    UserLocalePreferenceUpdate,
    UserSessionSummary
} from '@/contracts/binaryApi';
import { AppErrorCode, createAppError } from '@/utils/appError';

import { FrameType } from '@wasm/protocol/frame';

import { encodeAedsFrame, encodePasskeyCredentialFriendlyNameUpdateRequest, encodeStringMutationRequest, encodeUserLocalePreferenceUpdateRequest, writeFixedUtf8 } from './binaryFrame';
import { FSUS_HEADERS } from './contracts';


import type { ApiRequestConfig } from './requestConfig';
export type {
    AuthLoginFlow,
    CurrentUserSnapshot,
    MfaChallengeResult,
    MfaProfile,
    MfaSetupStart,
    MfaSetupVerify,
    PasskeyCredentialSummary,
    PasskeyLoginBeginResponse,
    PasskeyRegisterBeginResponse,
    PasskeySignalState,
    RecoveryKeyCreateResponse,
    RecoveryKeyVerifyRequest,
    RecoveryKeyVerifyResponse,
    UserLocalePreference,
    UserLocalePreferenceUpdate,
    UserSessionSummary
} from '@/contracts/binaryApi';

// ================= DTO 类型定义 (对应后端业务载荷) =================

export interface AnonymousBootstrapRequest {
    publicHandle?: string;
    acceptedGuidelines: boolean;
}

export interface UpdatePublicHandleDto {
    publicHandle: string | null;
}

export interface MfaStepUpProofPayload {
    mfaProofToken?: string | null;
}

const isNetworkTransportFailure = (error: unknown): boolean =>
    typeof error === 'object'
  && error !== null
  && (error as { name?: unknown; }).name === 'BinaryTransportError'
  && (error as { kind?: unknown; }).kind === 'network';

// ================= 响应模型定义 =================

export type AdminSessionStatus = 'missing' | 'active' | 'expired' | 'step_up_required';
export type AdminPrincipalSource = 'independent';

export interface AdminPrincipalSnapshot {
    id: string;
    displayName: string;
    source: AdminPrincipalSource;
    permissions: readonly string[];
    adminSessionStatus: AdminSessionStatus;
    totpStepUpRequired?: boolean;
}

export interface DeleteAccountRequest {
    confirmText: string;
    mfaProofToken?: string | null;
}

// ================= API 方法定义 =================

export const bootstrapAnonymousAccount = (data: AnonymousBootstrapRequest, config?: ApiRequestConfig) =>
{
    return requestBinaryOnly<AuthLoginFlow>({
        binaryRoute: { operationId: 'binary_post_auth_anonymous_bootstrap' },
        frameType: FrameType.AuthLoginFlow,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.AuthAnonymousBootstrapRequest, encodeAuthAnonymousBootstrapRequest(data))
        }
    });
};

/**
 * 获取当前登录用户信息 (利用 Cookie 中的 Token)
 */
export const getMe = async (config?: ApiRequestConfig) =>
{
    let accessExpiresAtUtc = '';
    const snapshot = await requestBinaryOnly<Omit<CurrentUserSnapshot, 'accessExpiresAtUtc'>>({
        binaryRoute: { operationId: 'binary_get_auth_me' },
        frameType: FrameType.IdentityAccountSnapshot,
        signal: config?.signal,
        suppressAuthFailureTelemetry: true,
        requestOptions: {
            onResponseHeaders: (headers) =>
            {
                accessExpiresAtUtc = headers.get(FSUS_HEADERS.accessExpiresAtUtc)?.trim() ?? '';
            }
        }
    });
    if (!accessExpiresAtUtc || !Number.isFinite(Date.parse(accessExpiresAtUtc)))
    {
        throw createAppError(AppErrorCode.Validation, 'auth_access_expiry_missing');
    }
    return { ...snapshot, accessExpiresAtUtc };
};

export const updatePublicHandle = (data: UpdatePublicHandleDto, config?: ApiRequestConfig) =>
{
    return requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_put_auth_public_handle' },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.AuthUpdatePublicHandleRequest, encodeStringMutationRequest(data.publicHandle ?? ''))
        }
    });
};

export const getLocalePreference = (config?: ApiRequestConfig) =>
    requestBinaryOnly<UserLocalePreference>({
        binaryRoute: { operationId: 'binary_get_locale_preference' },
        frameType: FrameType.UserLocalePreference,
        signal: config?.signal
    });

export const updateLocalePreference = (
    data: UserLocalePreferenceUpdate,
    config?: ApiRequestConfig
) =>
    requestBinaryOnly<UserLocalePreference>({
        binaryRoute: { operationId: 'binary_put_locale_preference' },
        frameType: FrameType.UserLocalePreference,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(
                FrameType.UserLocalePreferenceUpdateRequest,
                encodeUserLocalePreferenceUpdateRequest(
                    data.mode,
                    data.fixedLocale,
                    data.expectedRevision
                )
            )
        }
    });

/**
 * 退出登录
 */
export const logout = (config?: ApiRequestConfig) =>
{
    return requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_post_auth_logout' },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
        }
    });
};

export const logoutAdmin = async (config?: ApiRequestConfig) =>
{
    const requestLogout = () => requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_post_auth_admin_logout' },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        suppressAuthFailureTelemetry: true,
        requestOptions: {
        }
    });

    try
    {
        return await requestLogout();
    }
    catch (error: unknown)
    {
        if (!isNetworkTransportFailure(error) || config?.signal?.aborted)
        {
            throw error;
        }

        // A response can be lost after the server commits the revocation. The
        // endpoint is safe to retry; a resulting 401 proves the session is no
        // longer accepted and is classified by the store as already inactive.
        return requestLogout();
    }
};

export const deleteAccount = (data: DeleteAccountRequest, config?: ApiRequestConfig) =>
{
    return requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_post_auth_delete_account' },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
            headers: mfaProofHeaders(data.mfaProofToken ?? config?.mfaProofToken),
            body: encodeAedsFrame(FrameType.AuthDeleteAccountRequest, encodeAuthDeleteAccountRequest(data))
        }
    });
};

/**
 * 手动刷新 Token
 */
export const refreshToken = async (config?: ApiRequestConfig) =>
{
    return requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_post_auth_refresh_token' },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        suppressAuthFailureTelemetry: true,
        requestOptions: {
        }
    });
};

export const listSessions = (config?: ApiRequestConfig) =>
    requestBinaryOnly<UserSessionSummary[]>({
        binaryRoute: { operationId: 'binary_get_auth_sessions' },
        frameType: FrameType.AuthSessionList,
        signal: config?.signal
    });

export const revokeSession = (sessionId: string, config?: ApiRequestConfig) =>
    requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_post_auth_sessions_id_revoke', params: { id: sessionId } },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
        }
    });

export const revokeOtherSessions = (config?: ApiRequestConfig) =>
    requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_post_auth_sessions_revoke_others' },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
        }
    });

export const getAdminMe = (config?: ApiRequestConfig) =>
    requestBinaryOnly<AdminPrincipalSnapshot>({
        binaryRoute: { operationId: 'binary_get_auth_admin_me' },
        frameType: FrameType.AdminPrincipalSnapshot,
        signal: config?.signal,
        suppressAuthFailureTelemetry: true
    });

export const startMfaSetup = (
    payload?: MfaStepUpProofPayload,
    config?: ApiRequestConfig
) =>
    requestBinaryOnly<MfaSetupStart>({
        binaryRoute: { operationId: 'binary_post_auth_mfa_setup_start' },
        frameType: FrameType.MfaSetupStart,
        signal: config?.signal,
        requestOptions: {
            headers: mfaProofHeaders(payload?.mfaProofToken ?? config?.mfaProofToken)
        }
    });

export const getMfaProfile = (config?: ApiRequestConfig) =>
    requestBinaryOnly<MfaProfile>({
        binaryRoute: { operationId: 'binary_get_auth_mfa_profile' },
        frameType: FrameType.MfaProfile,
        signal: config?.signal
    });

export const verifyMfaSetup = (code: string, config?: ApiRequestConfig) =>
    requestBinaryOnly<MfaSetupVerify>({
        binaryRoute: { operationId: 'binary_post_auth_mfa_setup_verify' },
        frameType: FrameType.MfaSetupVerify,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.MfaSetupVerifyRequest, encodeStringMutationRequest(code))
        }
    });

export const disableMfa = (payload: MfaStepUpProofPayload, config?: ApiRequestConfig) =>
    requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_post_auth_mfa_disable' },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
            headers: mfaProofHeaders(payload.mfaProofToken ?? config?.mfaProofToken)
        }
    });

export const regenerateMfaRecoveryCodes = (
    payload: MfaStepUpProofPayload,
    config?: ApiRequestConfig
) => requestBinaryOnly<MfaSetupVerify>({
    binaryRoute: { operationId: 'binary_post_auth_mfa_recovery_regenerate' },
    frameType: FrameType.MfaSetupVerify,
    signal: config?.signal,
    requestOptions: {
        headers: mfaProofHeaders(payload.mfaProofToken ?? config?.mfaProofToken)
    }
});

export const startMfaChallenge = (action: string, config?: ApiRequestConfig) =>
    requestBinaryOnly<MfaChallengeResult>({
        binaryRoute: { operationId: 'binary_post_auth_mfa_challenge_start' },
        frameType: FrameType.MfaChallengeResult,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.MfaChallengeStartRequest, encodeStringMutationRequest(action))
        }
    });

export const verifyMfaChallenge = (
    payload: { challengeToken: string; code?: string; recoveryCode?: string; action?: string; },
    config?: ApiRequestConfig
) => requestBinaryOnly<MfaChallengeResult>({
    binaryRoute: { operationId: 'binary_post_auth_mfa_challenge' },
    frameType: FrameType.MfaChallengeResult,
    signal: config?.signal,
    requestOptions: {
        body: encodeAedsFrame(FrameType.MfaChallengeVerifyRequest, encodeMfaChallengeVerifyRequest(payload))
    }
});

export const userStepUpPasskeyBegin = (action: string, config?: ApiRequestConfig) =>
    requestBinaryOnly<PasskeyLoginBeginResponse>({
        binaryRoute: { operationId: 'binary_post_auth_step_up_passkey_begin' },
        frameType: FrameType.PasskeyLoginBegin,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.MfaChallengeStartRequest, encodeStringMutationRequest(action))
        }
    });

export const userStepUpPasskeyComplete = (data: PasskeyLoginCompleteRequest, config?: ApiRequestConfig) =>
    requestBinaryOnly<MfaChallengeResult>({
        binaryRoute: { operationId: 'binary_post_auth_step_up_passkey_complete' },
        frameType: FrameType.MfaChallengeResult,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.PasskeyLoginCompleteRequest, encodePasskeyLoginCompleteRequest(data))
        }
    });

/**
 * 获取 PoW 挑战接口
 * 当前挑战仅按 clientIp 生成，不区分 action。
 */
export const getPowChallenge = (config?: ApiRequestConfig) =>
{
    return requestBinaryOnly<any>({
        binaryRoute: { operationId: 'binary_get_auth_pow_challenge' },
        frameType: FrameType.PowChallenge,
        signal: config?.signal
    });
};

// ================= 通行密钥 (Passkey / WebAuthn) =================

// Passkey response contracts are defined in contracts/binaryApi.ts.

export interface PasskeyRegisterCompleteRequest {
    sessionKey: string;
    attestation: any;
    friendlyName?: string;
    mfaProofToken?: string;
}

export interface RecoveryPasskeyRegisterCompleteRequest extends Omit<PasskeyRegisterCompleteRequest, 'mfaProofToken'> {
    recoverySessionToken: string;
}

export interface PasskeyLoginCompleteRequest {
    challengeToken: string;
    assertion: any;
    rememberMe?: boolean;
}

export const passkeyRegisterBegin = (config?: ApiRequestConfig) =>
    requestBinaryOnly<PasskeyRegisterBeginResponse>({
        binaryRoute: { operationId: 'binary_post_auth_passkey_register_begin' },
        frameType: FrameType.PasskeyRegisterBegin,
        signal: config?.signal,
        requestOptions: { }
    });

export const passkeyRegisterComplete = (data: PasskeyRegisterCompleteRequest, config?: ApiRequestConfig) =>
    requestBinaryOnly<PasskeySignalState>({
        binaryRoute: { operationId: 'binary_post_auth_passkey_register_complete' },
        frameType: FrameType.PasskeySignalState,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.PasskeyRegisterCompleteRequest, encodePasskeyRegisterCompleteRequest(data))
        }
    });

export const enrollmentPasskeyRegisterBegin = (config?: ApiRequestConfig) =>
    requestBinaryOnly<PasskeyRegisterBeginResponse>({
        binaryRoute: { operationId: 'binary_post_auth_enrollment_passkey_register_begin' },
        frameType: FrameType.PasskeyRegisterBegin,
        signal: config?.signal,
        requestOptions: { }
    });

export const enrollmentPasskeyRegisterComplete = (data: PasskeyRegisterCompleteRequest, config?: ApiRequestConfig) =>
    requestBinaryOnly<AuthLoginFlow>({
        binaryRoute: { operationId: 'binary_post_auth_enrollment_passkey_register_complete' },
        frameType: FrameType.AuthLoginFlow,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.PasskeyRegisterCompleteRequest, encodePasskeyRegisterCompleteRequest(data))
        }
    });

export const getEnrollmentStatus = (config?: ApiRequestConfig) =>
    requestBinaryOnly<AuthLoginFlow>({
        binaryRoute: { operationId: 'binary_get_auth_enrollment_status' },
        frameType: FrameType.AuthLoginFlow,
        signal: config?.signal
    });

export const cancelEnrollment = (config?: ApiRequestConfig) =>
    requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_post_auth_enrollment_cancel' },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: { }
    });

export const createRecoveryKey = (config?: ApiRequestConfig) =>
    requestBinaryOnly<RecoveryKeyCreateResponse>({
        binaryRoute: { operationId: 'binary_post_auth_recovery_key_create' },
        frameType: FrameType.RecoveryKeyCreateResponse,
        signal: config?.signal,
        requestOptions: {
            headers: mfaProofHeaders(config?.mfaProofToken)
        }
    });

export const rotateRecoveryKey = (config?: ApiRequestConfig) =>
    requestBinaryOnly<RecoveryKeyCreateResponse>({
        binaryRoute: { operationId: 'binary_post_auth_recovery_key_rotate' },
        frameType: FrameType.RecoveryKeyCreateResponse,
        signal: config?.signal,
        requestOptions: {
            headers: mfaProofHeaders(config?.mfaProofToken)
        }
    });

export const verifyRecoveryKey = (data: RecoveryKeyVerifyRequest, config?: ApiRequestConfig) =>
    requestBinaryOnly<RecoveryKeyVerifyResponse>({
        binaryRoute: { operationId: 'binary_post_auth_recovery_key_verify' },
        frameType: FrameType.RecoveryKeyVerifyResponse,
        signal: config?.signal,
        requestOptions: {
            riskChallengeProof: config?.riskChallengeProof ?? undefined,
            body: encodeAedsFrame(FrameType.RecoveryKeyVerifyRequest, encodeRecoveryKeyVerifyRequest(data))
        }
    });

export const beginRecoveryPasskeyRegistration = (recoverySessionToken: string, config?: ApiRequestConfig) =>
    requestBinaryOnly<PasskeyRegisterBeginResponse>({
        binaryRoute: { operationId: 'binary_post_auth_recovery_key_passkey_register_begin' },
        frameType: FrameType.PasskeyRegisterBegin,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.RecoveryKeySessionRequest, encodeStringMutationRequest(recoverySessionToken))
        }
    });

export const completeRecoveryPasskeyRegistration = (data: RecoveryPasskeyRegisterCompleteRequest, config?: ApiRequestConfig) =>
    requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_post_auth_recovery_key_passkey_register_complete' },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.PasskeyRegisterCompleteRequest, encodePasskeyRegisterCompleteRequest({
                sessionKey: data.sessionKey,
                attestation: data.attestation,
                friendlyName: data.friendlyName,
                mfaProofToken: data.recoverySessionToken
            }))
        }
    });

export const passkeyLoginBegin = (config?: ApiRequestConfig) =>
    requestBinaryOnly<PasskeyLoginBeginResponse>({
        binaryRoute: { operationId: 'binary_post_auth_passkey_login_begin' },
        frameType: FrameType.PasskeyLoginBegin,
        signal: config?.signal,
        requestOptions: {
            riskChallengeProof: config?.riskChallengeProof ?? undefined
        }
    });

export const passkeyLoginComplete = (data: PasskeyLoginCompleteRequest, config?: ApiRequestConfig) =>
    requestBinaryOnly<AuthLoginFlow>({
        binaryRoute: { operationId: 'binary_post_auth_passkey_login_complete' },
        frameType: FrameType.AuthLoginFlow,
        signal: config?.signal,
        requestOptions: {
            riskChallengeProof: config?.riskChallengeProof ?? undefined,
            body: encodeAedsFrame(FrameType.PasskeyLoginCompleteRequest, encodePasskeyLoginCompleteRequest(data))
        }
    });

export const adminStepUpPasskeyBegin = (config?: ApiRequestConfig) =>
    requestBinaryOnly<PasskeyLoginBeginResponse>({
        binaryRoute: { operationId: 'binary_post_auth_admin_step_up_passkey_begin' },
        frameType: FrameType.PasskeyLoginBegin,
        signal: config?.signal,
        suppressAuthFailureTelemetry: true,
        requestOptions: { }
    });

export const adminStepUpPasskeyComplete = (data: PasskeyLoginCompleteRequest, config?: ApiRequestConfig) =>
    requestBinaryOnly<MfaChallengeResult>({
        binaryRoute: { operationId: 'binary_post_auth_admin_step_up_passkey_complete' },
        frameType: FrameType.MfaChallengeResult,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.PasskeyLoginCompleteRequest, encodePasskeyLoginCompleteRequest(data))
        }
    });

export const listPasskeys = (config?: ApiRequestConfig) =>
    requestBinaryOnly<PasskeyCredentialSummary[]>({
        binaryRoute: { operationId: 'binary_get_auth_passkey_credentials' },
        frameType: FrameType.PasskeyCredentialList,
        signal: config?.signal
    });

export const getPasskeySignalState = (config?: ApiRequestConfig) =>
    requestBinaryOnly<PasskeySignalState>({
        binaryRoute: { operationId: 'binary_get_auth_passkey_signal_state' },
        frameType: FrameType.PasskeySignalState,
        signal: config?.signal
    });

export const deletePasskey = (id: number, config?: ApiRequestConfig) =>
    requestBinaryOnly<PasskeySignalState>({
        binaryRoute: { operationId: 'binary_delete_auth_passkey_credentials_id_int', params: { id } },
        frameType: FrameType.PasskeySignalState,
        signal: config?.signal,
        requestOptions: {
            headers: mfaProofHeaders(config?.mfaProofToken)
        }
    });

export const renamePasskey = (id: number, name: string, config?: ApiRequestConfig) =>
    requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_put_auth_passkey_credentials_id_int_name', params: { id } },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
            headers: mfaProofHeaders(config?.mfaProofToken),
            body: encodeAedsFrame(
                FrameType.PasskeyCredentialFriendlyNameUpdateRequest,
                encodePasskeyCredentialFriendlyNameUpdateRequest(name)
            )
        }
    });

function encodeAuthAnonymousBootstrapRequest(data: AnonymousBootstrapRequest): Uint8Array
{
    const publicHandle = textBytes(data.publicHandle?.trim() ?? '');
    const bytes = new Uint8Array(16 + publicHandle.byteLength);
    const view = new DataView(bytes.buffer);
    bytes[0] = data.acceptedGuidelines ? 1 : 0;
    bytes[1] = publicHandle.byteLength > 0 ? 1 : 0;
    view.setUint16(2, 0, true);
    writeSliceRef(view, 4, { offset: 0, length: publicHandle.byteLength });
    view.setInt32(12, publicHandle.byteLength, true);
    bytes.set(publicHandle, 16);
    return bytes;
}

function encodeAuthDeleteAccountRequest(data: DeleteAccountRequest): Uint8Array
{
    const { bytes, refs, blobLength } = encodeStringBlob([data.confirmText]);
    const view = new DataView(bytes.buffer);
    writeSliceRef(view, 0, refs[0]);
    view.setInt32(8, blobLength, true);
    return bytes;
}

function mfaProofHeaders(mfaProofToken?: string | null): Headers | undefined
{
    const proofToken = mfaProofToken?.trim();
    if (!proofToken)
    {
        return undefined;
    }

    const headers = new Headers();
    headers.set('X-Fsus-Mfa-Proof', proofToken);
    return headers;
}

function encodeMfaChallengeVerifyRequest(data: { challengeToken: string; code?: string; recoveryCode?: string; action?: string; }): Uint8Array
{
    const { bytes, refs, blobLength } = encodeStringBlob([data.challengeToken, data.action ?? '', data.code ?? '', data.recoveryCode ?? '']);
    const view = new DataView(bytes.buffer);
    writeSliceRef(view, 0, refs[0]);
    writeSliceRef(view, 8, refs[1]);
    writeSliceRef(view, 16, refs[2]);
    writeSliceRef(view, 24, refs[3]);
    view.setInt32(32, blobLength, true);
    return bytes;
}

function encodeRecoveryKeyVerifyRequest(data: RecoveryKeyVerifyRequest): Uint8Array
{
    const recoveryKey = textBytes(data.recoveryKey);
    const bytes = new Uint8Array(16 + recoveryKey.byteLength);
    const view = new DataView(bytes.buffer);
    bytes[0] = data.revokeSessions ? 1 : 0;
    bytes[1] = data.revokePasskeys ? 1 : 0;
    view.setUint16(2, 0, true);
    writeSliceRef(view, 4, { offset: 0, length: recoveryKey.byteLength });
    view.setInt32(12, recoveryKey.byteLength, true);
    bytes.set(recoveryKey, 16);
    return bytes;
}

function encodePasskeyRegisterCompleteRequest(data: PasskeyRegisterCompleteRequest): Uint8Array
{
    const rawTransports = data.attestation?.response?.transports;
    const transports = Array.isArray(rawTransports)
        ? rawTransports
        .map((value: unknown) => transportToInt(value))
        .filter((value): value is number => value !== null)
        : [];
    const { bytes, refs, blobLength } = encodeBinaryBlob(120 + transports.length * 4, [
        textBytes(data.attestation?.id ?? ''),
        base64UrlToBytes(data.attestation?.rawId ?? ''),
        base64UrlToBytes((data.attestation?.response)?.['clientData' + String.fromCharCode(74, 83, 79, 78)] ?? ''),
        base64UrlToBytes(data.attestation?.response?.attestationObject ?? ''),
        textBytes(data.friendlyName ?? ''),
        textBytes(data.mfaProofToken ?? '')
    ]);
    const view = new DataView(bytes.buffer);
    bytes[0] = data.friendlyName?.trim() ? 1 : 0;
    bytes[1] = data.mfaProofToken?.trim() ? 1 : 0;
    view.setUint16(2, 0, true);
    view.setInt32(4, transports.length, true);
    writeFixedUtf8(bytes, 8, 64, data.sessionKey);
    writeSliceRef(view, 72, refs[0]);
    writeSliceRef(view, 80, refs[1]);
    writeSliceRef(view, 88, refs[2]);
    writeSliceRef(view, 96, refs[3]);
    writeSliceRef(view, 104, refs[4]);
    writeSliceRef(view, 112, refs[5]);
    let cursor = 120;
    for (const transport of transports)
    {
        view.setInt32(cursor, transport, true);
        cursor += 4;
    }
    view.setInt32(cursor, blobLength, true);
    return bytes;
}

function encodePasskeyLoginCompleteRequest(data: PasskeyLoginCompleteRequest): Uint8Array
{
    const userHandle = data.assertion?.response?.userHandle;
    const { bytes, refs, blobLength } = encodeBinaryBlob(120, [
        textBytes(data.assertion?.id ?? ''),
        base64UrlToBytes(data.assertion?.rawId ?? ''),
        base64UrlToBytes((data.assertion?.response)?.['clientData' + String.fromCharCode(74, 83, 79, 78)] ?? ''),
        base64UrlToBytes(data.assertion?.response?.authenticatorData ?? ''),
        base64UrlToBytes(data.assertion?.response?.signature ?? ''),
    userHandle ? base64UrlToBytes(userHandle) : new Uint8Array(0)
    ]);
    const view = new DataView(bytes.buffer);
    bytes[0] = data.rememberMe ? 1 : 0;
    bytes[1] = userHandle ? 1 : 0;
    view.setUint16(2, 0, true);
    view.setInt32(4, 0, true);
    writeFixedUtf8(bytes, 8, 64, data.challengeToken);
    writeSliceRef(view, 72, refs[0]);
    writeSliceRef(view, 80, refs[1]);
    writeSliceRef(view, 88, refs[2]);
    writeSliceRef(view, 96, refs[3]);
    writeSliceRef(view, 104, refs[4]);
    writeSliceRef(view, 112, refs[5]);
    view.setInt32(120, blobLength, true);
    return bytes;
}

function encodeStringBlob(values: string[]): { bytes: Uint8Array; refs: { offset: number; length: number; }[]; blobLength: number; }
{
    const encoder = new TextEncoder();
    const parts = values.map((value) => encoder.encode(value ?? ''));
    const blobLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const headerLength = values.length === 2 ? 20 : values.length * 8;
    const bytes = new Uint8Array(headerLength + 4 + blobLength);
    const refs: { offset: number; length: number; }[] = [];
    let offset = 0;
    let cursor = headerLength + 4;
    for (const part of parts)
    {
        refs.push({ offset, length: part.byteLength });
        bytes.set(part, cursor);
        offset += part.byteLength;
        cursor += part.byteLength;
    }
    return { bytes, refs, blobLength };
}

function encodeBinaryBlob(headerLength: number, parts: Uint8Array[]): { bytes: Uint8Array; refs: { offset: number; length: number; }[]; blobLength: number; }
{
    const blobLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const bytes = new Uint8Array(headerLength + 4 + blobLength);
    const refs: { offset: number; length: number; }[] = [];
    let offset = 0;
    let cursor = headerLength + 4;
    for (const part of parts)
    {
        refs.push({ offset, length: part.byteLength });
        bytes.set(part, cursor);
        offset += part.byteLength;
        cursor += part.byteLength;
    }
    return { bytes, refs, blobLength };
}

function writeSliceRef(view: DataView, offset: number, ref: { offset: number; length: number; }): void
{
    view.setInt32(offset, ref.offset, true);
    view.setInt32(offset + 4, ref.length, true);
}

function textBytes(value: string): Uint8Array
{
    return new TextEncoder().encode(value);
}

function base64UrlToBytes(value: string): Uint8Array
{
    if (!value)
    {
        return new Uint8Array(0);
    }
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1)
    {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function transportToInt(value: unknown): number | null
{
    switch (value)
    {
        case 'usb':
            return 0;
        case 'nfc':
            return 1;
        case 'ble':
            return 2;
        case 'smart-card':
            return 3;
        case 'hybrid':
            return 4;
        case 'internal':
            return 5;
        default:
            return null;
    }
}
