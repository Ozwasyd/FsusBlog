<template>
    <AdminTaxonomyManageView
        :schema="categorySchema"
        :state="categoryTaxonomy"
    />
</template>

<script setup lang="ts">
defineOptions({ name: 'CategoryManagePage' });
import { listAdminCategories, type AdminCategoryItemResponse } from '@/api/authoring';
import { createCategory, deleteCategory, getCategoryExactMetadata, updateCategory } from '@/api/category';
import AdminTaxonomyManageView from '@/components/admin/AdminTaxonomyManageView.vue';
import { useAdminTaxonomyManage, type TaxonomySchema } from '@/composables/useAdminTaxonomyManage';
import { fsusDialogWidths } from '@/fsusui/dialog';

const categorySchema = {
    kind: 'category',
    entityLabel: '分类',
    pageClass: 'category-manage-wrapper',
    pageTitle: '分类管理',
    pageDescription: '',
    summaryAriaLabel: '分类概况',
    summaryDescription: '删除前会检查引用关系。',
    listTitle: '分类列表',
    toolbarLabel: '分类筛选',
    searchPlaceholder: '搜索分类',
    searchAriaLabel: '搜索分类',
    nameColumnLabel: '分类名称',
    nameInputName: 'categoryName',
    nameInputLabel: '分类名称',
    nameInputPlaceholder: '请输入 2-20 个字符的名称',
    descriptionInputName: 'categoryDescription',
    descriptionInputLabel: '分类描述',
    descriptionInputPlaceholder: '可选，最多 500 个字符',
    dialogWidth: fsusDialogWidths.extraCompact,
    dialogDescription: '变更分类名称会即时同步至主站导航。建议使用通用、简洁的语义词汇。',
    dialogNoteClass: 'italic',
    dialogNoteGapClass: 'gap-5',
    emptyTitle: '暂无分类',
    filteredEmptyTitle: '没有匹配的分类',
    emptyDescription: '新增分类后可用于文章归档与导航组织。',
    filteredEmptyDescription: '调整关键词或清除筛选。',
    newButtonLabel: '新增分类',
    editLabel: '编辑',
    compactEditLabel: '编辑',
    compactEditIcon: true,
    compactDeleteIcon: true,
    fixActionColumn: true,
    nameDisplay: 'text',
    nameColumnWidth: { compact: 148, wide: 200 },
    relationColumnWidth: { compact: 96, wide: 150 },
    actionColumnWidth: { compact: 156, wide: 300 },
    articleQueryKey: 'categoryId',
    dialogTitle: (editing: boolean) => editing ? '修改分类属性' : '创建全站分类',
    submitButtonText: '确认提交',
    rules: { name: [
        { required: true, message: '名称不能为空', trigger: 'blur' },
        { min: 2, max: 20, message: '长度需在 2 到 20 字符之间', trigger: 'change' },
        { pattern: /^[^<|>|'|"]+$/, message: '禁止使用特殊 HTML 字符', trigger: 'blur' }
    ] },
    loadItems: listAdminCategories,
    loadExactMetadata: getCategoryExactMetadata,
    createItem: createCategory,
    updateItem: updateCategory,
    deleteItem: deleteCategory,
    loadFallbackMessage: '无法同步全站分类数据',
    loadFailureLog: 'Category load failed:',
    loadExactMetadataFallbackMessage: '无法读取分类描述',
    loadExactMetadataFailureLog: 'Category exact metadata load failed:',
    duplicateWarning: (name: string) => `分类「${name}」已存在，请直接编辑原分类或换用更明确的名称。`,
    createFallbackMessage: '创建分类失败',
    updateFallbackMessage: '更新分类失败',
    createSuccessMessage: '全站新分类已同步',
    updateSuccessMessage: '分类元数据更新成功',
    postSaveWarningMessage: '分类已保存，但列表同步失败，请稍后刷新',
    deleteBlockedWarning: (row: AdminCategoryItemResponse) => `分类「${row.name}」正被 ${row.totalBlockingArticleCount} 篇文章占用，禁止删除。`,
    deleteConfirmMessage: (row: AdminCategoryItemResponse) => `确定要删除分类「${row.name}」吗？该操作无法撤销。`,
    deleteConfirmTitle: '删除分类',
    deleteSuccessMessage: '分类已删除',
    deleteFallbackMessage: '删除分类失败',
    postDeleteWarningMessage: '分类已删除，但列表同步失败，请稍后刷新',
    relationLockReason: (row: AdminCategoryItemResponse) =>
        !row.canDelete
            ? `总引用 ${row.totalBlockingArticleCount} 篇：公开 ${row.publicArticleCount}，草稿 ${row.draftArticleCount}，定时 ${row.scheduledArticleCount}，归档 ${row.archivedArticleCount}。请先迁移后再删除。`
            : '未关联文章，可删除'
} satisfies TaxonomySchema<AdminCategoryItemResponse>;

const categoryTaxonomy = useAdminTaxonomyManage<AdminCategoryItemResponse>('categories', categorySchema);
</script>
