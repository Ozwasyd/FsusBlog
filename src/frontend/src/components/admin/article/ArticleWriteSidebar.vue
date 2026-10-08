<template>
    <section
        class="article-write-sidebar"
        aria-label="发布与文章信息"
    >
        <section
            class="article-sidebar-section"
            aria-labelledby="article-sidebar-publish-title"
        >
            <header class="article-sidebar-section__header">
                <h2 id="article-sidebar-publish-title">发布</h2>
                <p>状态与定时</p>
            </header>
            <div class="article-sidebar-section__body">
                <ElFormItem prop="status">
                    <template #label>
                        <span class="article-field-label"><span>状态</span></span>
                    </template>
                    <div class="mt-2">
                        <ElSelect
                            v-model="form.status"
                            name="articleStatus"
                            aria-label="文章状态"
                            :disabled="submitting"
                            :teleported="false"
                        >
                            <ElOption
                                v-for="item in statusOptions"
                                :key="item.value"
                                :label="item.label"
                                :value="item.value"
                            />
                        </ElSelect>
                    </div>
                </ElFormItem>

                <ElFormItem
                    v-if="form.status === ArticlePublishStatus.Scheduled"
                    prop="scheduledPublishAt"
                >
                    <template #label>
                        <span class="article-field-label"><span>发布时间</span></span>
                    </template>
                    <div class="mt-2">
                        <ElDatePicker
                            v-model="form.scheduledPublishAt"
                            type="datetime"
                            value-format="YYYY-MM-DDTHH:mm:ss"
                            name="articleScheduledPublishAt"
                            aria-label="定时发布时间"
                            :disabled="submitting"
                            :clearable="false"
                        />
                    </div>
                </ElFormItem>
            </div>
        </section>

        <section
            class="article-sidebar-section"
            aria-labelledby="article-sidebar-info-title"
        >
            <header class="article-sidebar-section__header">
                <h2 id="article-sidebar-info-title">文章信息</h2>
                <p>分类、标签和摘要</p>
            </header>
            <div class="article-sidebar-section__body">
                <ElFormItem
                    prop="categoryId"
                    data-article-form-property="categoryId"
                >
                    <template #label>
                        <span class="article-field-label"><span>分类</span></span>
                    </template>
                    <div class="quick-field-row mt-2">
                        <div class="quick-field-control">
                            <ElSelect
                                v-model="form.categoryId"
                                name="articleCategoryId"
                                aria-label="分类"
                                placeholder="选择分类"
                                clearable
                                :disabled="submitting"
                                :teleported="false"
                            >
                                <ElOption
                                    v-for="c in categories"
                                    :key="c.id"
                                    :label="c.name"
                                    :value="c.id"
                                />
                            </ElSelect>
                        </div>
                        <div class="quick-create-control">
                            <ElButton
                                aria-label="新建分类"
                                :loading="quickCreatingCategory"
                                :disabled="submitting || quickCreatingCategory"
                                @click="$emit('open-create-category')"
                            >
                                新建
                            </ElButton>
                        </div>
                    </div>
                </ElFormItem>

                <ElFormItem prop="tagIds">
                    <template #label>
                        <span class="article-field-label"><span>标签</span></span>
                    </template>
                    <div class="quick-field-row mt-2">
                        <div class="quick-field-control">
                            <ElSelect
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
                                <ElOption
                                    v-for="t in tags"
                                    :key="t.id"
                                    :label="t.name"
                                    :value="t.id"
                                />
                            </ElSelect>
                        </div>
                        <div class="quick-create-control">
                            <ElButton
                                aria-label="新建标签"
                                :loading="quickCreatingTag"
                                :disabled="submitting || quickCreatingTag"
                                @click="$emit('open-create-tag')"
                            >
                                新建
                            </ElButton>
                        </div>
                    </div>
                </ElFormItem>

                <ElFormItem
                    class="article-summary-item"
                    prop="summary"
                >
                    <template #label>
                        <div class="flex items-center justify-between w-full">
                            <span class="article-field-label"><span>摘要</span></span>
                        </div>
                    </template>
                    <div class="article-summary-field mt-2">
                        <ElInput
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
                </ElFormItem>
            </div>
        </section>

        <section
            class="article-sidebar-section"
            aria-labelledby="article-sidebar-cover-title"
        >
            <header class="article-sidebar-section__header">
                <h2 id="article-sidebar-cover-title">头图</h2>
                <p>首页和文章页展示图</p>
            </header>
            <div class="article-sidebar-section__body">
                <ElFormItem prop="coverImageUrl">
                    <template #label>
                        <span class="article-field-label"><span>头图</span></span>
                    </template>
                    <div class="article-cover-field mt-2">
                        <div
                            v-if="form.coverImageUrl"
                            class="article-cover-preview"
                        >
                            <img
                                :src="form.coverImageUrl"
                                alt="当前头图预览"
                                class="h-full w-full object-cover"
                            />
                        </div>
                        <div
                            v-else
                            class="article-cover-placeholder"
                        >
                            <strong>未设置</strong>
                            <span>建议比例 16:9。用于首页和文章页展示。</span>
                        </div>
                        <div class="article-cover-actions">
                            <ElButton
                                type="primary"
                                :disabled="submitting"
                                @click="$emit('open-cover-upload')"
                            >
                                {{ form.coverImageUrl ? '更换头图' : '上传头图' }}
                            </ElButton>
                            <ElButton
                                v-if="form.coverImageUrl"
                                type="danger"
                                plain
                                :disabled="submitting"
                                @click="$emit('clear-cover')"
                            >
                                移除
                            </ElButton>
                        </div>
                    </div>
                </ElFormItem>
            </div>
        </section>
    </section>
