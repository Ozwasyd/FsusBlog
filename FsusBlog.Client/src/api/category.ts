import type { AxiosRequestConfig } from 'axios';
import api from './index'

export interface CategoryItem {
  id: number
  name: string
  articleCount: number
}

// ================= API 方法定义 =================

/**
 * [修复 2026-02-23] 逻辑自洽：所有方法增加可选的 config 参数以支持 AbortSignal 物理中断
 */

/** 
 * 获取分类列表 
 * [修复 2026-02-23] 类型安全：将返回类型由 any[] 收敛为具体的 CategoryItem[]
 */
export const getCategories = (config?: AxiosRequestConfig) => 
  api.get<CategoryItem[]>('/Category', config)

/** 
 * 创建分类
 * 安全性保障：接入 PoW 算力校验，防止针对管理接口的自动化撞库或 CSRF 批量篡改
 */
export const createCategory = (name: string, config?: AxiosRequestConfig) => 
  api.post('/Category', { name }, { 
    ...config, 
    requiresPow: true 
  } as AxiosRequestConfig)

/** 
 * 更新分类
 * 安全性保障：强制要求算力证明，确保操作出自真实的管理员交互
 */
export const updateCategory = (id: number, name: string, config?: AxiosRequestConfig) => 
  api.put(`/Category/${id}`, { name }, { 
    ...config, 
    requiresPow: true 
  } as AxiosRequestConfig)

/**
 * 删除分类
 * [修复 2026-02-23] 逻辑自洽：删除操作同样接入 PoW 保护，防止恶意删库
 */
export const deleteCategory = (id: number, config?: AxiosRequestConfig) => 
  api.delete(`/Category/${id}`, { 
    ...config, 
    requiresPow: true 
  } as AxiosRequestConfig)