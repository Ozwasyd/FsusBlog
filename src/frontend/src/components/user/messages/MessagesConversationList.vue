<template>
    <section
        ref="paneRef"
        class="messages-inbox-pane messages-list-pane"
        tabindex="-1"
        aria-labelledby="messages-list-title"
    >
        <div class="messages-flat-pane">
            <header class="messages-pane-header">
                <div class="messages-header">
                    <h2
                        id="messages-list-title"
                        class="messages-header-title"
                    >
                        {{ isAdminMode ? conversationListCopy.titleAdmin : conversationListCopy.titleAccount }}
                    </h2>
                    <div class="messages-header-actions">
                        <ElButton
                            v-if="!isAdminMode"
                            class="messages-header-create-ticket"
                            size="small"
                            type="primary"
                            @click="emit('createTicket')"
                        >
                            {{ conversationListCopy.newTicketCta }}
                        </ElButton>
                        <div class="messages-filter">
                            <ElSelect
                                class="messages-filter-control"
                                :model-value="filter"
                                :name="isAdminMode ? 'adminConversationFilter' : 'accountConversationFilter'"
                                size="small"
                                @update:model-value="handleFilterUpdate"
                            >
                                <ElOption
                                    v-for="option in filterOptions"
                                    :key="option.value"
                                    :label="option.label"
                                    :value="option.value"
                                />
                            </ElSelect>
                        </div>
                    </div>
                </div>
            </header>

            <div class="messages-pane-body">
                <div
                    v-if="isMobile && !isAdminMode && rows.length > 0"
                    class="messages-mobile-primary"
                >
                    <ElButton
                        type="primary"
                        @click="emit('createTicket')"
                    >{{ conversationListCopy.newTicketCta }}</ElButton>
                </div>

                <ElSkeleton
                    v-if="loading"
                    :rows="8"
                    animated
                />

                <MessagesEmptyState
                    v-else-if="rows.length === 0"
                    class="messages-list-empty"
                    :title="isAdminMode ? conversationListCopy.emptyTitleAdmin : conversationListCopy.emptyTitleAccount"
                    :description="isAdminMode ? conversationListCopy.emptyDescriptionAdmin : conversationListCopy.emptyDescriptionAccount"
                >
                    <template
                        v-if="!isAdminMode"
                        #action
                    >
                        <ElButton @click="emit('createTicket')">{{ conversationListCopy.newTicketCta }}</ElButton>
                    </template>
                </MessagesEmptyState>

                <div
                    v-else
                    class="messages-list-scroll"
                >
                    <p
                        v-if="motionSummary"
                        class="blog-motion-summary-enter messages-motion-summary"
                        role="status"
                        aria-live="polite"
                    >
                        {{ motionSummary }}
                    </p>
                    <ul
                        class="messages-conversation-stack"
                        :aria-label="conversationListCopy.listAriaLabel"
                    >
                        <li
                            v-for="item in rows"
                            :key="item.conversationId"
                            class="messages-conversation-entry"
                            v-memo="[item.conversationId, item.subject, item.lastMessageAtText, item.unreadCount, item.status, rowClassKey(item)]"
                        >
                            <FsusUiButton
                                native-type="button"
                                text
                                class="messages-conversation-item"
                                :class="conversationRowClass(item)"
                                :aria-current="item.conversationId === selectedConversationId ? 'true' : undefined"
                                :aria-label="item.ariaLabel"
                                @click="emit('select', item.conversationId)"
                            >
                                <div class="messages-conversation-content">
                                    <div class="messages-conversation-top">
                                        <span
                                            class="messages-conversation-subject"
                                            data-visual-dynamic
                                        >{{ item.subject }}</span>
                                        <div class="messages-conversation-tags">
                                            <ElTag
                                                v-if="item.isSystemSource"
                                                size="small"
                                            >{{ conversationListCopy.systemTag }}</ElTag>
                                            <ElTag
                                                size="small"
                                                :type="statusType(item.status)"
                                            >{{ statusLabel(item.status) }}</ElTag>
                                        </div>
                                    </div>
                                    <p
                                        class="messages-conversation-preview"
                                        data-visual-dynamic
                                    >
                                        {{ item.lastMessage?.bodyPreview || (isAdminMode ? conversationListCopy.noContentAdmin : conversationListCopy.noContentAccount) }}
                                    </p>
                                    <div class="messages-conversation-meta">
                                        <time
                                            :datetime="item.lastMessageAt"
                                            data-visual-dynamic
                                        >{{ item.lastMessageAtText }}</time>
                                        <ElBadge
                                            v-if="item.unreadCount > 0"
                                            :value="item.unreadCount"
                                        />
                                    </div>
                                </div>
                            </FsusUiButton>
                        </li>
                    </ul>
                    <ElButton
                        v-if="hiddenCount > 0 || hasMore"
                        link
                        type="primary"
                        class="messages-window-more"
                        :loading="loadingMore"
                        @click="emit('loadMore')"
                    >
                        {{ showMoreText }}
                    </ElButton>
                </div>

                <slot name="mobile-compose" />
            </div>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import type { ConversationFilter, ConversationListItemResponse } from '@/api/message';
import { useI18nText } from '@/composables/useI18nText';
import { FsusUiButton } from '@/fsusui/button';

import MessagesEmptyState from './MessagesEmptyState.vue';

type ConversationRow = ConversationListItemResponse & {
    lastMessageAtText: string;
    ariaLabel: string;
};

const { messages, translatePlural } = useI18nText();
const conversationListCopy = computed(() => messages.value.messages.conversationList);
const filterCopy = computed(() => messages.value.messages.filter);

