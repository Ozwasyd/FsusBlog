<template>
  <section class="article-write-sidebar" aria-label="发布与文章信息">
    <section class="article-sidebar-section" :class="{ 'is-open': publishSectionOpen }">
      <button
        type="button"
        class="article-sidebar-summary"
        :aria-expanded="publishSectionOpen"
        aria-controls="article-sidebar-publish"
        @click="publishSectionOpen = !publishSectionOpen"
      >
        <span class="article-sidebar-summary__copy">
          <span>发布</span>
          <span>状态与定时</span>
        </span>
        <span class="article-sidebar-summary__action" aria-hidden="true">
          <span class="article-sidebar-summary__state article-sidebar-summary__state--closed">展开</span>
          <span class="article-sidebar-summary__state article-sidebar-summary__state--open">收起</span>
          <span class="article-sidebar-summary__chevron"></span>
        </span>
      </button>
      <ElCollapseTransition>
        <div v-show="publishSectionOpen" id="article-sidebar-publish" class="article-sidebar-section__body">
          <el-form-item prop="status">
            <template #label>
              <span class="article-field-label"><span>状态</span></span>
            </template>
            <div class="mt-2">
              <el-select
                v-model="form.status"
                name="articleStatus"
                aria-label="文章状态"
                :disabled="submitting"
                :teleported="false"
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
              <span class="article-field-label"><span>发布时间</span></span>
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
        </div>
      </ElCollapseTransition>
    </section>

    <section class="article-sidebar-section" :class="{ 'is-open': infoSectionOpen }">
      <button
        type="button"
        class="article-sidebar-summary"
        :aria-expanded="infoSectionOpen"
        aria-controls="article-sidebar-info"
        @click="infoSectionOpen = !infoSectionOpen"
      >
        <span class="article-sidebar-summary__copy">
          <span>文章信息</span>
          <span>分类、标签和摘要</span>
        </span>
        <span class="article-sidebar-summary__action" aria-hidden="true">
          <span class="article-sidebar-summary__state article-sidebar-summary__state--closed">展开</span>
          <span class="article-sidebar-summary__state article-sidebar-summary__state--open">收起</span>
          <span class="article-sidebar-summary__chevron"></span>
        </span>
      </button>
      <ElCollapseTransition>
        <div v-show="infoSectionOpen" id="article-sidebar-info" class="article-sidebar-section__body">
          <el-form-item prop="categoryId">
            <template #label>
              <span class="article-field-label"><span>分类</span></span>
            </template>
            <div class="quick-field-row mt-2">
              <div class="quick-field-control">
                <el-select
                  v-model="form.categoryId"
                  name="articleCategoryId"
                  aria-label="分类"
                  placeholder="选择分类"
                  clearable
                  :disabled="submitting"
                  :teleported="false"
                >
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
              <span class="article-field-label"><span>标签</span></span>
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
                  :teleported="false"
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

          <el-form-item class="article-summary-item" prop="summary">
            <template #label>
              <div class="flex items-center justify-between w-full">
                <span class="article-field-label"><span>摘要</span></span>
              </div>
            </template>
            <div class="article-summary-field mt-2">
              <el-input
                v-model="form.summary"
                :csp-safe="true"
                name="articleSummary"
                type="textarea"
                :rows="10"
                aria-label="摘要"
                placeholder="留空时使用正文开头。"
                maxlength="250"
                show-word-limit
                :disabled="submitting"
              />
            </div>
          </el-form-item>
        </div>
      </ElCollapseTransition>
    </section>

    <section class="article-sidebar-section" :class="{ 'is-open': coverSectionOpen }">
      <button
        type="button"
        class="article-sidebar-summary"
        :aria-expanded="coverSectionOpen"
        aria-controls="article-sidebar-cover"
        @click="coverSectionOpen = !coverSectionOpen"
      >
        <span class="article-sidebar-summary__copy">
          <span>头图</span>
          <span>首页和文章页展示图</span>
        </span>
        <span class="article-sidebar-summary__action" aria-hidden="true">
          <span class="article-sidebar-summary__state article-sidebar-summary__state--closed">展开</span>
          <span class="article-sidebar-summary__state article-sidebar-summary__state--open">收起</span>
          <span class="article-sidebar-summary__chevron"></span>
        </span>
      </button>
      <ElCollapseTransition>
        <div v-show="coverSectionOpen" id="article-sidebar-cover" class="article-sidebar-section__body">
          <el-form-item prop="coverImageUrl">
            <template #label>
              <span class="article-field-label"><span>头图</span></span>
            </template>
            <div class="article-cover-field mt-2">
              <div v-if="form.coverImageUrl" class="article-cover-preview">
                <img
                  :src="form.coverImageUrl"
                  alt="当前头图预览"
                  class="h-full w-full object-cover"
                />
              </div>
              <div v-else class="article-cover-placeholder">
                <strong>未设置</strong>
                <span>建议比例 16:9。用于首页和文章页展示。</span>
              </div>
              <div class="article-cover-actions">
                <el-button
                  type="primary"
                  :disabled="submitting"
                  @click="$emit('open-cover-upload')"
                >
                  {{ form.coverImageUrl ? '更换头图' : '上传头图' }}
                </el-button>
                <el-button
                  v-if="form.coverImageUrl"
                  type="danger"
                  plain
                  :disabled="submitting"
                  @click="$emit('clear-cover')"
                >
                  移除
                </el-button>
              </div>
            </div>
          </el-form-item>
        </div>
      </ElCollapseTransition>
    </section>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ArticlePublishStatus } from '@/api/article'
