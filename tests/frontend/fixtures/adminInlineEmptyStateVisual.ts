import { createApp, h, nextTick } from 'vue'

import '@/assets/main.css'
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'

const fixtureHost = document.getElementById('admin-inline-empty-state-fixture')
if (!fixtureHost) {
  throw new Error('admin_inline_empty_state_fixture_host_missing')
}

document.body.className = 'account-shell'
fixtureHost.style.width = 'min(calc(100% - 2rem), 64rem)'
fixtureHost.style.margin = '1.5rem auto'

const callers = [
  { key: 'article', title: '暂无文章', description: '调整筛选条件后重试。', className: 'article-list-empty-state' },
  { key: 'category', title: '暂无分类', description: '创建分类后会显示在这里。', className: 'taxonomy-empty-state' },
  { key: 'user', title: '暂无用户', description: '当前查询没有匹配用户。', className: 'user-empty-state' },
  { key: 'queue', title: '审核队列为空', description: '新的待审评论会显示在这里。', className: 'queue-empty-state' },
  { key: 'anonymous', title: '主体记录为空', description: '匿名评论进入审核队列后显示。', className: 'anonymous-governance-empty' }
] as const

createApp({
  render: () => h('main', {
    style: 'display:grid;gap:1rem',
    'aria-label': 'Admin inline empty state fixture'
  }, callers.map((caller) => h('section', {
    'data-caller': caller.key,
    style: 'border:1px solid var(--fsusblog-panel-border)'
  }, [
    h(AdminInlineEmptyState, {
      class: caller.className,
      title: caller.title,
      description: caller.description
    })
  ])))
}).mount(fixtureHost)

await nextTick()
document.documentElement.dataset.adminInlineEmptyStateFixtureReady = 'true'
