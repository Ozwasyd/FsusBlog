// src/api/tag.ts
import api from './index'

// 定义标签数据结构
export interface TagItem {
  id: number
  name: string
  articleCount: number // 对应后端统计的文章数量
}

export const getTags = () => api.get<any[]>('/Tag')
export const createTag = (name: string) => api.post('/Tag', { name })
export const updateTag = (id: number, name: string) => api.put(`/Tag/${id}`, { name })
export const deleteTag = (id: number) => api.delete(`/Tag/${id}`)