import type { ApiRequestConfig } from './requestConfig'
import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/services/binaryTransport'
import { encodeAedsFrame, encodeStringMutationRequest, writeFixedUtf8 } from './binaryFrame'

export interface SeoConfigPublic {
  title: string       // 网站标题 (例如: "Fsu's Blog")
  description: string // 网站描述 (Meta Description)
  keywords: string    // 关键词
  author: string      // 作者名
  ogImage: string     // 社交分享封面图 URL
  baseUrl : string    // URL
}

export interface SeoConfigAdmin {
  title: string
  description: string
  keywords: string
  author: string
  ogImage: string
  baseUrl: string
}

export interface PageContentPublic {
  slug: string        // 页面唯一标识 (例如: 'about' 或 'privacy')
  content: string     // Markdown 格式的内容文本
}

export interface PageContentAdmin {
  slug: string
  content: string
}

/**
 * [修复 2026-02-23] 逻辑自洽：所有 API 方法增加可选的 config 参数
 * 物理真相：为了支持 AbortController 抢占机制，必须允许外部传入 signal
 */

// 站点 SEO 配置
export const getSiteConfig = (config?: ApiRequestConfig) =>
  requestBinaryOnly<SeoConfigPublic>({
    binaryUrl: '/api/binary/system/seo',
    frameType: FrameType.SeoConfig,
    signal: config?.signal as AbortSignal | undefined
  })

export const getAdminSiteConfig = (config?: ApiRequestConfig) =>
  requestBinaryOnly<SeoConfigAdmin>({
    binaryUrl: '/api/binary/system/admin/seo',
    frameType: FrameType.SeoConfig,
    signal: config?.signal as AbortSignal | undefined
  })

/**
 * 更新站点配置
 * 安全性保障：接入 PoW 算力校验，物理隔离针对全站元数据的恶意篡改尝试
 */
export const updateSiteConfig = (data: SeoConfigAdmin, config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryUrl: '/api/binary/system/seo',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'PUT',
      requiresPow: true,
      body: encodeAedsFrame(FrameType.SeoConfigUpdateRequest, encodeSeoConfigPayload(data))
    }
  })

// ================= 动态页面管理 =================

// 动态页面内容
export const getPageData = (slug: string, config?: ApiRequestConfig) =>
  requestBinaryOnly<PageContentPublic>({
    binaryUrl: `/api/binary/system/page/${encodeURIComponent(slug)}`,
    frameType: FrameType.PageContent,
    signal: config?.signal as AbortSignal | undefined
  })

export const getAdminPageData = (slug: string, config?: ApiRequestConfig) =>
  requestBinaryOnly<PageContentAdmin>({
    binaryUrl: `/api/binary/system/admin/page/${encodeURIComponent(slug)}`,
    frameType: FrameType.PageContent,
    signal: config?.signal as AbortSignal | undefined
  })

/**
 * 更新动态页面
 * 安全性保障：防止自动化脚本利用管理权限进行大规模的 SEO 垃圾信息注入
 */
export const updatePageData = (data: PageContentAdmin, config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryUrl: '/api/binary/system/page',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'PUT',
      requiresPow: true,
      body: encodeAedsFrame(FrameType.PageContentUpdateRequest, encodePageContentPayload(data))
    }
  })

export const refreshPageData = (slug: string, config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryUrl: `/api/binary/system/page/refresh/${encodeURIComponent(slug)}`,
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      requiresPow: true
    }
  })

/**
 * 删除文件
 * 安全性保障：物理删除操作接入 PoW 保护，杜绝自动化脚本批量抹除服务器资源
 */
export const deleteImage = (url: string, config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryUrl: '/api/binary/file/delete',
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'DELETE',
      requiresPow: true,
      body: encodeAedsFrame(FrameType.FileDeleteRequest, encodeStringMutationRequest(url))
    }
  })

function encodeSeoConfigPayload(data: SeoConfigAdmin): Uint8Array {
  const description = new TextEncoder().encode(data.description ?? '')
  const bytes = new Uint8Array(1096 + 4 + description.byteLength)
  writeFixedUtf8(bytes, 0, 256, data.title ?? '')
  writeInt32(bytes, 256, 0)
  writeInt32(bytes, 260, description.byteLength)
  writeFixedUtf8(bytes, 264, 256, data.keywords ?? '')
  writeFixedUtf8(bytes, 520, 64, data.author ?? '')
  writeFixedUtf8(bytes, 584, 256, data.ogImage ?? '')
  writeFixedUtf8(bytes, 840, 256, data.baseUrl ?? '')
  writeInt32(bytes, 1096, description.byteLength)
  bytes.set(description, 1100)
  return bytes
}

function encodePageContentPayload(data: PageContentAdmin): Uint8Array {
  const content = new TextEncoder().encode(data.content ?? '')
  const bytes = new Uint8Array(136 + 4 + content.byteLength)
  writeFixedUtf8(bytes, 0, 128, data.slug ?? '')
  writeInt32(bytes, 128, 0)
  writeInt32(bytes, 132, content.byteLength)
  writeInt32(bytes, 136, content.byteLength)
  bytes.set(content, 140)
  return bytes
}

function writeInt32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setInt32(offset, value, true)
}
