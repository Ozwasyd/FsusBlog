import { requestBinaryOnly } from '@/composition/binaryTransport';
import type { TagItem, TaxonomyExactMetadata } from '@/contracts/binaryApi';

import { FrameType } from '@wasm/protocol/frame';

import {
    encodeAedsFrame,
    encodeTaxonomyMetadataMutationRequest,
    type TaxonomyMetadataMutationRequest
} from './binaryFrame';

export type { TagItem, TaxonomyExactMetadata } from '@/contracts/binaryApi';

// ================= API 方法定义 =================

/**
 * 所有方法接受可选的 config.signal，以便调用方通过 AbortSignal 中断请求。
 */

/**
 * 获取标签列表
 * 返回 TagItem[]。
 */
export const getTags = (config?: { signal?: AbortSignal; }) =>
    requestBinaryOnly<TagItem[]>({
        binaryRoute: { operationId: 'binary_get_tag_aeds' },
        frameType: FrameType.TagList,
        signal: config?.signal,
        requestOptions: {
        }
    });

export const getTagExactMetadata = (id: number, config?: { signal?: AbortSignal; }) =>
    requestBinaryOnly<TaxonomyExactMetadata>({
        binaryRoute: { operationId: 'binary_get_tag_id_int_aeds', params: { id } },
        frameType: FrameType.TaxonomyExactMetadata,
        signal: config?.signal,
        requestOptions: {
        }
    });

export const getTagExactMetadataByName = (name: string, config?: { signal?: AbortSignal; }) =>
    requestBinaryOnly<TaxonomyExactMetadata>({
        binaryRoute: {
            operationId: 'binary_get_tag_by_name_aeds',
            query: new URLSearchParams({ name })
        },
        frameType: FrameType.TaxonomyExactMetadata,
        signal: config?.signal,
        requestOptions: {
        }
    });

/**
 * 创建标签
 * 创建请求必须携带 PoW 证明。
 */
export const createTag = (request: string | TaxonomyMetadataMutationRequest, config?: RequestInit) =>
    requestBinaryOnly<{ id: number; }>({
        binaryRoute: { operationId: 'binary_post_tag' },
        frameType: FrameType.MutationId,
        signal: config?.signal as AbortSignal | undefined,
        requestOptions: {
            ...config,
            body: encodeAedsFrame(FrameType.TagWriteRequest, encodeTaxonomyMetadataMutationRequest(toMetadataRequest(request)))
        }
    });

/**
 * 更新标签
 * 安全性保障：强制算力挑战，确保操作出自真实的管理员交互
 */
export const updateTag = (id: number, request: string | TaxonomyMetadataMutationRequest, config?: RequestInit) =>
    requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_put_tag_id_int', params: { id } },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal as AbortSignal | undefined,
        requestOptions: {
            ...config,
            body: encodeAedsFrame(FrameType.TagWriteRequest, encodeTaxonomyMetadataMutationRequest(toMetadataRequest(request)))
        }
    });

/**
 * 删除标签
 * 删除请求必须携带 PoW 证明。
 */
export const deleteTag = (id: number, config?: RequestInit) =>
    requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_delete_tag_id_int', params: { id } },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal as AbortSignal | undefined,
        requestOptions: {
            ...config,
        }
    });

function toMetadataRequest(request: string | TaxonomyMetadataMutationRequest): TaxonomyMetadataMutationRequest
{
    return typeof request === 'string' ? { name: request, description: null } : request;
}
