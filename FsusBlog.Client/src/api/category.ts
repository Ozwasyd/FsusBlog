// src/api/category.ts
import api from './index'

export interface CategoryItem {
  id: number
  name: string
  articleCount: number
}

export const getCategories = () => api.get<any[]>('/Category')
export const createCategory = (name: string) => api.post('/Category', { name })
export const updateCategory = (id: number, name: string) => api.put(`/Category/${id}`, { name })
export const deleteCategory = (id: number) => api.delete(`/Category/${id}`)