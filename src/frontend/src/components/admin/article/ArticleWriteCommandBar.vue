<template>
  <FsusUiTaskPageHeader
    class="article-write-command-bar"
    density="compact"
  >
    <template #title>
      <span class="article-write-command-bar__heading">
        <el-button
          class="article-write-command-bar__back"
          text
          :disabled="submitting"
          @click="$emit('back')"
        >
          返回
        </el-button>
        <span :id="titleId">{{ pageTitle }}</span>
        <span class="article-write-command-bar__article-state">
          {{ articleStateText }}
        </span>
      </span>
    </template>
    <template #actions>
      <div class="article-write-command-bar__actions">
        <span
          :id="statusId"
          class="article-write-command-bar__save-status"
          :class="{ 'article-write-command-bar__save-status--danger': statusTone === 'danger' }"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {{ statusText }}
        </span>
        <el-button
          v-if="showSaveDraft"
          class="article-write-command-bar__save-draft"
          :disabled="submitting"
          @click="$emit('saveDraft')"
        >
          保存草稿
        </el-button>
        <el-button
          class="article-write-command-bar__primary"
          type="primary"
          :loading="submitting"
          :disabled="submitting"
          :aria-describedby="statusId"
          @click="$emit('submit')"
        >
          {{ primaryActionText }}
        </el-button>
      </div>
    </template>
  </FsusUiTaskPageHeader>
</template>

<script setup lang="ts">
import { FsusUiTaskPageHeader } from '@/fsusui'

withDefaults(defineProps<{
  titleId?: string
  statusId?: string
  pageTitle: string
  articleStateText: string
  statusText: string
  statusTone?: 'quiet' | 'danger'
  primaryActionText: string
  showSaveDraft?: boolean
  submitting?: boolean
}>(), {
  titleId: 'article-write-title',
  statusId: 'article-editor-status',
  statusTone: 'quiet',
  showSaveDraft: true,
  submitting: false
})

defineEmits<{
  (e: 'back'): void
  (e: 'saveDraft'): void
  (e: 'submit'): void
}>()
</script>

<style scoped>
.article-write-command-bar {
  box-sizing: border-box;
  min-height: 3.5rem;
  align-items: center;
  margin-bottom: 2rem;
  border-bottom: 1px solid var(--fsusblog-panel-border);
  padding: 0 1.5rem;
}

.article-write-command-bar__heading,
.article-write-command-bar__actions {
  display: flex;
  min-width: 0;
  align-items: center;
}

.article-write-command-bar__heading {
  gap: 0.75rem;
}

.article-write-command-bar__back {
  min-width: 2.5rem;
  min-height: 2.5rem;
  flex: 0 0 auto;
  padding-inline: 0.5rem;
  color: var(--fsusblog-text-muted);
  font-size: 14px;
  font-weight: 650;
}

.article-write-command-bar__back:hover,
.article-write-command-bar__back:focus-visible {
  color: var(--fsusblog-text-primary);
}

.article-write-command-bar__article-state {
  flex: 0 0 auto;
  border-left: 1px solid var(--fsusblog-panel-border);
  padding-left: 0.75rem;
  color: var(--fsusblog-text-muted);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.25;
}

.article-write-command-bar__actions {
  justify-content: flex-end;
  gap: 0.75rem;
}

.article-write-command-bar__save-status {
  width: 10rem;
  min-width: 0;
  overflow: hidden;
  color: var(--fsusblog-text-muted);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.25;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.article-write-command-bar__save-status--danger {
  color: var(--fsusblog-color-danger);
}

.article-write-command-bar__save-draft,
.article-write-command-bar__primary {
  min-height: 2.75rem;
  flex: 0 0 auto;
}

.article-write-command-bar__save-draft {
  min-width: 6rem;
}

.article-write-command-bar__primary {
  min-width: 7rem;
}

@media (max-width: 760px) {
  :global(.write-workspace) {
    padding-bottom: calc(5rem + env(safe-area-inset-bottom));
  }

  .article-write-command-bar {
    min-height: 3.5rem;
    gap: 0;
    margin-bottom: 1.5rem;
    padding: 0 1rem;
  }

  .article-write-command-bar__heading {
    gap: 0.5rem;
  }

  .article-write-command-bar__article-state {
    margin-left: auto;
  }

  .article-write-command-bar__actions {
    box-sizing: border-box;
    position: fixed;
    z-index: var(--fsusblog-z-sticky, 30);
    right: 0;
    bottom: 0;
    left: 0;
    height: calc(4rem + env(safe-area-inset-bottom));
    justify-content: flex-end;
    gap: 0.5rem;
    border-top: 1px solid var(--fsusblog-panel-border);
    background: var(--fsusblog-page-bg);
    padding: 0.625rem 1rem calc(0.625rem + env(safe-area-inset-bottom));
  }

  .article-write-command-bar__save-status {
    width: auto;
    flex: 1 1 auto;
    text-align: left;
  }

  .article-write-command-bar__save-draft,
  .article-write-command-bar__primary {
    min-width: 0;
    min-height: 2.75rem;
    padding-inline: 0.875rem;
  }
}

@media (max-width: 380px) {
  .article-write-command-bar__actions {
    padding-inline: 0.75rem;
  }

  .article-write-command-bar__save-status {
    max-width: 5.5rem;
  }
}
</style>
