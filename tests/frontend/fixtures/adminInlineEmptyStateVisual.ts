import { createApp, h, nextTick, ref } from 'vue'

import '@/assets/main.css'
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'
import contract from './admin-inline-empty-state-contract.json' with { type: 'json' }

const fixtureHost = document.getElementById('admin-inline-empty-state-fixture')
if (!fixtureHost) {
  throw new Error('admin_inline_empty_state_fixture_host_missing')
}

document.body.className = 'account-shell'
fixtureHost.style.width = 'min(calc(100% - 2rem), 64rem)'
fixtureHost.style.margin = '1.5rem auto'

type FixtureState = 'neutral' | 'error' | 'loading'

const scenarioByCaller = {
  article: {
    title: '暂无文章',
    description: '调整筛选条件后重试。',
    state: 'neutral' as FixtureState,
    className: 'article-list-empty-state'
  },
  queue: {
    title: '审核队列读取失败',
    description: '请稍后重试。',
    state: 'error' as FixtureState,
    className: 'queue-empty-state'
  },
  anonymous: {
    title: '正在读取匿名主体记录',
    description: '审核记录载入后会显示在这里。',
    state: 'loading' as FixtureState,
    className: 'anonymous-governance-empty'
  }
} as const

const callers = contract.consumerRepresentatives
  .filter((entry) => entry.visualRepresentative)
  .map((entry) => ({ key: entry.id, ...scenarioByCaller[entry.id as keyof typeof scenarioByCaller] }))
const lastAction = ref('none')

createApp({
  render: () => h('main', {
    style: 'display:grid;gap:1rem',
    'aria-label': 'Admin inline empty state fixture'
  }, [
    ...callers.map((caller) => h('section', {
      'data-caller': caller.key,
      style: 'border:1px solid var(--fsusblog-panel-border)'
    }, [
      h(AdminInlineEmptyState, {
        class: caller.className,
        title: caller.title,
        description: caller.description,
        state: caller.state,
        'data-visual-authority': contract.visualDiagnostics.authorities.join(',')
      }, caller.key === 'article'
        ? {
            actions: () => [
              h('button', {
                type: 'button',
                onClick: () => { lastAction.value = 'clear-filter' }
              }, '清除筛选'),
              h('button', { type: 'button', disabled: true }, '写新文章')
            ]
          }
        : undefined)
    ])),
    h('p', {
      'data-last-action': lastAction.value,
      role: 'status',
      'aria-label': 'Empty state action result'
    }, lastAction.value === 'clear-filter' ? '筛选已清除' : '尚未执行操作')
  ])
}).mount(fixtureHost)

await nextTick()
document.documentElement.dataset.adminInlineEmptyStateFixtureReady = 'true'
