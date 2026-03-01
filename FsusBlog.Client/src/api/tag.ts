import type { AxiosRequestConfig } from 'axios'
import api from './index'

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
export const getTags = (config?: AxiosRequestConfig) => 
  api.get<TagItem[]>('/Tag', config)

/** 
 * 创建标签
 * 安全性保障：接入 PoW 算力校验，物理隔离针对管理接口的自动化探测或批量篡改攻击
 */
export const createTag = (name: string, config?: AxiosRequestConfig) => 
  api.post('/Tag', { name }, { 
    ...config, 
    requiresPow: true 
  } as AxiosRequestConfig)

/** 
 * 更新标签
 * 安全性保障：强制算力挑战，确保操作出自真实的管理员交互
 */
export const updateTag = (id: number, name: string, config?: AxiosRequestConfig) => 
  api.put(`/Tag/${id}`, { name }, { 
    ...config, 
    requiresPow: true 
  } as AxiosRequestConfig)

/**
 * 删除标签
 * [修复 2026-02-23] 逻辑自洽：物理删除风险操作强制接入 PoW 保护
 */
export const deleteTag = (id: number, config?: AxiosRequestConfig) => 
  api.delete(`/Tag/${id}`, { 
    ...config, 
    requiresPow: true 
  } as AxiosRequestConfig)