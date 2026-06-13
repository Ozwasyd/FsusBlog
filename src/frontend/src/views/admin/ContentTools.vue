<template>
  <div class="account-page content-tools-page account-motion-enter w-full">
    <AccountPageHeader
      eyebrow="管理 / MIGRATION"
      title="备份与迁移"
      description="执行全站内容备份、单篇文章导出与 Markdown/frontmatter 导入。"
    />

    <AdminTaskFeedbackBar
      class="mb-8"
      :phase="taskFeedbackPhase"
      :message="taskFeedbackMessage"
      :detail="taskFeedbackDetail"
      :aria-message="taskFeedbackAriaMessage"
      :assertive-message="taskFeedbackAssertiveMessage"
      :busy="taskFeedbackBusy"
    />

    <div class="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section
        class="blog-motion-task-region border-t border-[var(--fsusblog-panel-border)]"
        :class="{
          'blog-motion-task-region--pending': exporting,
          'blog-motion-task-region--settled': isTaskHighlighted('content-export')
        }"
      >
        <header class="border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] px-4 py-3">
          <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">导出 / EXPORT</div>
        </header>
        <div class="space-y-8 px-4 py-6">
          <el-button type="primary" :loading="exporting" @click="downloadBackup">
            导出全站内容备份
          </el-button>

          <el-divider />

          <el-form label-position="top" @submit.prevent="downloadArticle">
            <el-form-item label="单篇文章 ID">
              <el-input v-model="articleId" name="contentToolsArticleId" placeholder="输入文章 ID" />
            </el-form-item>
            <el-button :loading="exporting" @click="downloadArticle">
              导出单篇 Markdown
            </el-button>
          </el-form>
        </div>
      </section>

      <section
        class="blog-motion-task-region border-t border-[var(--fsusblog-panel-border)]"
        :class="{
          'blog-motion-task-region--pending': importing,
          'blog-motion-task-region--settled': isTaskHighlighted('content-import')
        }"
      >
        <header class="border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] px-4 py-3">
          <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">导入 / IMPORT</div>
        </header>
        <div class="space-y-8 px-4 py-6">
          <el-form label-position="top" @submit.prevent="importContent">
            <el-form-item label="Markdown / Frontmatter">
              <el-input
                v-model="markdown"
                name="contentImportMarkdown"
                type="textarea"
                :rows="14"
                maxlength="200000"
                show-word-limit
                placeholder="粘贴导出的 Markdown/frontmatter 内容"
              />
            </el-form-item>
            <div class="flex flex-wrap items-center gap-4">
              <el-checkbox v-model="publish">导入后发布</el-checkbox>
              <el-checkbox v-model="preserveRevisions">保留修订历史</el-checkbox>
            </div>
            <el-button class="mt-6" type="primary" :loading="importing" @click="importContent">
              导入内容
            </el-button>
          </el-form>

          <div
            v-if="importResult"
            class="blog-motion-task-region border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] p-4 text-[12px] leading-6 text-[var(--fsusblog-text-secondary)]"
            :class="{ 'blog-motion-task-region--settled': isTaskHighlighted('content-import') }"
          >
            <p>导入文章 ID：<span class="tabular-nums">{{ importResult.articleId }}</span></p>
            <p>恢复修订数：<span class="tabular-nums">{{ importResult.restoredRevisionCount }}</span></p>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import {
  exportArticleContent,
  exportContentBackup,
  importArticleContent,
  type ContentBackupExportResponse,
  type ContentExportResponse,
  type ContentImportResponse
} from '@/api/authoring'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import AdminTaskFeedbackBar from '@/components/admin/AdminTaskFeedbackBar.vue'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { toast } from '@/fsusui/feedback'
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback'
import { useAdminSensitiveProof } from '@/composables/useAdminSensitiveProof'

const articleId = ref('')
const markdown = ref('')
const publish = ref(false)
const preserveRevisions = ref(true)
const exporting = ref(false)
const importing = ref(false)
const importResult = ref<ContentImportResponse | null>(null)
const taskFeedback = useAdminTaskFeedback()
const { ensureAdminSensitiveProof } = useAdminSensitiveProof()
const {
  phase: taskFeedbackPhase,
  message: taskFeedbackMessage,
  detail: taskFeedbackDetail,
  assertiveMessage: taskFeedbackAssertiveMessage,
  busy: taskFeedbackBusy,
  ariaMessage: taskFeedbackAriaMessage,
  isHighlighted: isTaskHighlighted
} = taskFeedback

const parseArticleId = (): number | null => {
  const parsed = Number.parseInt(articleId.value.trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const downloadJson = (payload: ContentBackupExportResponse): void => {
  downloadText(payload.fileName, JSON.stringify(payload, null, 2), 'application/json')
}

const downloadMarkdown = (payload: ContentExportResponse): void => {
  downloadText(payload.fileName, payload.markdownWithFrontmatter, 'text/markdown;charset=utf-8')
}

const downloadText = (fileName: string, content: string, type: string): void => {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

const downloadBackup = async (): Promise<void> => {
  exporting.value = true
  taskFeedback.begin('正在导出全站内容备份', '生成 JSON 备份文件', 'content-export')
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    const payload = await exportContentBackup({ mfaProofToken })
    downloadJson(payload)
    taskFeedback.succeed('全站内容备份已生成', payload.fileName, 'content-export')
    toast.success('全站内容备份已生成')
  } catch (error) {
    taskFeedback.fail('全站内容备份导出失败', error, '全站内容备份导出失败', 'content-export')
    showErrorToast(error, '全站内容备份导出失败')
  } finally {
    exporting.value = false
  }
}

const downloadArticle = async (): Promise<void> => {
  const id = parseArticleId()
  if (!id) {
    showWarningToast('请输入有效文章 ID', '请输入有效文章 ID')
    return
  }

  exporting.value = true
  taskFeedback.begin('正在导出单篇 Markdown', `文章 ${id}`, 'content-export')
  try {
    const payload = await exportArticleContent(id)
    downloadMarkdown(payload)
    taskFeedback.succeed('单篇文章已导出', payload.fileName, 'content-export')
    toast.success('单篇文章已导出')
  } catch (error) {
    taskFeedback.fail('单篇文章导出失败', error, '单篇文章导出失败', 'content-export')
    showErrorToast(error, '单篇文章导出失败')
  } finally {
    exporting.value = false
  }
}

const importContent = async (): Promise<void> => {
  const content = markdown.value.trim()
  if (!content) {
    showWarningToast('请先粘贴 Markdown/frontmatter 内容', '请先粘贴 Markdown/frontmatter 内容')
    return
  }

  importing.value = true
  taskFeedback.begin('正在导入内容', publish.value ? '导入后发布' : '导入为草稿', 'content-import')
  try {
    importResult.value = await importArticleContent({
      markdownWithFrontmatter: content,
      publish: publish.value,
      preserveRevisions: preserveRevisions.value
    })
    taskFeedback.succeed('内容导入完成', `文章 ${importResult.value.articleId}，恢复修订 ${importResult.value.restoredRevisionCount}`, 'content-import')
    toast.success('内容导入完成')
  } catch (error) {
    taskFeedback.fail('内容导入失败', error, '内容导入失败', 'content-import')
    showErrorToast(error, '内容导入失败')
  } finally {
    importing.value = false
  }
}
</script>

<style scoped>
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
