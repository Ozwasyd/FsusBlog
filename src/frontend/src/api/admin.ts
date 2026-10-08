import { requestBinaryOnly } from '@/composition/binaryTransport';
import type { AdminAccountListItem, PageResult } from '@/contracts/binaryApi';

import { FrameType } from '@wasm/protocol/frame';

import { encodeAedsFrame } from './binaryFrame';

import type { ApiRequestConfig } from './requestConfig';

export type { AdminAccountListItem, PageResult } from '@/contracts/binaryApi';

/** Governance-visible anonymous account contract surface (mirrors AdminAccountListItem fields). */
export interface AdminAnonymousAccountApiContract {
    accountId: number;
    identityKind: string;
    publicHandle?: string;
    passkeyInitialized: boolean;
    recoveryInitialized: boolean;
    anonymousCredentialStatus: string;
    riskFlags: number;
}

const ADMIN_SENSITIVE_MFA_HEADER = 'X-Fsus-Mfa-Proof';

// ================= 类型定义 =================

/**
 * 查询参数
 * 对应后端: UserQueryDto
 */
export interface UserQueryDto {
    page: number;
    pageSize: number;
    keyword?: string;
    status?: number;
}

/**
 * PoW 基础字段 (高危操作通用)
 * 对应后端: PoW 请求契约
 */
interface PowBaseDto {
    powSalt?: string;
    powSignature?: string;
    powTimestamp?: number;
    difficulty?: number;
    powNonce?: string;
    browserFp?: string;
}

/**
 * 封禁/解封参数
 * 对应后端: AdminChangeStatusDto
 */
export interface AdminChangeStatusDto extends PowBaseDto {
    accountId: number;
    status: 0 | 1; // 1: 禁用, 0: 启用
    reason?: string; // 封禁理由
}

// ================= API 方法定义 =================

/**
 * 所有方法接受可选的 config.signal，以便调用方通过 AbortSignal 中断请求。
 */

/**
 * 获取匿名账号列表
 * 逻辑：解码 AEDS 二进制分页载荷，返回 PageResult
 */
export const getAdminUserList = async (
    params: UserQueryDto,
    config?: ApiRequestConfig
): Promise<PageResult<AdminAccountListItem>> =>
{
    const search = new URLSearchParams();
    search.set('page', String(params.page));
    search.set('pageSize', String(params.pageSize));
    if (params.keyword)
    {
        search.set('keyword', params.keyword);
    }
    if (params.status !== undefined)
    {
        search.set('status', String(params.status));
    }

    return requestBinaryOnly<PageResult<AdminAccountListItem>>({
        binaryRoute: { operationId: 'binary_get_admin_users', query: search },
        frameType: FrameType.AdminUserList,
        signal: config?.signal
    });
};

/**
 * 封禁/解封匿名账号
 * 安全性保障：标记为 requiresPow，拦截器将自动处理算力注入
 */
export const adminChangeStatus = async (
    data: AdminChangeStatusDto,
    config?: ApiRequestConfig
) =>
{
    return requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_put_admin_users_status' },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
            headers: adminHeaders(config?.mfaProofToken),
            body: encodeAedsFrame(FrameType.AdminChangeUserStatusRequest, encodeAdminChangeStatusRequest(data))
        }
    });
};

function adminHeaders(mfaProofToken?: string | null): Headers | undefined
{
    const proofToken = mfaProofToken?.trim();
    if (!proofToken)
    {
        return undefined;
    }

    const headers = new Headers();
    headers.set(ADMIN_SENSITIVE_MFA_HEADER, proofToken);
    return headers;
}

function encodeAdminChangeStatusRequest(data: AdminChangeStatusDto): Uint8Array
{
    const reason = new TextEncoder().encode(data.reason ?? '');
    const bytes = new Uint8Array(16 + 4 + reason.byteLength);
    const view = new DataView(bytes.buffer);
    // POD offset 0 stores the anonymous account id.
    view.setInt32(0, data.accountId, true);
    view.setInt32(4, data.status, true);
    view.setInt32(8, 0, true);
    view.setInt32(12, reason.byteLength, true);
    view.setInt32(16, reason.byteLength, true);
    bytes.set(reason, 20);
    return bytes;
}
