<template>
  <section class="article-seo-preview-panel border-t border-[var(--fsusblog-panel-border)]" aria-labelledby="article-seo-preview-title">
    <header class="px-4 py-3 bg-[var(--fsusblog-page-bg-soft)] border-b border-[var(--fsusblog-panel-border)]">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div id="article-seo-preview-title" class="text-[13px] font-semibold normal-case tracking-normal text-[var(--fsusblog-text-primary)]">SEO 与发布前检查</div>
          <p class="mt-1 text-[12px] text-[var(--fsusblog-text-tertiary)]" aria-live="polite">{{ statusText }}</p>
        </div>
        <el-button
          circle
          :icon="Refresh"
          :loading="loading"
          :disabled="loading"
          aria-label="刷新 SEO 检查"
          @click="$emit('refresh')"
        />
      </div>
    </header>

    <div class="space-y-4 p-4 bg-[var(--fsusblog-page-bg)]">
      <div class="seo-search-preview" aria-label="搜索结果预览">
        <div class="seo-search-preview__url">{{ preview.canonicalUrl }}</div>
        <div class="seo-search-preview__title">{{ preview.title }}</div>
        <p class="seo-search-preview__description">{{ preview.description }}</p>
      </div>

      <div class="seo-share-preview" aria-label="分享卡片预览">
        <div class="seo-share-preview__image">
          <img v-if="preview.ogImage" :src="preview.ogImage" alt="" loading="lazy" decoding="async" />
          <el-icon aria-hidden="true" v-else><Picture /></el-icon>
        </div>
        <div class="min-w-0">
          <div class="seo-share-preview__title">{{ preview.title }}</div>
          <p class="seo-share-preview__description">{{ preview.description }}</p>
        </div>
      </div>

      <dl class="seo-meta-grid">
        <div>
          <dt>地址片段</dt>
          <dd>{{ preview.slug }}</dd>
        </div>
        <div>
          <dt>标题长度</dt>
          <dd>{{ preview.titleLength }}/60</dd>
        </div>
        <div>
          <dt>摘要长度</dt>
          <dd>{{ preview.descriptionLength }}/180</dd>
        </div>
      </dl>

      <div v-if="issues.length > 0" class="seo-issues" aria-label="发布前检查结果">
        <span
          v-for="issue in issues"
          :key="`${issue.severity}:${issue.code}:${issue.message}`"
          class="seo-issue"
          :class="`seo-issue--${issue.severity}`"
        >
          <strong>{{ formatIssueSeverity(issue.severity) }}</strong>
          {{ issue.message }}
        </span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Picture, Refresh } from '@/fsusui/icons'
import type { PrepublishIssue } from '@/api/authoring'

export interface ArticleSeoPreviewState {
  title: string
  description: string
  canonicalUrl: string
  slug: string
  ogImage: string
  titleLength: number
  descriptionLength: number
}

defineProps<{
  preview: ArticleSeoPreviewState
  issues: PrepublishIssue[]
  loading: boolean
  statusText: string
}>()

defineEmits<{
  (e: 'refresh'): void
}>()

const formatIssueSeverity = (severity: string): string => {
  const labels: Record<string, string> = {
    info: '信息',
    warning: '警告',
    error: '错误',
    critical: '严重'
  }
  return labels[severity.toLowerCase()] ?? severity
}
</script>

<style scoped>
.seo-search-preview,
.seo-share-preview {
  border: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg-soft);
  padding: 0.8rem;
}

.seo-search-preview__url {
  overflow: hidden;
  color: var(--fsusblog-color-success);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.seo-search-preview__title {
  overflow: hidden;
  margin-top: 0.3rem;
  color: var(--fsusblog-color-primary);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.seo-search-preview__description,
.seo-share-preview__description {
  display: -webkit-box;
  overflow: hidden;
  margin: 0.35rem 0 0;
  color: var(--fsusblog-text-secondary);
  font-size: 0.875rem;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.seo-share-preview {
  display: grid;
  grid-template-columns: 5rem minmax(0, 1fr);
  gap: 0.75rem;
}

.seo-share-preview__image {
  display: flex;
  aspect-ratio: 1.91 / 1;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg);
  color: var(--fsusblog-text-subtle);
}

.seo-share-preview__image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.seo-share-preview__title {
  overflow: hidden;
  color: var(--fsusblog-text-primary);
  font-size: 0.875rem;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.seo-meta-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.6rem;
}

.seo-meta-grid dt {
  color: var(--fsusblog-text-muted);
  font-size: 0.75rem;
  font-weight: 800;
}

.seo-meta-grid dd {
  overflow: hidden;
  margin: 0.25rem 0 0;
  color: var(--fsusblog-text-secondary);
  font-size: 0.875rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.seo-issues {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.seo-issue {
  border: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg-soft);
  color: var(--fsusblog-text-secondary);
  padding: 0.3rem 0.45rem;
  font-size: 0.75rem;
  font-weight: 700;
}

.seo-issue strong {
  margin-right: 0.25rem;
}

.seo-issue--error {
  border-color: var(--fsusblog-color-error-border);
  color: var(--fsusblog-color-error-strong);
}

.seo-issue--warning {
  border-color: var(--fsusblog-color-warning-border);
  color: var(--fsusblog-color-warning-text);
}

@media (max-width: 640px) {
  .seo-share-preview,
  .seo-meta-grid {
    grid-template-columns: 1fr;
  }

  .seo-share-preview__image {
    max-width: 11rem;
  }
}
</style>
