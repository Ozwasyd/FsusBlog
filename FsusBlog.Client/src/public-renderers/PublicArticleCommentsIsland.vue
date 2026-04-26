<template>
  <section class="min-h-0" aria-live="polite">
    <template v-if="!loading && !hasLoadError && comments.length > 0">
      <h3 :class="themeTokens.articleDetail.commentsHeading">{{ headingText }}</h3>

      <div class="space-y-8">
      <article v-for="comment in comments" :key="comment.id" class="border-t border-[#F4F4F5] pt-6 first:border-t-0 first:pt-0">
        <div class="flex items-center justify-between gap-6 mb-3">
          <strong class="text-sm font-semibold text-[#18181B]">{{ comment.userName }}</strong>
          <time class="text-[10px] font-mono uppercase text-[#A1A1AA]">{{ comment.createTime }}</time>
        </div>
        <p class="text-sm leading-relaxed whitespace-pre-wrap text-[#3F3F46]">{{ comment.content }}</p>
        <div v-if="comment.repliesPreview.length > 0" class="mt-3 border-l border-[#E4E4E7] pl-3 space-y-2">
          <div v-for="reply in comment.repliesPreview" :key="reply.id" class="text-sm text-[#71717A]">
            <strong class="text-[#27272A]">{{ reply.userName }}</strong>
            <span v-if="reply.replyToUserName"> 回复 @{{ reply.replyToUserName }}</span>
            ：{{ reply.content }}
          </div>
        </div>
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
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getComments, type CommentThreadItem } from '@/api/comment';
import { themeTokens } from '@/ui-tokens/themeTokens';

const props = defineProps<{ articleId: number | string }>();

const comments = ref<CommentThreadItem[]>([]);
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
