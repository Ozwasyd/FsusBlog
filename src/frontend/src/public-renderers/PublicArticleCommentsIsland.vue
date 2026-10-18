<template>
    <section
        class="min-h-0"
        aria-live="polite"
    >
        <template v-if="!loading && !hasLoadError && comments.length > 0">
            <h3 :class="themeTokens.articleDetail.commentsHeading">{{ headingText }}</h3>

            <div class="space-y-8">
                <article
                    v-for="comment in visibleComments"
                    :key="comment.id"
                    class="border-t border-[var(--fsusblog-panel-border)] pt-6 first:border-t-0 first:pt-0"
                    v-memo="[comment.id, comment.content, comment.author.displayName, comment.repliesPreview.length]"
                >
                    <div class="flex items-center justify-between gap-6 mb-3">
                        <strong class="text-sm font-medium text-[var(--fsusblog-text-primary)]">{{ comment.author.displayName }}</strong>
                        <time class="text-xs leading-4 tabular-nums normal-case text-[var(--fsusblog-text-muted)]">{{ comment.createTime }}</time>
                    </div>
                    <p class="text-sm leading-relaxed whitespace-pre-wrap text-[var(--fsusblog-text-secondary)]">{{ comment.content }}</p>
                    <div
                        v-if="comment.repliesPreview.length > 0"
                        class="mt-3 border-l border-[var(--fsusblog-panel-border)] pl-3 space-y-2"
                    >
                        <div
                            v-for="reply in comment.repliesPreview"
                            :key="reply.id"
                            class="text-sm text-[var(--fsusblog-text-tertiary)]"
                            v-memo="[reply.id, reply.content, reply.author.displayName]"
                        >
                            <strong class="text-[var(--fsusblog-text-secondary)]">{{ reply.author.displayName }}</strong>
                            <span v-if="reply.replyToAuthor"> 回复 @{{ reply.replyToAuthor?.displayName }}</span>
                            ：{{ reply.content }}
                        </div>
                    </div>
                </article>

                <ElButton
                    v-if="hasMore || hasHiddenRenderedComments"
                    link
                    type="primary"
                    :disabled="loadingMore"
                    @click="showMoreOrLoad"
                >
                    {{ loadingMore ? '加载中' : hasHiddenRenderedComments ? `显示更多评论（${hiddenRenderedCommentCount}）` : '加载更多' }}
                </ElButton>
            </div>
        </template>
    </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { getComments, type CommentThreadItem } from '@/api/comment';
import { themeTokens } from '@/ui-tokens/themeTokens';

const props = defineProps<{ articleId: number | string; }>();

const comments = ref<CommentThreadItem[]>([]);
const visibleRootLimit = ref(5);
const cursor = ref<string | null>(null);
const hasMore = ref(false);
const loading = ref(true);
const loadingMore = ref(false);
const hasLoadError = ref(false);

const headingText = computed(() => comments.value.length > 0 ? `评论 (${comments.value.length}${hasMore.value ? '+' : ''})` : '评论');
const visibleComments = computed(() => comments.value.slice(0, visibleRootLimit.value));
const hiddenRenderedCommentCount = computed(() => Math.max(0, comments.value.length - visibleComments.value.length));
const hasHiddenRenderedComments = computed(() => hiddenRenderedCommentCount.value > 0);
const normalizedArticleId = computed(() =>
{
    const value = Number(props.articleId);
    return Number.isFinite(value) && value > 0 ? value : null;
});

async function fetchPage(next?: string | null): Promise<void>
{
    const articleId = normalizedArticleId.value;
    if (articleId === null)
    {
        hasLoadError.value = true;
        return;
    }

    const response = await getComments(articleId, next ?? null, 10);
    const page = response.data.map(({ node, childrenPreview }): CommentThreadItem => ({
        ...node,
        replyCount: node.childCount,
        hasMoreReplies: node.hasMoreChildren,
        repliesPreview: childrenPreview
    }));
    comments.value = next ? [...comments.value, ...page] : page;
    cursor.value = response.nextCursor;
    hasMore.value = response.hasMore;
    hasLoadError.value = false;
}

async function loadMore(): Promise<void>
{
    if (!hasMore.value || loadingMore.value)
    {
        return;
    }

    loadingMore.value = true;
    try
    {
        await fetchPage(cursor.value);
    }
    catch
    {
        hasLoadError.value = true;
    }
    finally
    {
        loadingMore.value = false;
    }
}

async function showMoreOrLoad(): Promise<void>
{
    if (hasHiddenRenderedComments.value)
    {
        visibleRootLimit.value += 5;
        return;
    }
    await loadMore();
}

onMounted(async () =>
{
    try
    {
        await fetchPage(null);
    }
    catch
    {
        hasLoadError.value = true;
    }
    finally
    {
        loading.value = false;
    }
});
</script>
