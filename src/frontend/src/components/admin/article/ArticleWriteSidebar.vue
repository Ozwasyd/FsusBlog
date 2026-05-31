<template>
  <section class="article-write-sidebar border-t border-[var(--fsusblog-panel-border)]" aria-labelledby="article-publish-settings-title">
    <header class="px-4 py-3 bg-[var(--fsusblog-page-bg-soft)] border-b border-[var(--fsusblog-panel-border)]">
      <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">发布设置 / SETTINGS</div>
    </header>

    <div class="p-6 space-y-8">
      <el-form-item prop="status">
        <template #label>
          <span class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">发布状态 / STATUS</span>
        </template>
        <div class="mt-2">
          <el-select
            v-model="form.status"
            name="articleStatus"
            aria-label="发布状态"
            :disabled="submitting"
          >
            <el-option
              v-for="item in statusOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </div>
      </el-form-item>

      <el-form-item v-if="form.status === ArticlePublishStatus.Scheduled" prop="scheduledPublishAt">
        <template #label>
          <span class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">发布时间 / SCHEDULE</span>
        </template>
        <div class="mt-2">
          <el-date-picker
            v-model="form.scheduledPublishAt"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ss"
            name="articleScheduledPublishAt"
            aria-label="定时发布时间"
            :disabled="submitting"
            :clearable="false"
          />
        </div>
      </el-form-item>

      <el-form-item prop="coverImageUrl">
        <template #label>
          <span class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">文章头图 / COVER IMAGE</span>
        </template>
        <div class="mt-2">
          <div
            v-if="form.coverImageUrl"
            class="group relative aspect-video w-full overflow-hidden rounded-[var(--fsus-radius-popover)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)]"
          >
            <img
              :src="form.coverImageUrl"
              alt="当前文章头图预览"
              class="h-full w-full object-cover transition-transform duration-[var(--fsus-motion-control-fast)] group-hover:scale-105"
            />
            <div class="cover-action-overlay absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
              <el-button
                type="danger"
                circle
                :icon="Delete"
                aria-label="移除文章头图"
                @click="$emit('clear-cover')"
              />
            </div>
          </div>
          <div
            v-else
            class="flex aspect-video w-full flex-col items-center justify-center rounded-[var(--fsus-radius-popover)] border-2 border-dashed border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] transition-colors hover:border-[var(--fsusblog-color-primary)]/30"
          >
            <span class="text-2xl text-[var(--fsusblog-text-subtle)]">
              <el-icon><Picture /></el-icon>
            </span>
            <span class="mt-2 text-[11px] font-medium text-[var(--fsusblog-text-muted)]">建议比例 16:9</span>
          </div>
          <div class="mt-4 grid gap-3">
            <el-button
              type="primary"
              :disabled="submitting"
              @click="$emit('open-cover-upload')"
            >
              {{ form.coverImageUrl ? '更换头图' : '上传头图' }}
            </el-button>
          </div>
        </div>
      </el-form-item>

      <el-form-item prop="categoryId">
        <template #label>
          <span class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">所属分类 / CATEGORY</span>
        </template>
        <div class="quick-field-row mt-2">
          <div class="quick-field-control">
            <el-select v-model="form.categoryId" name="articleCategoryId" aria-label="所属分类" placeholder="选择分类" clearable :disabled="submitting">
              <el-option
                v-for="c in categories"
                :key="c.id"
                :label="c.name"
                :value="c.id"
              />
            </el-select>
          </div>
          <div class="quick-create-control">
            <el-button
              aria-label="新建分类"
              :loading="quickCreatingCategory"
              :disabled="submitting || quickCreatingCategory"
              @click="$emit('open-create-category')"
            >
              新建
            </el-button>
          </div>
        </div>
      </el-form-item>

      <el-form-item prop="tagIds">
        <template #label>
          <span class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">标签索引 / TAGS</span>
        </template>
        <div class="quick-field-row mt-2">
          <div class="quick-field-control">
            <el-select
              v-model="form.tagIds"
              multiple
              collapse-tags
              collapse-tags-tooltip
              name="articleTagIds"
              aria-label="文章标签"
              placeholder="关联标签"
              :disabled="submitting"
            >
              <el-option
                v-for="t in tags"
                :key="t.id"
                :label="t.name"
                :value="t.id"
              />
            </el-select>
          </div>
          <div class="quick-create-control">
            <el-button
              aria-label="新建标签"
              :loading="quickCreatingTag"
              :disabled="submitting || quickCreatingTag"
              @click="$emit('open-create-tag')"
            >
              新建
            </el-button>
          </div>
        </div>
      </el-form-item>

      <el-form-item prop="summary">
        <template #label>
          <div class="flex items-center justify-between w-full">
            <span class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">内容摘要 / SUMMARY</span>
            <el-button link type="primary" size="small" @click="$emit('auto-summary')" :disabled="submitting">
              智能生成
            </el-button>
            <el-button link type="primary" size="small" @click="$emit('ai-assist')" :loading="aiAssistLoading" :disabled="submitting || aiAssistLoading">
              AI 辅助
            </el-button>
          </div>
        </template>
        <div class="mt-2">
          <el-input
            v-model="form.summary"
            name="articleSummary"
            type="textarea"
            :rows="6"
            aria-label="内容摘要"
            placeholder="若为空，系统将展示文章开头文字..."
            maxlength="250"
            show-word-limit
            :disabled="submitting"
          />
        </div>
      </el-form-item>

      <section
        v-if="aiAssist"
        class="space-y-4 border-t border-[var(--fsusblog-panel-border)] pt-6"
        data-author-ai-assist-panel="true"
        aria-label="作者 AI 辅助建议"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">AI ASSIST</div>
            <p class="mt-1 text-[11px] leading-5 text-[var(--fsusblog-text-subtle)]">
              {{ aiAssistStatusText || aiAssist.providerMode }}
            </p>
          </div>
          <el-tag size="small" type="info">{{ aiAssist.providerMode }}</el-tag>
        </div>

        <div v-if="aiAssist.suggestedSummary" class="space-y-2">
          <p class="text-xs leading-6 text-[var(--fsusblog-text-secondary)]">{{ aiAssist.suggestedSummary }}</p>
          <el-button size="small" :disabled="submitting" @click="$emit('apply-ai-summary')">采用摘要</el-button>
        </div>

        <div v-if="aiAssist.suggestedTags.length > 0" class="space-y-3">
          <div class="flex flex-wrap gap-2">
            <el-tag v-for="tag in aiAssist.suggestedTags" :key="tag" size="small">{{ tag }}</el-tag>
          </div>
          <el-button size="small" :disabled="submitting" @click="$emit('apply-ai-tags')">关联已有标签</el-button>
        </div>

        <div v-if="aiAssist.titleCandidates.length > 0" class="space-y-2">
          <div
            v-for="title in aiAssist.titleCandidates"
            :key="title"
          >
            <el-button
              :disabled="submitting"
              @click="$emit('apply-ai-title', title)"
            >
              <span class="min-w-0 whitespace-normal text-left leading-5">{{ title }}</span>
            </el-button>
          </div>
        </div>

        <div v-if="aiAssist.translationDraft" class="space-y-2">
          <div class="border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)]">
            <el-scrollbar max-height="8rem">
              <div class="p-3 text-xs leading-5 text-[var(--fsusblog-text-secondary)] whitespace-pre-wrap">
                {{ aiAssist.translationDraft }}
              </div>
            </el-scrollbar>
          </div>
          <el-button size="small" :disabled="submitting" @click="$emit('apply-ai-translation')">采用翻译草稿</el-button>
        </div>

        <ul v-if="aiAssist.structureIssues.length > 0" class="space-y-2">
          <li
            v-for="issue in aiAssist.structureIssues"
            :key="`${issue.code}:${issue.message}`"
            class="text-[11px] leading-5 text-[var(--fsusblog-text-subtle)]"
          >
            {{ issue.severity }} · {{ issue.message }}
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Delete, Picture } from '@/ui/fsusIcons';
import { ArticlePublishStatus } from '@/api/article';
import type { AiAssistResponse } from '@/api/authoring';
import type { CategoryItem } from '@/api/category';
import type { TagItem } from '@/api/tag';

