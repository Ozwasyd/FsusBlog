import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/composition/binaryTransport'
import type { TagItem } from '@/contracts/binaryApi'
import {
  encodeAedsFrame,
  encodeTaxonomyMetadataMutationRequest,
  type TaxonomyMetadataMutationRequest
} from './binaryFrame'

export type { TagItem } from '@/contracts/binaryApi'

// ================= API 方法定义 =================

/**
 * 所有方法接受可选的 config.signal，以便调用方通过 AbortSignal 中断请求。
 */

/**
 * 获取标签列表
 * 返回 TagItem[]。
 */
export const getTags = (config?: { signal?: AbortSignal }) =>
  requestBinaryOnly<TagItem[]>({
    binaryRoute: { operationId: 'binary_get_tag_aeds' },
    frameType: FrameType.TagList,
    signal: config?.signal,
    requestOptions: {
      method: 'GET'
    }
  })

/**
 * 创建标签
 * 创建请求必须携带 PoW 证明。
 */
export const createTag = (request: string | TaxonomyMetadataMutationRequest, config?: RequestInit) =>
  requestBinaryOnly<{ id: number }>({
    binaryRoute: { operationId: 'binary_post_tag' },
    frameType: FrameType.MutationId,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      ...config,
      method: 'POST',
      requiresPow: true,
      body: encodeAedsFrame(FrameType.TagWriteRequest, encodeTaxonomyMetadataMutationRequest(toMetadataRequest(request)))
    }
  })

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
      method: 'PUT',
      requiresPow: true,
      body: encodeAedsFrame(FrameType.TagWriteRequest, encodeTaxonomyMetadataMutationRequest(toMetadataRequest(request)))
    }
  })

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
      method: 'DELETE',
      requiresPow: true
    }
  })

function toMetadataRequest(request: string | TaxonomyMetadataMutationRequest): TaxonomyMetadataMutationRequest {
  return typeof request === 'string' ? { name: request, description: null } : request
}
