<template>
    <div :class="themeTokens.userComments.list">
        <div
            class="relative"
            role="list"
            aria-label="评论历史列表"
        >
            <article
                v-for="item in list"
                :key="item.id"
                :class="themeTokens.userComments.item"
                role="listitem"
            >
                <div :class="themeTokens.userComments.itemHeader">
                    <div class="space-y-1.5 grow pr-0 sm:pr-8">
                        <span :class="themeTokens.userComments.articleLabel">回复文章</span>
                        <RouterLink
                            v-if="item.article"
                            :to="item.article.route"
                            :aria-label="item.article.ariaLabel"
                            :class="themeTokens.userComments.articleLink"
                        >
                            {{ item.article.title }}
                        </RouterLink>
                    </div>
                    <time
                        :datetime="item.time.isoTime"
                        :title="item.time.fullLocalTimeText"
                        :class="themeTokens.userComments.time"
                    >
                        {{ item.time.relativeTimeText }}
                    </time>
                </div>

                <p :class="themeTokens.userComments.content">
                    {{ item.content }}
                </p>

                <div
                    v-if="item.moderation"
                    class="user-comment-moderation mt-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
                >
                    <ElTag
                        :type="item.moderation.tone"
                        size="small"
                        effect="light"
                    >
                        {{ item.moderation.statusLabel }}
                    </ElTag>
                    <span class="min-w-0 break-words text-xs font-medium leading-relaxed text-[var(--fsusblog-text-muted)]">
                        {{ item.moderation.reasonText }}
                    </span>
                </div>

                <div class="flex justify-end">
                    <ElButton
                        link
                        type="danger"
                        class="user-comment-delete-button"
                        aria-label="删除此评论"
                        @click="$emit('delete', item.id)"
                    >
                        删除
                    </ElButton>
                </div>
            </article>
        </div>

        <div :class="themeTokens.userComments.footer">
            <ElButton
                v-if="showLoadMoreButton"
                :disabled="loading"
                :loading="loading"
                @click="$emit('load-more')"
            >
                {{ loadMoreButtonText }}
            </ElButton>
            <span
                v-else-if="showEndHint"
                :class="themeTokens.userComments.endHint"
            >
                {{ endHintText }}
            </span>
        </div>
    </div>
</template>

<script setup lang="ts">
import { themeTokens } from '@/ui-tokens';
import type { CommentThreadItemContract } from '@/view-contracts/commentDetail';

defineProps<{
    list: CommentThreadItemContract[];
    loading: boolean;
    showLoadMoreButton: boolean;
    showEndHint: boolean;
    loadMoreButtonText: string;
    endHintText: string;
}>();

defineEmits<{
    (e: 'delete', id: string): void;
    (e: 'load-more'): void;
}>();
</script>

<style scoped>
.user-comment-delete-button
 {
    min-width: 2.75rem;
    min-height: 2.75rem;
    padding-inline: 0.5rem;
}
</style>
