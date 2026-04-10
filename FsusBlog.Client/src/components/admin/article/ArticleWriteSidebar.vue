<template>
  <div class="sticky-sidebar space-y-4">
    <el-card shadow="never" class="border-zinc-100 rounded-xl shadow-sm">
      <template #header>
        <div class="flex items-center justify-between">
          <span class="font-bold text-zinc-700">博文发布配置</span>
          <el-icon class="text-zinc-400"><CollectionTag /></el-icon>
        </div>
      </template>

      <el-form-item label="所属分类" prop="categoryId">
        <el-select v-model="form.categoryId" placeholder="选择分类" class="w-full" clearable :disabled="submitting">
          <el-option
            v-for="c in categories"
            :key="c.id"
            :label="c.name"
            :value="c.id"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="标签索引" prop="tagIds">
        <el-select
          v-model="form.tagIds"
          multiple
          collapse-tags
          collapse-tags-tooltip
          placeholder="关联标签"
          class="w-full"
          :disabled="submitting"
        >
          <el-option
            v-for="t in tags"
            :key="t.id"
            :label="t.name"
            :value="t.id"
          />
        </el-select>
      </el-form-item>

      <el-divider border-style="dashed" class="my-6!" />

      <el-form-item label="内容摘要" prop="summary">
        <el-input
          v-model="form.summary"
          type="textarea"
          :rows="6"
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
    </el-card>
  </div>
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
}>();

defineEmits<{
  (e: 'auto-summary'): void;
}>();
</script>

