<template>
  <AdminTaxonomyManageView :schema="tagSchema" :state="tagTaxonomy" />
</template>

<script setup lang="ts">
import { listAdminTags, type AdminTagItemResponse } from '@/api/authoring'
import { createTag, deleteTag, updateTag } from '@/api/tag'
import AdminTaxonomyManageView from '@/components/admin/AdminTaxonomyManageView.vue'
import { useAdminTaxonomyManage, type TaxonomySchema } from '@/composables/useAdminTaxonomyManage'
import { fsusDialogWidths } from '@/fsusui/dialog'

const tagSchema = {
  kind: 'tag',
  entityLabel: '标签',
  pageClass: 'tag-manage-wrapper',
  pageTitle: '标签管理',
  pageDescription: '',
  summaryAriaLabel: '标签状态',
  summaryDescription: '删除前会检查引用关系。',
  listTitle: '标签列表',
  toolbarLabel: '标签筛选',
  searchPlaceholder: '搜索标签',
  searchAriaLabel: '搜索标签',
  nameColumnLabel: '标签名称',
  nameInputName: 'tagName',
  nameInputLabel: '标签名称',
  nameInputPlaceholder: '标签名称（如：Vue3）',
  dialogWidth: fsusDialogWidths.extraCompact,
  dialogDescription: '变更标签名会即时同步至所有关联博文。建议使用简洁、具有高辨识度的词汇。',
  dialogNoteClass: '',
  dialogNoteGapClass: 'gap-2',
  emptyTitle: '暂无标签',
  filteredEmptyTitle: '没有匹配的标签',
  emptyDescription: '新增标签后可用于文章检索与索引。',
  filteredEmptyDescription: '调整关键词或清除筛选。',
  newButtonLabel: '新增标签',
  editLabel: '重命名',
  compactEditLabel: '改名',
  compactEditIcon: false,
  compactDeleteIcon: false,
  fixActionColumn: false,
  nameDisplay: 'tag',
  nameColumnWidth: { compact: 148, wide: 220 },
  relationColumnWidth: { compact: 96, wide: 150 },
  actionColumnWidth: { compact: 168, wide: 280 },
  articleQueryKey: 'tagId',
  dialogTitle: (editing: boolean) => editing ? '安全重命名' : '新增标签词',
  submitButtonText: '保存变更',
  rules: { name: [
    { required: true, message: '请输入标签名', trigger: 'blur' },
    { min: 1, max: 20, message: '长度需在 1 到 20 字符之间', trigger: 'change' },
    { pattern: /^[^\p{C}<>"'`]+$/u, message: '禁止使用控制字符与 HTML 敏感字符', trigger: 'blur' }
  ] },
  loadItems: listAdminTags,
  createItem: createTag,
  updateItem: updateTag,
  deleteItem: deleteTag,
  loadFallbackMessage: '标签列表同步失败',
  loadFailureLog: 'Tag load failed:',
  duplicateWarning: (name: string) => `标签「${name}」已存在，请直接重命名原标签或换用更明确的名称。`,
  createFallbackMessage: '创建标签失败',
  updateFallbackMessage: '更新标签失败',
  createSuccessMessage: '标签创建成功',
  updateSuccessMessage: '标签已重命名',
  postSaveWarningMessage: '标签已保存，但列表同步失败，请稍后刷新',
  deleteBlockedWarning: (row: AdminTagItemResponse) => `标签「${row.name}」正被 ${row.totalBlockingArticleCount} 篇文章引用，请先查看引用并移除标签。`,
  deleteConfirmMessage: (row: AdminTagItemResponse) => `确定要删除标签「${row.name}」吗？仅未被任何文章引用的标签可以删除。`,
  deleteConfirmTitle: '删除标签',
  deleteSuccessMessage: '标签已删除',
  deleteFallbackMessage: '删除标签失败',
  postDeleteWarningMessage: '标签已删除，但列表同步失败，请稍后刷新',
  relationLockReason: (row: AdminTagItemResponse) =>
    !row.canDelete
      ? `总引用 ${row.totalBlockingArticleCount} 篇：公开 ${row.publicArticleCount}，草稿 ${row.draftArticleCount}，定时 ${row.scheduledArticleCount}，归档 ${row.archivedArticleCount}。请先移除引用后再删除。`
      : '未被引用，可删除'
} satisfies TaxonomySchema<AdminTagItemResponse>

const tagTaxonomy = useAdminTaxonomyManage<AdminTagItemResponse>('tags', tagSchema)
</script>