</template>

<script setup lang="ts">
import { ArticlePublishStatus } from '@/api/article';
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
}>();

defineEmits<{
    (e: 'open-create-category'): void;
    (e: 'open-create-tag'): void;
    (e: 'open-cover-upload'): void;
    (e: 'clear-cover'): void;
}>();
</script>

<style scoped>
.article-write-sidebar
 {
    display: grid;
}

.article-sidebar-section
 {
    border-bottom: 1px solid var(--fsusblog-panel-border);
}

.article-sidebar-section__header
 {
    display: grid;
    gap: 0.25rem;
    border-bottom: 1px solid var(--fsusblog-panel-border);
    padding: 0.75rem 1rem;
}

.article-sidebar-section__header h2,
.article-sidebar-section__header p
 {
    margin: 0;
}

.article-sidebar-section__header h2
 {
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
}

.article-sidebar-section__header p
 {
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.5;
}

.article-sidebar-section__body
 {
    display: grid;
    min-height: 0;
    gap: 1.25rem;
    padding: 1rem;
}

.article-summary-item,
.article-summary-field
 {
    width: 100%;
    min-width: 0;
}

.article-field-label
 {
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
    font-weight: 700;
}

.quick-field-row
 {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    gap: 0.75rem;
}

.quick-field-control
 {
    display: grid;
    min-width: 0;
    flex: 1;
}

.quick-create-control
 {
    display: grid;
    flex: 0 0 auto;
}

.article-cover-field
 {
    display: grid;
    gap: 0.85rem;
}

.article-cover-preview,
.article-cover-placeholder
 {
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border: 1px solid var(--fsusblog-panel-border);
    background: var(--fsusblog-page-bg);
}

.article-cover-placeholder
 {
    display: grid;
    place-content: center;
    gap: 0.35rem;
    padding: 1rem;
    text-align: center;
}

.article-cover-placeholder strong
 {
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
}

.article-cover-placeholder span
 {
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
    line-height: 1.5;
}

.article-cover-actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
}

@media (width <= 640px)
 {
    .quick-field-row
 {
        align-items: stretch;
        flex-direction: column;
    }

    .quick-create-control
 {
        width: 100%;
    }
}

</style>
