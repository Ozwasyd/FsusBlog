import type { AxiosRequestConfig } from 'axios';
import api from './index'
import { FrameType } from '@wasm/protocol/frame';
import { requestBinaryOnly } from '@/services/binaryTransport';
import type { PublicAotShellBundleContract } from '@/helpers/publicAotBundle';

// ================= 基础类型 =================

/** 标签 DTO */
export interface Tag {
  id: number
  name: string
}

/** 
 * 文章列表项 (对应后端 ArticleListDto)
 * 修复日期: 2026-02-23 (对齐嵌套 category 结构)
 */
export interface ArticleListItem {
  id: number;
  title: string;
  summary: string; 
  snippet?: string;
  views: number;
  createTime: string; // 后端 UTC 字符串
  category: {
    id: number;
    name: string;
  };
  tags: Tag[];
}

/** 
 * 文章详情 (对应后端 ArticleDetailDto)
 * 修复日期: 2026-02-23 (补全 categoryId 字段)
 */
export interface ArticleDetail {
  id: number;
  title: string;
  content: string;
  summary: string;
  categoryId: number;
  views: number;
  createTime: string; // 后端 UTC 字符串
  category?: { 
    id: number; 
    name: string; 
  };
  tags: Tag[];
}

/** 分页包裹对象 */
export interface ArticleListRes {
  items: ArticleListItem[]
  total: number
}

/** 搜索请求参数 (合并业务关键字与 PoW 凭证) */
export interface SearchArticlesParams {
  keyword: string
}

export interface ArticleWriteRequest {
  title: string
  content: string
  summary: string
  categoryId: number | undefined
  tagIds: number[]
  aotBundle?: PublicAotShellBundleContract | null
}

// ================= API 方法 =================

/**
 * [修复 2026-02-23] 逻辑自洽：所有方法增加可选的 config 参数以支持物理中断 (AbortSignal)
 */

/** 获取文章列表 */
export const getArticles = (
  params: { page?: number; size?: number; categoryId?: number; tagId?: number },
  config?: AxiosRequestConfig
) => {
  const normalized = {
    page: params.page ?? 1,
    size: params.size ?? 10,
    categoryId: params.categoryId,
    tagId: params.tagId,
    isDeleted: false
  };

  const search = new URLSearchParams();
  search.set('page', String(normalized.page));
  search.set('size', String(normalized.size));
  search.set('isDeleted', String(normalized.isDeleted));
  if (normalized.categoryId !== undefined) search.set('categoryId', String(normalized.categoryId));
  if (normalized.tagId !== undefined) search.set('tagId', String(normalized.tagId));

  return requestBinaryOnly<ArticleListRes>({
    binaryUrl: `/api/binary/article?${search.toString()}`,
    frameType: FrameType.ArticleList,
    renderHtml: true,
    renderContext: {
      currentPage: normalized.page,
      pageSize: normalized.size
    },
    signal: config?.signal as AbortSignal | undefined
  });
}

/** 获取详情 */
export const getArticleById = (id: number, config?: AxiosRequestConfig) => {
  return requestBinaryOnly<ArticleDetail>({
    binaryUrl: `/api/binary/article/${id}`,
    frameType: FrameType.ArticleDetail,
    renderHtml: true,
    signal: config?.signal as AbortSignal | undefined
  });
}

/** 
 * 全站搜索接口 
 * [修复 2026-02-23] 安全性保障：启用 requiresPow 策略。
 * 拦截器将自动计算算力并将证明注入 X-Fsus-Pow-Proof 请求头。
 */
export const searchArticles = (params: SearchArticlesParams, config?: AxiosRequestConfig) => {
  const search = new URLSearchParams();
  search.set('keyword', params.keyword);
  return requestBinaryOnly<ArticleListItem[]>({
    binaryUrl: `/api/binary/article/search?${search.toString()}`,
    frameType: FrameType.ArticleSearch,
    signal: config?.signal as AbortSignal | undefined
  });
}

/** 热门排行 */
export const getHotArticles = (size = 10, config?: AxiosRequestConfig) => {
  return requestBinaryOnly<ArticleListItem[]>({
    binaryUrl: `/api/binary/article/hot?size=${size}`,
    frameType: FrameType.ArticleHot,
    signal: config?.signal as AbortSignal | undefined
  });
}

// ================= 管理端 =================

/** 
 * 创建文章
 * [修复 2026-02-23] 安全性保障：强制算力校验，防止自动化垃圾投稿攻击
 */
export const createArticle = (data: ArticleWriteRequest, config?: AxiosRequestConfig) => 
  api.post<{ id: number }>('/Article', data, { 
    ...config, 
    requiresPow: true 
  } as AxiosRequestConfig)

/** 
 * 更新文章
 */
export const updateArticle = (id: number, data: ArticleWriteRequest, config?: AxiosRequestConfig) => 
  api.put<{ id: number }>(`/Article/${id}`, data, { 
    ...config, 
    requiresPow: true 
  } as AxiosRequestConfig)

export const uploadArticleAotBundle = (
  id: number,
  bundle: PublicAotShellBundleContract,
  config?: AxiosRequestConfig
) =>
  api.post(`/Article/${id}/aot-bundle`, bundle, {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)

export const deleteArticle = (id: number, config?: AxiosRequestConfig) => 
  api.delete(`/Article/${id}`, config)

export const restoreArticle = (id: number, config?: AxiosRequestConfig) => 
  api.put(`/Article/restore/${id}`, {}, config)

export const permanentDeleteArticle = (id: number, config?: AxiosRequestConfig) => 
  api.delete(`/Article/permanent/${id}`, config)
