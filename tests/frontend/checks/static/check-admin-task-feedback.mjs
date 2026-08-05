#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')
const errors = []
const textExtensions = new Set(['.ts', '.tsx', '.vue', '.js', '.mjs'])

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function requireFile(path) {
  if (!existsSync(resolve(repoRoot, path))) {
    errors.push(`missing ${path}`)
  }
}

function forbidFile(path) {
  if (existsSync(resolve(repoRoot, path))) {
    errors.push(`unexpected ${path}`)
  }
}

function requireIncludes(path, tokens) {
  const source = read(path)
  for (const token of tokens) {
    if (!source.includes(token)) {
      errors.push(`${path}: missing ${token}`)
    }
  }
}

function forbidIncludes(path, tokens) {
  const source = read(path)
  for (const token of tokens) {
    if (source.includes(token)) {
      errors.push(`${path}: forbidden ${token}`)
    }
  }
}

function scanTextFiles(rootPath, callback) {
  const absoluteRoot = resolve(repoRoot, rootPath)
  const entries = readdirSync(absoluteRoot, { withFileTypes: true })
  for (const entry of entries) {
    const absolutePath = join(absoluteRoot, entry.name)
    if (entry.isDirectory()) {
      scanTextFiles(absolutePath, callback)
      continue
    }

    if (!entry.isFile() || !textExtensions.has(extname(entry.name))) {
      continue
    }

    const relativePath = absolutePath.slice(repoRoot.length + 1)
    callback(relativePath, readFileSync(absolutePath, 'utf8'))
  }
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length
}

