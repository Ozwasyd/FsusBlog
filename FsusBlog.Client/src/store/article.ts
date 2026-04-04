import { defineStore } from 'pinia';
import { ref } from 'vue';
import { binaryRequest } from '@/api/binaryApiClient';
import { getArticleById, type ArticleDetail } from '@/api/article';

interface DecodeResponse {
  requestId: number;
  ok: boolean;
  article?: ArticleDetail;
  error?: string;
}

let workerSingleton: Worker | null = null;
let requestSeq = 0;

function getWorker(): Worker {
  if (!workerSingleton) {
    workerSingleton = new Worker(new URL('../workers/wasmDecode.worker.ts', import.meta.url), { type: 'module' });
  }

  return workerSingleton;
}

function decodeArticleByWorker(buffer: ArrayBuffer): Promise<ArticleDetail> {
  const worker = getWorker();
  requestSeq += 1;
  const requestId = requestSeq;

  return new Promise<ArticleDetail>((resolve, reject) => {
    const listener = (event: MessageEvent<DecodeResponse>) => {
      const message = event.data;
      if (message.requestId !== requestId) {
        return;
      }

      worker.removeEventListener('message', listener);
      if (!message.ok || !message.article) {
        reject(new Error(message.error ?? 'worker_decode_failed'));
        return;
      }

      resolve(message.article);
    };

    worker.addEventListener('message', listener);
    worker.postMessage({ requestId, buffer }, [buffer]);
  });
}

export const useArticleBinaryStore = defineStore('article-binary', () => {
  const useBinary = ref(true);

  const fetchArticleById = async (id: number, signal?: AbortSignal): Promise<ArticleDetail> => {
    if (useBinary.value) {
      try {
        const buffer = await binaryRequest(`/api/binary/article/${id}`, { signal });
        return await decodeArticleByWorker(buffer);
      } catch {
        useBinary.value = false;
      }
    }

    return await getArticleById(id, signal ? { signal } : undefined);
  };

  const handleAotAction = (action: string): void => {
    if (action === 'force-json') {
      useBinary.value = false;
      return;
    }

    if (action === 'force-binary') {
      useBinary.value = true;
    }
  };

  return {
    useBinary,
    fetchArticleById,
    handleAotAction
  };
});