import type { CategoryItem } from '@/api/category'
import type { TagItem } from '@/api/tag'
import { ElCollapseTransition } from '@/fsusui/motion'

interface ArticleWriteForm {
  title: string
  content: string
  summary: string
  coverImageUrl?: string
  categoryId: number | undefined
  tagIds: number[]
  status: ArticlePublishStatus
  scheduledPublishAt: string
}

const statusOptions = [
  { label: '草稿', value: ArticlePublishStatus.Draft },
  { label: '定时', value: ArticlePublishStatus.Scheduled },
  { label: '发布', value: ArticlePublishStatus.Published },
  { label: '归档', value: ArticlePublishStatus.Archived }
] as const

defineProps<{
  form: ArticleWriteForm
  categories: CategoryItem[]
  tags: TagItem[]
  submitting: boolean
  quickCreatingCategory: boolean
  quickCreatingTag: boolean
}>()

defineEmits<{
  (e: 'open-create-category'): void
  (e: 'open-create-tag'): void
  (e: 'open-cover-upload'): void
  (e: 'clear-cover'): void
}>()

const publishSectionOpen = ref(true)
const infoSectionOpen = ref(true)
const coverSectionOpen = ref(false)
</script>

<style scoped>
.article-write-sidebar {
  display: grid;
}

.article-sidebar-section {
  border-bottom: 1px solid var(--fsusblog-panel-border);
}

.article-sidebar-summary {
  display: flex;
  cursor: pointer;
  width: 100%;
  border: 0;
  list-style: none;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 3.75rem;
  padding: 0.75rem 1rem;
  background: transparent;
  color: var(--fsusblog-text-primary);
  font-size: 0.875rem;
  font-weight: 700;
  text-align: left;
  transition:
    background-color var(--blog-motion-fast) var(--blog-motion-ease),
    color var(--blog-motion-fast) var(--blog-motion-ease);
}

.article-sidebar-summary:hover {
  background: color-mix(in srgb, var(--fsusblog-text-primary) 4%, transparent);
}

.article-sidebar-summary:focus-visible {
  outline: 2px solid var(--fsusblog-color-focus-ring);
  outline-offset: -2px;
}

.article-sidebar-summary::-webkit-details-marker {
  display: none;
}

.article-sidebar-summary__copy {
  display: grid;
  min-width: 0;
  gap: 0.18rem;
}

.article-sidebar-summary__copy > span + span {
  color: var(--fsusblog-text-tertiary);
  font-size: 0.75rem;
  font-weight: 500;
}

.article-sidebar-summary__action {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.45rem;
  border: 1px solid var(--fsusblog-panel-border);
  padding: 0.28rem 0.48rem;
  color: var(--fsusblog-text-secondary);
  font-size: 0.75rem;
  font-weight: 700;
}

.article-sidebar-summary__state--open {
  display: none;
}

.article-sidebar-section.is-open > .article-sidebar-summary .article-sidebar-summary__state--closed {
  display: none;
}

.article-sidebar-section.is-open > .article-sidebar-summary .article-sidebar-summary__state--open {
  display: inline;
}

.article-sidebar-summary__chevron {
  width: 0.42rem;
  height: 0.42rem;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  transform: translateY(-0.1rem) rotate(45deg);
  transition: transform var(--blog-motion-fast) var(--blog-motion-ease);
}

.article-sidebar-section.is-open > .article-sidebar-summary .article-sidebar-summary__chevron {
  transform: translateY(0.08rem) rotate(225deg);
}

.article-sidebar-section__body {
  display: grid;
  min-height: 0;
  overflow: hidden;
  gap: 1.25rem;
  padding: 1rem;
}

.article-sidebar-section.is-open > .article-sidebar-section__body {
  overflow: visible;
}

.article-summary-item,
.article-summary-item :deep(.el-form-item__content),
.article-summary-field,
.article-summary-field :deep(.el-textarea) {
  width: 100%;
  min-width: 0;
}

.article-summary-field :deep(.el-textarea__inner) {
  min-height: 12rem;
  resize: vertical;
}

.article-field-label {
  color: var(--fsusblog-text-secondary);
  font-size: 0.875rem;
  font-weight: 700;
}

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

.article-cover-field {
  display: grid;
  gap: 0.85rem;
}

.article-cover-preview,
.article-cover-placeholder {
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg);
}

.article-cover-placeholder {
  display: grid;
  place-content: center;
  gap: 0.35rem;
  padding: 1rem;
  text-align: center;
}

.article-cover-placeholder strong {
  color: var(--fsusblog-text-secondary);
  font-size: 0.875rem;
}

.article-cover-placeholder span {
  color: var(--fsusblog-text-tertiary);
  font-size: 0.75rem;
  line-height: 1.5;
}

.article-cover-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
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

@media (prefers-reduced-motion: reduce) {
  .article-sidebar-summary__chevron {
    transition: none;
  }
}
</style>
