<template>
  <section class="article-private-preview-panel border-t border-[var(--fsusblog-panel-border)]" aria-labelledby="article-private-preview-title">
    <header class="px-4 py-3 bg-[var(--fsusblog-page-bg-soft)] border-b border-[var(--fsusblog-panel-border)]">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div id="article-private-preview-title" class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">私有预览</div>
          <p class="mt-1 text-xs text-[var(--fsusblog-text-tertiary)]" aria-live="polite">{{ statusText }}</p>
        </div>
        <el-button
          type="primary"
          :icon="View"
          :loading="loading"
          :disabled="loading || !canPreview"
          aria-label="生成私有预览"
          @click="$emit('preview')"
        >
          生成预览
        </el-button>
      </div>
    </header>

    <div class="space-y-4 p-4 bg-[var(--fsusblog-page-bg)]">
      <div v-if="issues.length > 0" class="preview-issues" aria-label="预览检查结果">
        <span
          v-for="issue in issues"
          :key="`${issue.severity}:${issue.code}`"
          class="preview-issue"
          :class="`preview-issue--${issue.severity}`"
        >
          {{ issue.message }}
        </span>
      </div>

      <iframe
        v-if="html"
        class="preview-frame"
        title="私有预览渲染结果"
        sandbox=""
        :srcdoc="previewDocument"
      ></iframe>
      <p v-else class="preview-empty">暂无预览快照。</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { View } from '@/fsusui/icons'
import { sanitizePreviewHtml } from '@/utils/safeHtml'
import { toTrustedSanitizedHtml } from '@/security/trustedTypesRuntime'
import type { PrepublishIssue } from '@/api/authoring'

const props = defineProps<{
  html: string
  issues: PrepublishIssue[]
  loading: boolean
  statusText: string
  canPreview: boolean
}>()

defineEmits<{
  (e: 'preview'): void
}>()

const sanitizedHtml = computed(() => sanitizePreviewHtml(props.html))

const previewDocument = computed(() => toTrustedSanitizedHtml(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <base target="_blank">
  <style>
    :root { color-scheme: light dark; font-family: "Google Sans", "Noto Sans SC", "Noto Sans TC", "Noto Sans JP", ui-sans-serif, system-ui, sans-serif; --preview-surface: Canvas; --preview-text: CanvasText; --preview-muted: GrayText; --preview-link: LinkText; --preview-border: ButtonBorder; --preview-code-bg: Field; --preview-radius-inline: var(--fsus-radius-control-small, 4px); }
    body { margin: 0; padding: 24px; background: var(--preview-surface); color: var(--preview-text); line-height: 1.72; }
    article { max-width: 760px; margin: 0 auto; }
    h1, h2, h3, h4, h5, h6 { color: var(--preview-text); line-height: 1.3; }
    h1 { font-size: 2rem; margin: 0 0 0.6rem; }
    h2 { font-size: 1.45rem; margin-top: 1.8rem; }
    h3 { font-size: 1.18rem; margin-top: 1.5rem; }
    p, ul, ol, blockquote, pre, figure { margin: 1rem 0; }
    a { color: var(--preview-link); text-decoration: underline; text-underline-offset: 0.16em; }
    img { max-width: 100%; height: auto; border: 1px solid var(--preview-border); }
    blockquote { border-left: 3px solid var(--preview-border); padding-left: 1rem; color: var(--preview-muted); }
    code { border-radius: var(--preview-radius-inline); background: var(--preview-code-bg); padding: 0.08rem 0.28rem; font-size: 14px; }
    pre { overflow: auto; border: 1px solid var(--preview-border); background: CanvasText; color: Canvas; padding: 1rem; }
    pre code { background: transparent; padding: 0; color: inherit; }
    .author-preview__summary { color: var(--preview-muted); font-size: 1rem; }
    .author-preview__cover img, .author-preview__image img { border-radius: 4px; }
  </style>
</head>
<body>${sanitizedHtml.value}</body>
</html>`))
</script>

<style scoped>
.preview-issues {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.preview-issue {
  border: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg-soft);
  color: var(--fsusblog-text-secondary);
  padding: 0.3rem 0.45rem;
  font-size: 12px;
  font-weight: 500;
}

.preview-issue--error {
  border-color: var(--fsusblog-color-error-border);
  color: var(--fsusblog-color-error-strong);
}

.preview-frame {
  width: 100%;
  min-height: 360px;
  border: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-panel-bg);
}

.preview-empty {
  margin: 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 12px;
}
</style>
