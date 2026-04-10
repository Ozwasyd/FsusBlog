<template>
  <section :class="themeTokens.articleDetail.commentsRoot">
    <h3 :class="themeTokens.articleDetail.commentsHeading">{{ headingText }}</h3>

    <div v-if="loading" :class="themeTokens.articleDetail.commentsPlaceholderRoot">
      <p :class="themeTokens.articleDetail.commentsPlaceholderTitle">评论加载中</p>
      <p :class="themeTokens.articleDetail.commentsPlaceholderBody">正在静默激活评论岛。</p>
    </div>

    <div v-else-if="hasLoadError" :class="themeTokens.articleDetail.commentsPlaceholderRoot">
      <p :class="themeTokens.articleDetail.commentsPlaceholderTitle">评论暂时不可用</p>
      <p :class="themeTokens.articleDetail.commentsPlaceholderBody">评论岛激活失败，请稍后刷新重试。</p>
    </div>

    <div v-else-if="comments.length === 0" :class="themeTokens.articleDetail.commentsPlaceholderRoot">
      <p :class="themeTokens.articleDetail.commentsPlaceholderTitle">暂无评论</p>
      <p :class="themeTokens.articleDetail.commentsPlaceholderBody">第一条评论会在这里出现。</p>
    </div>

    <div v-else class="space-y-8" aria-live="polite">
      <article v-for="comment in comments" :key="comment.id" class="border-t border-zinc-100 pt-6 first:border-t-0 first:pt-0">
        <div class="flex items-center justify-between gap-4 mb-3">
          <strong class="text-sm font-semibold text-zinc-900">{{ comment.userName }}</strong>
          <time class="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-400">{{ comment.createTime }}</time>
        </div>
        <p class="text-sm leading-relaxed whitespace-pre-wrap text-zinc-700">{{ comment.content }}</p>
      </article>

      <button
        v-if="hasMore"
        type="button"
        :class="themeTokens.articleList.paginationButton"
        :disabled="loadingMore"
        @click="loadMore"
      >
        {{ loadingMore ? '加载中' : '加载更多' }}
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getComments, type CommentItem } from '@/api/comment';
import { themeTokens } from '@/ui-tokens/themeTokens';

const props = defineProps<{ articleId: number | string }>();

const comments = ref<CommentItem[]>([]);
const cursor = ref<string | null>(null);
const hasMore = ref(false);
const loading = ref(true);
const loadingMore = ref(false);
const hasLoadError = ref(false);

const headingText = computed(() => comments.value.length > 0 ? `评论 (${comments.value.length}${hasMore.value ? '+' : ''})` : '评论');
const normalizedArticleId = computed(() => {
  const value = Number(props.articleId);
  return Number.isFinite(value) && value > 0 ? value : null;
});

async function fetchPage(next?: string | null): Promise<void> {
  const articleId = normalizedArticleId.value;
  if (articleId === null) {
    hasLoadError.value = true;
    return;
  }

  const response = await getComments(articleId, next ?? null, 10);
  comments.value = next ? [...comments.value, ...response.data] : response.data;
  cursor.value = response.nextCursor;
  hasMore.value = response.hasMore;
  hasLoadError.value = false;
}

async function loadMore(): Promise<void> {
  if (!hasMore.value || loadingMore.value) {
    return;
  }

  loadingMore.value = true;
  try {
    await fetchPage(cursor.value);
  } catch {
    hasLoadError.value = true;
  } finally {
    loadingMore.value = false;
  }
}

onMounted(async () => {
  try {
    await fetchPage(null);
  } catch {
    hasLoadError.value = true;
  } finally {
    loading.value = false;
  }
});
</script>
