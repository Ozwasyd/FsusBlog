import { requestBinaryOnly } from '@/composition/binaryTransport';
import type { CategoryItem } from '@/contracts/binaryApi';

import { FrameType } from '@wasm/protocol/frame';

import {
    encodeAedsFrame,
    encodeTaxonomyMetadataMutationRequest,
    type TaxonomyMetadataMutationRequest
} from './binaryFrame';

export type { CategoryItem } from '@/contracts/binaryApi';

// ================= API 方法定义 =================

/**
 * 所有方法接受可选的 config.signal，以便调用方通过 AbortSignal 中断请求。
 */

/**
 * 获取分类列表
 * 返回 CategoryItem[]。
 */
export const getCategories = (config?: { signal?: AbortSignal; }) =>
    requestBinaryOnly<CategoryItem[]>({
        binaryRoute: { operationId: 'binary_get_category_aeds' },
        frameType: FrameType.CategoryList,
        signal: config?.signal,
        requestOptions: {
            method: 'GET'
        }
    });

/**
 * 创建分类
 * 安全性保障：接入 PoW 算力校验，防止针对管理接口的自动化撞库或 CSRF 批量篡改
 */
export const createCategory = (request: string | TaxonomyMetadataMutationRequest, config?: RequestInit) =>
    requestBinaryOnly<{ id: number; }>({
        binaryRoute: { operationId: 'binary_post_category' },
        frameType: FrameType.MutationId,
        signal: config?.signal as AbortSignal | undefined,
        requestOptions: {
            ...config,
            method: 'POST',
            requiresPow: true,
            body: encodeAedsFrame(FrameType.CategoryWriteRequest, encodeTaxonomyMetadataMutationRequest(toMetadataRequest(request)))
        }
    });

/**
 * 更新分类
 * 安全性保障：强制要求算力证明，确保操作出自真实的管理员交互
 */
export const updateCategory = (id: number, request: string | TaxonomyMetadataMutationRequest, config?: RequestInit) =>
    requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_put_category_id_int', params: { id } },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal as AbortSignal | undefined,
        requestOptions: {
            ...config,
            method: 'PUT',
            requiresPow: true,
            body: encodeAedsFrame(FrameType.CategoryWriteRequest, encodeTaxonomyMetadataMutationRequest(toMetadataRequest(request)))
        }
    });

/**
 * 删除分类
 * 删除请求必须携带 PoW 证明。
 */
export const deleteCategory = (id: number, config?: RequestInit) =>
    requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_delete_category_id_int', params: { id } },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal as AbortSignal | undefined,
        requestOptions: {
            ...config,
            method: 'DELETE',
            requiresPow: true
        }
    });

function toMetadataRequest(request: string | TaxonomyMetadataMutationRequest): TaxonomyMetadataMutationRequest
{
    return typeof request === 'string' ? { name: request, description: null } : request;
}