function validateOpsHealthContract(source) {
  const violations = []
  const stateTags = countMatches(source, /<FsusUiEmptyState\b/gu)
  const actionTags = countMatches(source, /<ElButton\b/gu)
  const stateTag = source.match(/<FsusUiEmptyState\b[\s\S]*?>/u)?.[0] ?? ''
  const actionTag = source.match(/<ElButton\b[\s\S]*?>/u)?.[0] ?? ''
  const toastCalls = countMatches(source, /\bshowErrorToast\s*\(/gu)
  const nativeControls =
    countMatches(source, /<(?:button|input|select|textarea)\b/giu) +
    countMatches(source, /<a\b[^>]*\bhref\s*=/giu)
  const componentImports = [...source.matchAll(/from\s+['"](@\/components\/[^'"]+)['"]/gu)].map((match) => match[1])

  if (stateTags !== 1) {
    violations.push(`OpsHealth must use exactly one FsusUiEmptyState tag, got ${stateTags}`)
  }
  if (source.includes('FsusUiResult') || source.includes('<ElResult')) {
    violations.push('OpsHealth must keep the frozen compact EmptyState choice and reject Result')
  }
  for (const token of [
    'size="compact"',
    ':illustration="false"',
    'data-ops-health-state',
    'data-ops-health-failure-reason',
    'data-ops-health-retry',
    '#description',
    'id="ops-health-failure-reason"',
    'aria-describedby="ops-health-failure-reason"',
    ':loading=',
    ':disabled=',
    'showErrorToast',
    'if (activeRequest)',
    'return activeRequest',
    '正在读取运维状态…',
    '正在重新读取运维状态…',
    '运维状态暂不可用',
    'AbortController',
    'onUnmounted',
    'signal'
  ]) {
    if (!source.includes(token)) {
      violations.push(`OpsHealth missing ${token}`)
    }
  }
  if (actionTags !== 1) {
    violations.push(`OpsHealth must expose exactly one ElButton retry action, got ${actionTags}`)
  }
  if (stateTag.includes('role="alert"') || stateTag.includes("'alert'") || stateTag.includes('assertive')) {
    violations.push('OpsHealth inline failure must not create an assertive live region')
  }
  if (toastCalls !== 1) {
    violations.push(`OpsHealth must call showErrorToast exactly once per admitted failure path, got ${toastCalls}`)
  }
  if (/\b(?:hidden|aria-hidden|v-show)\b/u.test(actionTag)) {
    violations.push('OpsHealth retry action must remain visible and discoverable')
  }
  if (nativeControls !== 0) {
    violations.push(`OpsHealth source contains ${nativeControls} native interactive control(s)`)
  }
  if (componentImports.some((path) => path !== '@/components/admin/OpsHealthWorkbench.vue')) {
    violations.push('OpsHealth must not move feedback or retry into a Blog wrapper component')
  }
  for (const token of [
    'AdminInlineEmptyState',
    'OpsRetryButton',
    'AdminErrorPanel',
    '.ops-health-loading button',
    ':deep(',
    '.el-',
    'resolveComponent(',
    'FSUSBLOG_USE_LOCAL_FSUSUI',
    'FSUSBLOG_LOCAL_FSUSUI_ROOT'
  ]) {
    if (source.includes(token)) {
      violations.push(`OpsHealth forbidden ${token}`)
    }
  }

  return violations
}

function requireOpsHealthMutationRejected(label, source, expected) {
  const mutationViolations = validateOpsHealthContract(source)
  if (!mutationViolations.some((message) => message.includes(expected))) {
    errors.push(`OpsHealth mutation ${label} was not rejected for ${expected}`)
  }
}

requireFile('src/frontend/src/composables/useAdminTaskFeedback.ts')
forbidFile('src/frontend/src/components/admin/AdminTaskFeedbackBar.vue')

requireIncludes('src/frontend/src/fsusui/feedback.ts', [
  'detail?: string',
  'aria-live',
  'partial:',
  "type: 'warning'",
  'formatToastMessage'
])

requireIncludes('src/frontend/src/composables/useAdminTaskFeedback.ts', [
  "import { toast } from '@/fsusui/feedback'",
  'toast.info({',
  'toast.success({',
  'toast.partial({',
  'toast.error({',
  'DEFAULT_TOAST_DURATION_MS'
])

const requiredSurfaces = [
  ['src/frontend/src/views/admin/article/Write.vue', ['blog-motion-task-region', 'article-submit']],
  ['src/frontend/src/composables/useAdminArticleWrite.ts', ['taskFeedback.begin', 'taskFeedback.succeed', 'taskFeedback.fail', 'article-prepublish', 'article-revision', 'article-assets']],
  ['src/frontend/src/views/admin/CommentModeration.vue', ['taskFeedbackHighlightedIds']],
  ['src/frontend/src/composables/useCommentModerationActions.ts', ['正在审核评论', '正在批量审核评论', 'taskFeedback.partial']],
  ['src/frontend/src/views/admin/security/SecurityCrawler.vue', ['security-crawler-ranges', 'risk:${snapshot.subject}']],
  ['src/frontend/src/views/admin/security/SecurityPow.vue', ['security-pow-options']],
  ['src/frontend/src/views/admin/Integrity.vue', ['integrity-report', '正在应用安全修复']],
  ['src/frontend/src/views/admin/ContentTools.vue', ['content-export', 'content-import']],
  ['src/frontend/src/views/admin/Settings.vue', ['settings-site', 'settings-compliance', 'settings-page']],
  ['src/frontend/src/views/admin/moderation/ModerationDictionaries.vue', ['moderation-dictionaries-runtime']],
  ['src/frontend/src/views/admin/moderation/ModerationModel.vue', ['moderation-model-runtime']],
  ['src/frontend/src/views/admin/moderation/ModerationDashboard.vue', ['moderation-global-runtime']],
  ['src/frontend/src/views/user/Messages.vue', ['isAdminConversationHighlighted']],
  ['src/frontend/src/composables/useAdminMessageCenter.ts', ['taskFeedback.begin', '正在发送站内信回复', '正在发送系统消息']]
]

for (const [path, tokens] of requiredSurfaces) {
  requireIncludes(path, tokens)
  forbidIncludes(path, ['AdminTaskFeedbackBar'])
}

scanTextFiles('src/frontend/src', (path, source) => {
  if (source.includes('AdminTaskFeedbackBar')) {
    errors.push(`${path}: forbidden AdminTaskFeedbackBar`)
  }
})

const opsHealthPath = 'src/frontend/src/views/admin/OpsHealth.vue'
const opsHealthTestPath = 'tests/frontend/unit/views/OpsHealth.test.ts'
const opsHealthContractPath = 'tests/frontend/fixtures/ops-health-state-contract.json'
const opsHealthSource = read(opsHealthPath)
const opsHealthTestSource = read(opsHealthTestPath)
const opsHealthContract = JSON.parse(read(opsHealthContractPath))

errors.push(...validateOpsHealthContract(opsHealthSource).map((message) => `${opsHealthPath}: ${message}`))

if (
  opsHealthContract.schema !== 'fsusblog-ops-health-state-contract.v1' ||
  opsHealthContract.issue !== 1896 ||
  opsHealthContract.componentChoice?.stateComponent !== 'FsusUiEmptyState' ||
  opsHealthContract.componentChoice?.size !== 'compact' ||
  opsHealthContract.componentChoice?.actionComponent !== 'ElButton' ||
  opsHealthContract.states?.find((state) => state.id === 'failure')?.assertiveLiveRegions !== 1 ||
  opsHealthContract.states?.find((state) => state.id === 'failure')?.inlineAnnunciation !== 'off' ||
  opsHealthContract.states?.find((state) => state.id === 'failure')?.retryDescribedBy !==
    'ops-health-failure-reason'
) {
  errors.push(`${opsHealthContractPath}: invalid frozen component contract`)
}

for (const token of [
  'announces initial loading without flashing the failure reason, alert, toast or retry action',
  'replaces initial loading with the workbench after success and leaves no inline failure state',
  'uses one real toast and a visible described failure reason',
  'prevents duplicate retry announcements and clears inline state on success',
  'adds exactly one toast and one assertive announcement for each newly admitted retry failure',
  'coalesces repeated workbench refresh while the current request is pending',
  'aborts the in-flight request on unmount so a stale response cannot commit, toast or announce',
  "document.querySelectorAll('[aria-live=\"assertive\"]')",
  "document.querySelectorAll('.el-message')",
  'aria-describedby',
  'toHaveBeenCalledTimes(2)',
  'capturedSignal?.aborted'
]) {
  if (!opsHealthTestSource.includes(token)) {
    errors.push(`${opsHealthTestPath}: missing behavior proof ${token}`)
  }
}

const requiredForbiddenMutations = [
  'native-retry-moved-to-child',
  'second-native-retry-inside-result',
  'inline-failure-restores-assertive-live-region',
  'failure-calls-toast-twice',
  'initial-loading-shows-failure',
  'double-click-starts-concurrent-loads',
  'toast-only-without-recovery-action',
  'toast-only-without-inline-reason',
  'hidden-retry-action',
  'private-el-selector-css',
  'published-mode-falls-back-to-legacy-dom'
]
for (const mutation of requiredForbiddenMutations) {
  if (!opsHealthContract.forbiddenMutations?.includes(mutation)) {
    errors.push(`${opsHealthContractPath}: missing forbidden mutation ${mutation}`)
  }
}

const validOpsHealthFixture = `
<template>
  <FsusUiEmptyState
    size="compact"
    :illustration="false"
    :role="loading ? 'status' : undefined"
    :aria-live="loading ? 'polite' : 'off'"
    data-ops-health-state
  >
    <template v-if="failure" #description>
      <span id="ops-health-failure-reason" data-ops-health-failure-reason>{{ failure }}</span>
    </template>
    <template v-if="failure" #actions>
      <ElButton
        data-ops-health-retry
        aria-describedby="ops-health-failure-reason"
        :loading="loading"
        :disabled="loading"
      />
    </template>
  </FsusUiEmptyState>
</template>
<script setup>
import { computed, onUnmounted } from 'vue'
import OpsHealthWorkbench from '@/components/admin/OpsHealthWorkbench.vue'
import { showErrorToast } from '@/utils/errorPresentation'
const stateTitle = computed(() => {
  if (loading.value) {
    return failure.value ? '正在重新读取运维状态…' : '正在读取运维状态…'
  }
  return '运维状态暂不可用'
})
let activeRequest = null
const controller = new AbortController()
function loadHealth() {
  if (activeRequest) return activeRequest
  activeRequest = (async () => {
    try {
      await getOpsHealth({ signal: controller.signal })
    } catch (error) {
      failure.value = showErrorToast(error, '服务与后台状态加载失败')
    }
  })()
  return activeRequest
}
onUnmounted(() => controller.abort())
</script>`
if (validateOpsHealthContract(validOpsHealthFixture).length !== 0) {
  errors.push('OpsHealth validator rejected its conforming control fixture')
}
requireOpsHealthMutationRejected(
  'native retry moved to child',
  validOpsHealthFixture.replace(
    "import OpsHealthWorkbench from '@/components/admin/OpsHealthWorkbench.vue'",
    "import OpsRetryButton from '@/components/admin/OpsRetryButton.vue'"
  ),
  'Blog wrapper component'
)
requireOpsHealthMutationRejected(
  'second native retry inside result',
  validOpsHealthFixture.replace('</FsusUiEmptyState>', '<button>retry</button></FsusUiEmptyState>'),
  'native interactive control'
)
const opsHealthAnnouncementMutations = [
  [
    'inline failure restores assertive live region',
    validOpsHealthFixture.replace(
      'data-ops-health-state',
      'role="alert" aria-live="assertive" data-ops-health-state'
    ),
    'inline failure must not create an assertive live region'
  ],
  [
    'failure calls toast twice',
    validOpsHealthFixture.replace(
      "failure.value = showErrorToast(error, '服务与后台状态加载失败')",
      "showErrorToast(error, '服务与后台状态加载失败'); failure.value = showErrorToast(error, '服务与后台状态加载失败')"
    ),
    'showErrorToast exactly once'
  ],
  [
    'double click starts concurrent loads',
    validOpsHealthFixture.replace('if (activeRequest) return activeRequest', ''),
    'missing if (activeRequest)'
  ],
  [
    'initial loading shows failure',
    validOpsHealthFixture.replace('正在读取运维状态…', '运维状态暂不可用'),
    'missing 正在读取运维状态…'
  ],
  [
    'toast only without inline reason',
    validOpsHealthFixture.replace(/<template v-if="failure" #description>[\s\S]*?<\/template>/u, ''),
    'missing data-ops-health-failure-reason'
  ],
  [
    'hidden retry',
    validOpsHealthFixture.replace('<ElButton', '<ElButton hidden'),
    'retry action must remain visible'
  ]
]
for (const [label, source, expected] of opsHealthAnnouncementMutations) {
  requireOpsHealthMutationRejected(label, source, expected)
}
requireOpsHealthMutationRejected(
  'toast only',
  validOpsHealthFixture.replace(/<ElButton[\s\S]*?\/>/u, ''),
  'exactly one ElButton'
)
requireOpsHealthMutationRejected(
  'private selector',
  `${validOpsHealthFixture}<style>.el-button { min-width: 10rem; }</style>`,
  'forbidden .el-'
)
requireOpsHealthMutationRejected(
  'published fallback',
  `${validOpsHealthFixture}<script>if (FSUSBLOG_USE_LOCAL_FSUSUI) { resolveComponent('legacy') }</script>`,
  'forbidden resolveComponent('
)
requireOpsHealthMutationRejected(
  'Blog wrapper',
  validOpsHealthFixture.replace(
    "import OpsHealthWorkbench from '@/components/admin/OpsHealthWorkbench.vue'",
    "import OpsRetryButton from '@/components/admin/OpsRetryButton.vue'"
  ),
  'Blog wrapper component'
)

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[admin-task-feedback] ${error}`)
  }
  process.exit(1)
}

console.log(`[admin-task-feedback] ok surfaces=${requiredSurfaces.length}`)