const props = defineProps<{
    mode: 'admin' | 'account';
    isMobile: boolean;
    loading: boolean;
    filter: ConversationFilter;
    rows: ConversationRow[];
    hiddenCount: number;
    hasMore: boolean;
    loadingMore: boolean;
    selectedConversationId: string;
    motionSummary?: string;
    statusLabel: (status: number) => string;
    statusType: (status: number) => 'warning' | 'success' | '';
    conversationRowClass: (item: ConversationRow) => string[];
}>();

const emit = defineEmits<{
    'update:filter': [value: ConversationFilter];
    select: [conversationId: string];
    createTicket: [];
    loadMore: [];
}>();

const paneRef = ref<HTMLElement | null>(null);
const isAdminMode = computed(() => props.mode === 'admin');
const filterOptions = computed(() =>
    isAdminMode.value
        ? [
            { label: filterCopy.value.open, value: 'open' },
            { label: filterCopy.value.pending, value: 'pending' },
            { label: filterCopy.value.closed, value: 'closed' },
            { label: filterCopy.value.system, value: 'system' },
            { label: filterCopy.value.all, value: 'all' }
        ] satisfies { label: string; value: ConversationFilter; }[]
        : [
            { label: filterCopy.value.all, value: 'all' },
            { label: filterCopy.value.unread, value: 'unread' },
            { label: filterCopy.value.systemMessages, value: 'system' },
            { label: filterCopy.value.open, value: 'open' },
            { label: filterCopy.value.pending, value: 'pending' },
            { label: filterCopy.value.closed, value: 'closed' }
        ] satisfies { label: string; value: ConversationFilter; }[]
);
const showMoreText = computed(() =>
    translatePlural('messages.conversationList.showMoreLabel', Math.max(0, props.hiddenCount))
);

const handleFilterUpdate = (value: unknown): void =>
{
    emit('update:filter', value as ConversationFilter);
};

const rowClassKey = (item: ConversationRow): string => props.conversationRowClass(item).join(' ');

defineExpose({
    focusPane: () =>
    {
        paneRef.value?.focus();
    }
});
</script>

<style scoped>
@reference "@/assets/main.css";

.messages-inbox-pane
 {
    min-height: 0;
    min-width: 0;
    max-width: 100%;
}

.messages-flat-pane
 {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    max-width: 100%;
}

.messages-pane-header
 {
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--fsusblog-panel-border);
    margin-bottom: 2rem;
}

.messages-pane-body
 {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    max-width: 100%;
}

.messages-header
 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem 1rem;
}

.messages-header-title
 {
    margin: 0;
    color: var(--fsusblog-text-primary);
    font-size: 1.125rem;
    font-weight: 700;
    letter-spacing: 0;
    white-space: nowrap;
    flex-shrink: 0;
}

.messages-filter
 {
    width: auto;
    min-width: 6.5rem;
    max-width: 10rem;
}

.messages-header-actions
 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    min-width: 0;
}

@media (width <= 640px), (height <= 520px) and (orientation: landscape)
 {
    .messages-header
 {
        align-items: flex-start;
        flex-direction: column;
        gap: 0.75rem;
    }

    .messages-header-actions
 {
        width: 100%;
        align-items: stretch;
        flex-direction: column;
        gap: 0.5rem;
    }

    .messages-header-create-ticket
 {
        align-self: flex-start;
        min-height: 2.75rem;
    }

    .messages-filter
 {
        width: 100%;
    }

    .messages-filter-control
 {
        width: 100%;
    }
}

.messages-mobile-primary
 {
    display: flex;
    justify-content: flex-start;
    margin-top: 1.5rem;
}

.messages-list-empty
 {
    margin-top: 0.25rem;
}

.messages-list-scroll
 {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    max-width: 100%;
    overflow: auto;
}

.messages-conversation-stack
 {
    display: flex;
    flex-direction: column;
    min-width: 0;
    max-width: 100%;
    margin: 0;
    padding: 0;
    list-style: none;
}

.messages-conversation-entry
 {
    min-width: 0;
    max-width: 100%;
}

.messages-window-more
 {
    margin-top: 0.75rem;
}

.messages-conversation-item
 {
    display: grid;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    height: auto;
    border-bottom: 1px solid var(--fsusblog-panel-border);
    background: transparent;
    padding: 1.25rem 0;
    font: inherit;
    text-align: left;
    white-space: normal;
}

.messages-conversation-item:last-child
 {
    border-bottom: none;
}

.messages-conversation-content
 {
    width: 100%;
    min-width: 0;
    max-width: 100%;
}

.messages-conversation-item.active
 {
    @apply relative;
}

.messages-conversation-item.active::before
 {
    content: "";

    @apply absolute -left-4 top-[calc(50%-1rem)] h-8 w-[3px] bg-[var(--fsusblog-color-primary)];
}

.messages-conversation-top,
.messages-conversation-meta
 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    min-width: 0;
    max-width: 100%;
}

.messages-conversation-tags
 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    justify-content: flex-end;
    min-width: 0;
}

.messages-conversation-subject
 {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
}

.messages-conversation-preview,
.messages-conversation-meta
 {
    color: var(--fsusblog-text-tertiary);
}

.messages-conversation-preview
 {
    margin: 0.5rem 0 0.75rem;
    font-size: 14px;
    line-height: 1.6;
    overflow-wrap: anywhere;
}

.messages-conversation-meta
 {
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
}

@media (width >= 1024px)
 {
    .messages-list-pane
 {
        border-right: 1px solid var(--fsusblog-panel-border);
        padding-right: 4rem;
    }
}

@media (width <= 1023px)
 {
    .messages-flat-pane
 {
        min-height: calc(var(--fsus-viewport-block-size) - 10rem);
    }
}
</style>
