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
    'data-ops-health-retry',
    ':loading=',
    ':disabled=',
    'showErrorToast',
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
  opsHealthContract.componentChoice?.actionComponent !== 'ElButton'
) {
  errors.push(`${opsHealthContractPath}: invalid frozen component contract`)
}

for (const token of [
  'announces initial loading without flashing the failure reason or retry action',
  'replaces initial loading with the workbench after success',
  'exposes the mapped failure reason and one keyboard-discoverable FsusUI retry action',
  'admits only one retry request, exposes loading and disabled, then replaces feedback with success',
  'coalesces repeated workbench refresh while the current request is pending',
  'aborts the in-flight request on unmount so a stale response cannot commit',
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
  'initial-loading-shows-failure',
  'double-click-starts-concurrent-loads',
  'toast-only-without-recovery-action',
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
    data-ops-health-state
  >
    <template #actions>
      <ElButton
        data-ops-health-retry
        :loading="loading"
        :disabled="loading"
      />
    </template>
  </FsusUiEmptyState>
</template>
<script setup>
import { onUnmounted } from 'vue'
import OpsHealthWorkbench from '@/components/admin/OpsHealthWorkbench.vue'
import { showErrorToast } from '@/utils/errorPresentation'
const controller = new AbortController()
getOpsHealth({ signal: controller.signal })
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
