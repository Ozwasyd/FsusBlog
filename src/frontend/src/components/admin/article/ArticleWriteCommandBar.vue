<template>
    <FsusUiTaskPageHeader
        class="article-write-command-bar"
        density="compact"
    >
        <template #title>
            <span class="article-write-command-bar__heading">
                <ElButton
                    class="article-write-command-bar__back"
                    text
                    :disabled="submitting"
                    @click="$emit('back')"
                >
                    返回
                </ElButton>
                <span :id="titleId">{{ pageTitle }}</span>
                <span class="article-write-command-bar__article-state">
                    {{ articleStateText }}
                </span>
            </span>
        </template>
        <template #actions>
            <div class="article-write-command-bar__actions">
                <ElButton
                    v-if="criticalStatusText && criticalStatusTarget"
                    :id="statusId"
                    class="article-write-command-bar__critical-status"
                    text
                    :disabled="submitting"
                    @click="openCriticalInspector"
                >
                    {{ criticalStatusText }}
                </ElButton>
                <span
                    v-else
                    :id="statusId"
                    class="article-write-command-bar__save-status"
                    :class="{ 'article-write-command-bar__save-status--danger': statusTone === 'danger' }"
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                >
                    {{ statusText }}
                </span>
                <ElButton
                    v-if="showSaveDraft"
                    class="article-write-command-bar__save-draft"
                    :disabled="submitting"
                    @click="$emit('saveDraft')"
                >
                    保存草稿
                </ElButton>
                <ElButton
                    class="article-write-command-bar__primary"
                    type="primary"
                    :loading="submitting"
                    :disabled="submitting"
                    :aria-describedby="statusId"
                    @click="$emit('submit')"
                >
                    {{ primaryActionText }}
                </ElButton>
            </div>
        </template>
    </FsusUiTaskPageHeader>
</template>

<script setup lang="ts">
import type { ArticleWriteInspectorView } from '@/composables/useArticleWriteInspector';
import { FsusUiTaskPageHeader } from '@/fsusui';

const props = withDefaults(defineProps<{
    titleId?: string;
    statusId?: string;
    pageTitle: string;
    articleStateText: string;
    statusText: string;
    statusTone?: 'quiet' | 'danger';
    primaryActionText: string;
    showSaveDraft?: boolean;
    submitting?: boolean;
    criticalStatusText?: string;
    criticalStatusTarget?: ArticleWriteInspectorView | null;
}>(), {
    titleId: 'article-write-title',
    statusId: 'article-editor-status',
    statusTone: 'quiet',
    showSaveDraft: true,
    submitting: false,
    criticalStatusText: '',
    criticalStatusTarget: null
});

const emit = defineEmits<{
    (e: 'back'): void;
    (e: 'saveDraft'): void;
    (e: 'submit'): void;
    (e: 'openInspector', view: ArticleWriteInspectorView, trigger: HTMLElement): void;
}>();

const openCriticalInspector = (event: MouseEvent): void =>
{
    if (props.criticalStatusTarget)
    {
        emit('openInspector', props.criticalStatusTarget, event.currentTarget as HTMLElement);
    }
};
</script>

<style scoped>
.article-write-command-bar
 {
    box-sizing: border-box;
    min-height: 3.5rem;
    align-items: center;
    margin-bottom: var(--fsus-space-8);
    border-bottom: 1px solid var(--fsusblog-panel-border);
    padding: 0 var(--fsus-space-6);
}

.article-write-command-bar__heading,
.article-write-command-bar__actions
 {
    display: flex;
    min-width: 0;
    align-items: center;
}

.article-write-command-bar__heading
 {
    flex-wrap: wrap;
    gap: var(--fsus-space-3);
}

.article-write-command-bar__back
 {
    min-width: 2.5rem;
    min-height: 2.5rem;
    flex: 0 0 auto;
    padding-inline: var(--fsus-space-2);
    color: var(--fsusblog-text-muted);
    font-size: 14px;
    font-weight: 500;
}

.article-write-command-bar__back:hover,
.article-write-command-bar__back:focus-visible
 {
    color: var(--fsusblog-text-primary);
}

.article-write-command-bar__article-state
 {
    flex: 0 0 auto;
    border-left: 1px solid var(--fsusblog-panel-border);
    padding-left: var(--fsus-space-3);
    color: var(--fsusblog-text-muted);
    font-size: 14px;
    font-weight: 500;
    line-height: 1.25;
}

.article-write-command-bar__actions
 {
    justify-content: flex-end;
    gap: var(--fsus-space-3);
}

.article-write-command-bar__save-status
 {
    width: 10rem;
    min-width: 0;
    overflow: hidden;
    color: var(--fsusblog-text-muted);
    font-size: 14px;
    font-weight: 500;
    line-height: 1.25;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.article-write-command-bar__critical-status
 {
    width: 12rem;
    min-height: 2.75rem;
    overflow: hidden;
    justify-content: flex-end;
    color: var(--fsusblog-color-danger);
    font-size: 14px;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.article-write-command-bar__save-status--danger
 {
    color: var(--fsusblog-color-danger);
}

.article-write-command-bar__save-draft,
.article-write-command-bar__primary
 {
    min-height: 2.75rem;
    flex: 0 0 auto;
}

.article-write-command-bar__save-draft
 {
    min-width: 6rem;
}

.article-write-command-bar__primary
 {
    min-width: 7rem;
}

@media (width >= 1024px)
 {
    .article-write-command-bar
 {
        padding-right: calc(
            var(--fsus-control-height-spacious) + var(--fsus-space-8)
        );
    }
}

@media (width <= 1023px)
 {
    .article-write-command-bar__heading
 {
        box-sizing: border-box;
        width: 100%;
    }

    .article-write-command-bar__back
 {
        margin-inline-start: calc(var(--fsus-control-height-spacious) + var(--fsus-space-3));
    }
}

@media (width <= 767px)
 {
    .article-write-command-bar
 {
        min-height: 3.5rem;
        gap: 0;
        margin-bottom: var(--fsus-space-6);
        padding: 0 var(--fsus-space-4);
    }

    .article-write-command-bar__heading
 {
        gap: var(--fsus-space-2);
    }

    .article-write-command-bar__article-state
 {
        margin-left: auto;
    }

    .article-write-command-bar__actions
 {
        box-sizing: border-box;
        position: static;
        width: 100%;
        flex-wrap: wrap;
        min-height: var(--fsus-control-height-spacious);
        justify-content: flex-end;
        gap: var(--fsus-space-2);
        border-top: 1px solid var(--fsusblog-panel-border);
        background: var(--fsusblog-page-bg);
        padding: var(--fsus-space-3) 0 0;
    }

    .article-write-command-bar__save-status
 {
        width: auto;
        flex: 1 1 auto;
        text-align: left;
    }

    .article-write-command-bar__critical-status
 {
        width: auto;
        min-width: 0;
        flex: 1 1 auto;
        justify-content: flex-start;
    }

    .article-write-command-bar__save-draft,
    .article-write-command-bar__primary
 {
        min-width: 0;
        min-height: 2.75rem;
        margin-inline: 0;
        padding-inline: var(--fsus-space-4);
    }
}

@media (width <= 639px)
 {
    .article-write-command-bar__actions
 {
        padding-inline: 0;
    }

    .article-write-command-bar__save-status
 {
        max-width: 8.5rem;
    }

    .article-write-command-bar__critical-status
 {
        height: auto;
        max-width: 100%;
        flex-basis: 100%;
        white-space: normal;
        overflow-wrap: anywhere;
    }
}
</style>
