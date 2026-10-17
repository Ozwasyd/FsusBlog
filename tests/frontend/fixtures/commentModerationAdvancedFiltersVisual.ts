import { createApp, h, reactive } from 'vue'

import '@/assets/main.css'
import CommentModerationAdvancedFilters from '@/components/admin/comment-moderation/CommentModerationAdvancedFilters.vue'
import { CommentModerationStatus } from '@/api/authoring'
import type { CommentModerationFilters } from '@/composables/useCommentModerationQueue'
import FsusUI from '@ozwasyd/element-plus'

const filters = reactive<CommentModerationFilters>({
  status: CommentModerationStatus.Pending,
  keyword: '',
  article: '42',
  user: '',
  hitReason: '',
  blockedRegion: '',
  modelLabel: '',
  modelProvider: '',
  dateRange: null,
})
const removed = reactive<string[]>([])
const host = document.getElementById('advanced-filters-fixture')
if (!host) throw new Error('advanced_filters_fixture_host_missing')

createApp({
  render: () => h('main', [
    h('h1', 'Comment moderation advanced filters'),
    h(CommentModerationAdvancedFilters, {
      filters,
      loading: false,
      hitReasonOptions: [],
      blockedRegionOptions: [],
      modelLabelOptions: [],
      modelRuntimeOptions: [],
      activeFilters: [
        ...(filters.article ? [{ key: 'article' as const, label: `文章：${filters.article}` }] : []),
        ...(filters.user ? [{ key: 'user' as const, label: `用户：${filters.user}` }] : []),
      ],
      'onUpdate:article': (value: string) => { filters.article = value },
      'onUpdate:user': (value: string) => { filters.user = value },
      'onRemove-filter': (key: string) => {
        removed.push(key)
        if (key === 'article') filters.article = ''
        if (key === 'user') filters.user = ''
      },
    }),
    h('output', { 'aria-label': 'Removed filters' }, removed.join(',')),
  ]),
}).use(FsusUI).mount(host)
