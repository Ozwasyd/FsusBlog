import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/services/binaryTransport'
import { encodeAedsFrame, encodeNameMutationRequest } from './binaryFrame'

// 定义标签数据结构
export interface TagItem {
  id: number
  name: string
  articleCount: number // 对应后端统计的文章数量
}

// ================= API 方法定义 =================

/**
 * [修复 2026-02-23] 逻辑自洽：所有方法增加可选的 config 参数以支持 AbortSignal 物理中断
 */

/**
 * 获取标签列表
 * [修复 2026-02-23] 类型安全：将返回类型由 any[] 收敛为具体的 TagItem[]
 */
export const getTags = (config?: { signal?: AbortSignal }) =>
  requestBinaryOnly<TagItem[]>({
    binaryUrl: '/api/binary/tag.aeds',
    frameType: FrameType.TagList,
    signal: config?.signal,
    requestOptions: {
      method: 'GET'
    }
  })

/**
 * 创建标签
 * 安全性保障：接入 PoW 算力校验，物理隔离针对管理接口的自动化探测或批量篡改攻击
 */
export const createTag = (name: string, config?: RequestInit) =>
  requestBinaryOnly<{ id: number }>({
    binaryUrl: '/api/binary/tag',
    frameType: FrameType.MutationId,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      ...config,
      method: 'POST',
      requiresPow: true,
      body: encodeAedsFrame(FrameType.TagWriteRequest, encodeNameMutationRequest(name))
    }
  })

/**
 * 更新标签
 * 安全性保障：强制算力挑战，确保操作出自真实的管理员交互
 */
export const updateTag = (id: number, name: string, config?: RequestInit) =>
  requestBinaryOnly<null>({
    binaryUrl: `/api/binary/tag/${id}`,
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      ...config,
      method: 'PUT',
      requiresPow: true,
      body: encodeAedsFrame(FrameType.TagWriteRequest, encodeNameMutationRequest(name))
    }
  })

/**
 * 删除标签
 * [修复 2026-02-23] 逻辑自洽：物理删除风险操作强制接入 PoW 保护
 */
export const deleteTag = (id: number, config?: RequestInit) =>
  requestBinaryOnly<null>({
    binaryUrl: `/api/binary/tag/${id}`,
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      ...config,
      method: 'DELETE',
      requiresPow: true
    }
  })