interface ArticleWriteForm {
  title: string;
  content: string;
  summary: string;
  coverImageUrl?: string;
  categoryId: number | undefined;
  tagIds: number[];
  status: ArticlePublishStatus;
  scheduledPublishAt: string;
}

const statusOptions = [
  { label: '草稿', value: ArticlePublishStatus.Draft },
  { label: '定时', value: ArticlePublishStatus.Scheduled },
  { label: '发布', value: ArticlePublishStatus.Published },
  { label: '归档', value: ArticlePublishStatus.Archived }
] as const;

defineProps<{
  form: ArticleWriteForm;
  categories: CategoryItem[];
  tags: TagItem[];
  submitting: boolean;
  quickCreatingCategory: boolean;
  quickCreatingTag: boolean;
  aiAssist: AiAssistResponse | null;
  aiAssistLoading: boolean;
  aiAssistStatusText: string;
}>();

defineEmits<{
  (e: 'auto-summary'): void;
  (e: 'ai-assist'): void;
  (e: 'apply-ai-summary'): void;
  (e: 'apply-ai-title', title: string): void;
  (e: 'apply-ai-tags'): void;
  (e: 'apply-ai-translation'): void;
  (e: 'open-create-category'): void;
  (e: 'open-create-tag'): void;
  (e: 'open-cover-upload'): void;
  (e: 'clear-cover'): void;
}>();
</script>

<style scoped>
.quick-field-row {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 0.75rem;
}

.quick-field-control {
  display: grid;
  min-width: 0;
  flex: 1;
}

.quick-create-control {
  display: grid;
  flex: 0 0 auto;
}

.cover-action-overlay {
  background: var(--fsus-overlay-color, transparent);
}

@media (max-width: 640px) {
  .quick-field-row {
    align-items: stretch;
    flex-direction: column;
  }

  .quick-create-control {
    width: 100%;
  }
}
</style>
