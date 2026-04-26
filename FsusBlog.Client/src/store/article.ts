import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getArticleById, type ArticleDetailResponse } from '@/api/article';

const STORAGE_KEY = 'fsus.transport.binary';

function readBinaryFlag(): boolean {
  if (typeof localStorage === 'undefined') {
    return true;
  }

  return localStorage.getItem(STORAGE_KEY) !== '0';
}

function writeBinaryFlag(enabled: boolean): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
}

export const useArticleBinaryStore = defineStore('article-binary', () => {
  const useBinary = ref(readBinaryFlag());

  const fetchArticleById = async (id: number, signal?: AbortSignal): Promise<ArticleDetailResponse> => {
    return await getArticleById(id, signal ? { signal } : undefined);
  };

  return {
    useBinary,
    fetchArticleById
  };
});
