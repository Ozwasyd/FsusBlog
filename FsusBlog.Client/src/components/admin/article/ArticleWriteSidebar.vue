<template>
  <section class="admin-form-panel article-write-sidebar" aria-labelledby="article-publish-settings-title">
    <div class="space-y-4">
      <div class="card-header pb-4 mb-4 border-b border-[#F4F4F5] text-sm text-[#374151]">
        <div class="flex items-center justify-between">
          <h2 id="article-publish-settings-title" class="font-bold text-[#3F3F46]">发布设置</h2>
          <el-icon class="text-[#A1A1AA]"><CollectionTag /></el-icon>
        </div>
        <p class="admin-visually-muted mt-2">分类为必填项，摘要为空时会使用正文开头内容。</p>
      </div>

      <el-form-item label="所属分类" prop="categoryId">
        <div class="quick-field-row">
          <el-select v-model="form.categoryId" name="articleCategoryId" aria-label="所属分类" placeholder="选择分类" class="quick-field-control" clearable :disabled="submitting">
            <el-option
              v-for="c in categories"
              :key="c.id"
              :label="c.name"
              :value="c.id"
            />
          </el-select>
          <el-button
            type="default"
            plain
            class="quick-create-button"
            :loading="quickCreatingCategory"
            :disabled="submitting || quickCreatingCategory"
            @click="$emit('open-create-category')"
          >
            新建分类
          </el-button>
        </div>
      </el-form-item>

      <el-form-item label="标签索引" prop="tagIds">
        <div class="quick-field-row">
          <el-select
            v-model="form.tagIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            name="articleTagIds"
            aria-label="文章标签"
            placeholder="关联标签"
            class="quick-field-control"
            :disabled="submitting"
          >
            <el-option
              v-for="t in tags"
              :key="t.id"
              :label="t.name"
              :value="t.id"
            />
          </el-select>
          <el-button
            type="default"
            plain
            class="quick-create-button"
            :loading="quickCreatingTag"
            :disabled="submitting || quickCreatingTag"
            @click="$emit('open-create-tag')"
          >
            新建标签
          </el-button>
        </div>
      </el-form-item>

      <el-divider border-style="dashed" class="my-6!" />

      <el-form-item label="内容摘要" prop="summary">
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
        <div class="flex justify-end mt-2">
          <el-button link type="primary" size="small" @click="$emit('auto-summary')" :disabled="submitting">
            <el-icon class="mr-1"><MagicStick /></el-icon> 智能生成
          </el-button>
        </div>
      </el-form-item>
    </div>
  </section>
</template>
<script setup lang="ts">
import { CollectionTag, MagicStick } from '@element-plus/icons-vue';
import type { CategoryItem } from '@/api/category';
import type { TagItem } from '@/api/tag';

interface ArticleWriteForm {
  title: string;
  content: string;
  summary: string;
  categoryId: number | undefined;
  tagIds: number[];
}

defineProps<{
  form: ArticleWriteForm;
  categories: CategoryItem[];
  tags: TagItem[];
  submitting: boolean;
  quickCreatingCategory: boolean;
  quickCreatingTag: boolean;
}>();

defineEmits<{
  (e: 'auto-summary'): void;
  (e: 'open-create-category'): void;
  (e: 'open-create-tag'): void;
}>();
</script>

<style scoped>
.article-write-sidebar {
  padding: 1.25rem;
}

.quick-field-row {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 0.75rem;
}

.quick-field-control {
  min-width: 0;
  flex: 1;
}

.quick-create-button {
  min-height: 40px;
  flex: 0 0 auto;
  margin-left: 0 !important;
}

@media (max-width: 640px) {
  .quick-field-row {
    align-items: stretch;
    flex-direction: column;
  }

  .quick-create-button {
    width: 100%;
    min-height: 44px;
  }
}
</style>
