import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getArticleById, type ArticleDetail } from '@/api/article';

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

  const fetchArticleById = async (id: number, signal?: AbortSignal): Promise<ArticleDetail> => {
    return await getArticleById(id, signal ? { signal } : undefined);
  };

  const handleAotAction = (action: string): void => {
    if (action === 'force-json') {
      useBinary.value = false;
      writeBinaryFlag(false);
      return;
    }

    if (action === 'force-binary') {
      useBinary.value = true;
      writeBinaryFlag(true);
    }
  };

  return {
    useBinary,
    fetchArticleById,
    handleAotAction
  };
});
