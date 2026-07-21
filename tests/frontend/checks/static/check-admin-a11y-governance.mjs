#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []
let taxonomyMutationProofs = 0
const adminAccountRoots = [
  'src/frontend/src/views/admin',
  'src/frontend/src/views/user',
  'src/frontend/src/components/admin',
  'src/frontend/src/components/user'
].map((dir) => path.join(repoRoot, dir))

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

function fail(file, line, message) {
  failures.push(`${rel(file)}:${line}: ${message}`)
}

function lineOf(source, token) {
  const index = source.indexOf(token)
  if (index < 0) {
    return 1
  }

  return source.slice(0, index).split(/\r?\n/).length
}

function requireToken(file, source, token, message) {
  if (!source.includes(token)) {
    fail(file, 1, message)
  }
}

function forbidToken(file, source, token, message) {
  if (source.includes(token)) {
    fail(file, lineOf(source, token), message)
  }
}

function withoutBlockComments(source) {
  return source
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
}

function validateTaxonomyManageContract(source) {
  const contractFailures = []
  const cleanSource = withoutBlockComments(source)
  const templateStart = cleanSource.indexOf('<template>')
  const scriptStart = cleanSource.indexOf('<script')
  const template = templateStart >= 0 && scriptStart > templateStart
    ? cleanSource.slice(templateStart + '<template>'.length, scriptStart)
    : ''
  const requireIn = (scope, token, message) => {
    if (!scope.includes(token)) contractFailures.push(message)
  }

  const lockedAction = template.match(
    /<el-tooltip\b(?=[^>]*\bv-if="!row\.canDelete")[^>]*>[\s\S]*?<\/el-tooltip>/u
  )?.[0] ?? ''
  if (!lockedAction) {
    contractFailures.push('locked taxonomy action block is missing')
  } else {
    if (lockedAction.includes('<el-button')) {
      contractFailures.push('locked taxonomy state must remain a non-button status inside its tooltip')
    }
    for (const [token, message] of [
      ['class="taxonomy-action-locked"', 'locked taxonomy action must expose its status hook inside the locked block'],
      ['tabindex="0"', 'locked taxonomy action must remain keyboard focusable inside the locked block'],
      [':title="state.relationLockReason(row)"', 'locked taxonomy action must expose its reason inside the locked block'],
      [':aria-label="`锁定：${state.relationLockReason(row)}`"', 'locked taxonomy action must expose a stable accessible name inside the locked block'],
      [':size="14"', 'locked taxonomy icon must retain its compact size inside the locked block']
    ]) {
      requireIn(lockedAction, token, message)
    }
  }

  const dangerDeleteTag = [...template.matchAll(/<el-button\b[^>]*>/gu)]
    .map((match) => match[0])
    .find((tag) => /(?:^|\s)v-else(?:\s|=|>)/u.test(tag))
  if (
    !dangerDeleteTag
    || !/(?:^|\s)link(?:\s|=|>)/u.test(dangerDeleteTag)
    || !/(?:^|\s)type="danger"(?:\s|>)/u.test(dangerDeleteTag)
    || !/(?:^|\s)@click="state\.handleDelete\(row\)"(?:\s|>)/u.test(dangerDeleteTag)
  ) {
    contractFailures.push('deletable taxonomy state must keep v-else, link, danger, and handleDelete on one button tag')
  }

  const compactHookCount = (template.match(/'admin-table-action--compact': isCompact/gu) ?? []).length
  if (compactHookCount !== 3) {
    contractFailures.push('edit, view, and delete taxonomy actions must all opt into the compact hit-target hook')
  }
  if (!template.includes(':width="actionColumnWidth"')) {
    contractFailures.push('taxonomy action column must retain its explicit width')
  }

  const noteBlock = template.match(
    /<div\b(?=[^>]*taxonomy-dialog-note)[^>]*>[\s\S]*?<\/div>/u
  )?.[0] ?? ''
  if (!noteBlock) {
    contractFailures.push('taxonomy dialog guidance block is missing')
  } else {
    for (const [token, message] of [
      ['class="taxonomy-dialog-note__icon"', 'taxonomy dialog guidance must retain its icon hook inside the note block'],
      ['aria-hidden="true" :size="16"', 'taxonomy dialog guidance icon must remain decorative and 16px inside the note block'],
      ['taxonomy-dialog-note__text', 'taxonomy dialog guidance must retain its text hook inside the note block']
    ]) {
      requireIn(noteBlock, token, message)
    }
  }

  if (!/\.taxonomy-action-locked\s*\{[\s\S]*?min-height:\s*32px;[\s\S]*?color:\s*var\(--fsusblog-text-muted\);/u.test(cleanSource)) {
    contractFailures.push('locked taxonomy status must retain its 32px muted treatment')
  }
  if (!/@media \(max-width: 639px\)[\s\S]*?\.taxonomy-action-locked\s*\{[\s\S]*?min-width:\s*32px;/u.test(cleanSource)) {
    contractFailures.push('locked taxonomy status must retain its mobile 32px width')
  }
  if (!/\.admin-table-action--compact\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;[\s\S]*?min-width:\s*32px;[\s\S]*?min-height:\s*32px;/u.test(cleanSource)) {
    contractFailures.push('compact taxonomy actions must retain centered 32px hit targets')
  }
  if (!/\.taxonomy-dialog-note__text\s*\{[\s\S]*?color:\s*var\(--fsusblog-text-tertiary\);[\s\S]*?font-size:\s*13px;[\s\S]*?line-height:\s*20px;/u.test(cleanSource)) {
    contractFailures.push('taxonomy dialog guidance must retain its tertiary 13/20 rhythm')
  }
  if (cleanSource.includes('text-[12px] text-[var(--fsusblog-text-muted)] leading-relaxed')) {
    contractFailures.push('taxonomy dialog guidance must not compete with form labels')
  }

  return contractFailures
}

function assertTaxonomyMutationRejected(source, label, mutate, expectedFailure) {
  const mutated = mutate(source)
  if (mutated === source) {
    failures.push(`taxonomy mutation fixture ${label} did not alter its source`)
    return
  }
  const mutationFailures = validateTaxonomyManageContract(mutated)
  if (!mutationFailures.some((message) => message.includes(expectedFailure))) {
    failures.push(`taxonomy mutation fixture ${label} was not rejected for ${expectedFailure}`)
  } else {
    taxonomyMutationProofs += 1
  }
}

function assertEveryElIconHidden(file) {
  const source = read(file)
  const pattern = /<el-icon\b(?![^>]*\baria-hidden=["']true["'])/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    fail(file, lineOf(source, match[0]), 'decorative el-icon must declare aria-hidden="true"')
  }
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) {
    return files
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(fullPath, files)
      continue
    }

    if (entry.isFile() && /\.(vue|ts)$/.test(entry.name)) {
      files.push(fullPath)
    }
  }

  return files
}

function assertSwitchesDoNotUseVisibleStateText(file) {
  const source = read(file)
  for (const token of ['active-text=', 'inactive-text=']) {
    if (source.includes(token)) {
      fail(file, lineOf(source, token), 'admin/account switches must not use visible active/inactive text; use row labels plus aria-label')
    }
  }
}

const messageCenterPath = path.join(repoRoot, 'src/frontend/src/views/admin/MessageCenter.vue')
const messageCenter = read(messageCenterPath)
requireToken(
  messageCenterPath,
  messageCenter,
  'box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);',
  'MessageCenter list/detail focus-visible ring must use --fsusblog-color-focus-ring'
)
forbidToken(
  messageCenterPath,
  messageCenter,
  'box-shadow: inset 0 0 0 2px var(--fsusblog-color-primary, Highlight);',
  'MessageCenter list/detail focus-visible ring must not use primary color'
)

const articleRevisionPath = path.join(repoRoot, 'src/frontend/src/components/admin/article/ArticleRevisionPanel.vue')
const articleRevision = read(articleRevisionPath)
forbidToken(articleRevisionPath, articleRevision, ':aria-pressed=', 'revision list item must use aria-current, not aria-pressed')
forbidToken(articleRevisionPath, articleRevision, ':aria-label="`选择修订版本', 'revision button accessible name must come from visible text')
requireToken(
  articleRevisionPath,
  articleRevision,
  ':aria-current="selectedRevision?.id === revision.id ? \'true\' : undefined"',
  'revision list item must keep aria-current state'
)

const messagesConversationListPath = path.join(repoRoot, 'src/frontend/src/components/user/messages/MessagesConversationList.vue')
const messagesConversationList = read(messagesConversationListPath)
forbidToken(messagesConversationListPath, messagesConversationList, ':aria-pressed=', 'conversation list item must use aria-current, not aria-pressed')
requireToken(
  messagesConversationListPath,
  messagesConversationList,
  ':aria-current="item.conversationId === selectedConversationId ? \'true\' : undefined"',
  'conversation list item must keep aria-current state'
)

const taxonomyManagePath = path.join(repoRoot, 'src/frontend/src/components/admin/AdminTaxonomyManageView.vue')
const taxonomyManage = read(taxonomyManagePath)
for (const message of validateTaxonomyManageContract(taxonomyManage)) {
  fail(taxonomyManagePath, 1, message)
}
assertTaxonomyMutationRejected(
  taxonomyManage,
  'locked hook moved to comment',
  (source) => source
    .replace('class="taxonomy-action-locked"', 'class="taxonomy-action-status"')
    .replace('<el-tooltip v-if="!row.canDelete"', '<!-- class="taxonomy-action-locked" -->\n              <el-tooltip v-if="!row.canDelete"'),
  'status hook inside the locked block'
)
assertTaxonomyMutationRejected(
  taxonomyManage,
  'danger click moved to another button',
  (source) => source
    .replace(' @click="state.handleDelete(row)"', '')
    .replace('</el-tooltip>', '</el-tooltip>\n              <el-button @click="state.handleDelete(row)">unrelated</el-button>'),
  'handleDelete on one button tag'
)
assertTaxonomyMutationRejected(
  taxonomyManage,
  'note icon hook moved outside note block',
  (source) => source
    .replace('class="taxonomy-dialog-note__icon"', 'class="taxonomy-dialog-note-icon-missing"')
    .replace('<FsusUiTaskPageHeader', '<span class="taxonomy-dialog-note__icon"></span>\n    <FsusUiTaskPageHeader'),
  'icon hook inside the note block'
)

const userManageTablePath = path.join(repoRoot, 'src/frontend/src/components/admin/users/UserManageTable.vue')
const userManageTable = read(userManageTablePath)
forbidToken(userManageTablePath, userManageTable, '<article', 'compact user table rows must not use article card shells')
forbidToken(userManageTablePath, userManageTable, 'px-4 py-5', 'compact user table rows must use table-density padding')
forbidToken(userManageTablePath, userManageTable, 'gap-6', 'compact user table rows must avoid card-like spacing')
requireToken(
  userManageTablePath,
  userManageTable,
  '<div\n          class="user-resource-list-item border-b border-[var(--fsusblog-panel-border)] px-4 py-3"',
  'compact user table rows must render as flat div rows'
)
requireToken(
  userManageTablePath,
  userManageTable,
  'py-3',
  'compact user table rows must use 12px vertical padding'
)

const commentQueuePath = path.join(repoRoot, 'src/frontend/src/components/admin/comment-moderation/CommentModerationQueue.vue')
const commentQueue = read(commentQueuePath)
forbidToken(commentQueuePath, commentQueue, '<article', 'compact comment moderation rows must not use article card shells')
forbidToken(commentQueuePath, commentQueue, 'bg-[var(--fsusblog-page-bg)] p-6', 'compact comment moderation rows must not use card background padding')
requireToken(
  commentQueuePath,
  commentQueue,
  'border-b border-[var(--fsusblog-panel-border)] py-3',
  'compact comment moderation rows must use flat divider rows with table-density padding'
)

for (const file of [
  'src/frontend/src/components/admin/AdminTaxonomyManageView.vue',
  'src/frontend/src/components/admin/users/UserManageHeader.vue',
  'src/frontend/src/components/admin/article/AdminArticleCompactCard.vue',
  'src/frontend/src/components/admin/article/ArticleSeoPreviewPanel.vue',
  'src/frontend/src/components/admin/comment-moderation/CommentModerationToolbar.vue',
  'src/frontend/src/components/admin/comment-moderation/CommentModerationQueue.vue',
  'src/frontend/src/views/admin/Settings.vue',
  'src/frontend/src/views/auth/Login.vue',
  'src/frontend/src/views/admin/article/List.vue',
  'src/frontend/src/views/admin/article/Trash.vue'
].map((entry) => path.join(repoRoot, entry))) {
  assertEveryElIconHidden(file)
}

for (const file of [
  'src/frontend/src/components/ui/MfaSetupModal.vue',
  'src/frontend/src/components/ui/PasskeyRegisterModal.vue',
  'src/frontend/src/components/admin/users/UserBanDialog.vue',
  'src/frontend/src/components/admin/comment-moderation/CommentModerationBulkActions.vue',
  'src/frontend/src/views/admin/article/Write.vue',
  'src/frontend/src/views/admin/Settings.vue'
].map((entry) => path.join(repoRoot, entry))) {
  const source = read(file)
  for (const token of ['520px', '480px', '460px', '420px', 'min(95vw, 480px)']) {
    forbidToken(file, source, token, 'admin/security dialog widths must use approved compact steps')
  }
}

const settingsPath = path.join(repoRoot, 'src/frontend/src/views/admin/Settings.vue');
const settings = read(settingsPath);
const adminWorkspacePath = path.join(repoRoot, 'src/frontend/src/assets/admin-workspace.css');
const adminWorkspace = read(adminWorkspacePath);
forbidToken(settingsPath, settings, '--fsusblog-admin-status-warning', 'settings warning icon must use the Element Plus warning semantic');
requireToken(settingsPath, settings, 'text-[var(--el-color-warning)]', 'settings warning icon must use --el-color-warning');
requireToken(settingsPath, settings, 'max-width: var(--fsusblog-container-settings);', 'settings tabs must share the canonical settings content width');
requireToken(settingsPath, settings, 'margin-inline: auto;', 'settings tabs must remain centered at wide viewports');
forbidToken(settingsPath, settings, 'mt-12', 'settings sections must not use the retired 48px top margin');
forbidToken(settingsPath, settings, 'pt-10', 'settings divided sections must not exceed 32px top padding');
requireToken(settingsPath, settings, 'mt-10 border-t border-[var(--fsusblog-panel-border)] pt-8', 'settings divided sections must use the 40px/32px spacing pair');
requireToken(settingsPath, settings, 'rounded-[var(--fsus-radius-panel)] border border-l-4', 'settings preview outputs must use the canonical panel radius and a four-pixel accent');
requireToken(settingsPath, settings, 'border-l-[var(--fsusblog-color-primary)]', 'settings preview outputs must use the Scholarly Blue accent');
requireToken(settingsPath, settings, '<h3 class="mb-4 text-xs font-bold uppercase tracking-wider text-[var(--fsusblog-text-muted)]">搜索结果预览</h3>', 'settings search preview must expose the compact output heading');
requireToken(settingsPath, settings, '<h3 class="mb-4 text-xs font-bold uppercase tracking-wider text-[var(--fsusblog-text-muted)]">页脚预览</h3>', 'settings footer preview must expose the compact output heading');
forbidToken(adminWorkspacePath, adminWorkspace, '--fsusblog-admin-status-warning', 'admin warning alerts must not create a custom mixed warning semantic');
requireToken(adminWorkspacePath, adminWorkspace, '--fsusblog-admin-alert-accent: var(--el-color-warning);', 'admin warning alerts must use --el-color-warning for the accent');
requireToken(adminWorkspacePath, adminWorkspace, 'background: color-mix(in srgb, var(--el-color-warning) 8%, var(--fsusblog-page-bg));', 'admin warning alerts must use the restrained warning tint');
requireToken(settingsPath, settings, '<button', 'settings dropzone empty state must be a real button');
requireToken(settingsPath, settings, 'type="button"', 'settings dropzone empty state button must not submit forms');
requireToken(settingsPath, settings, 'aria-label="上传预览图"', 'settings dropzone button must expose an accessible name');
requireToken(settingsPath, settings, 'class="h-full min-h-12 w-full flex flex-col items-center justify-center', 'settings dropzone button must provide the spacious 48px touch target');
requireToken(settingsPath, settings, '<el-icon :size="24" aria-hidden="true"><Plus /></el-icon>', 'settings dropzone icon must be decorative and 24px');
forbidToken(settingsPath, settings, '<el-icon :size="20" aria-hidden="true"><Plus /></el-icon>', 'settings dropzone must not regress to the retired 20px placeholder icon');

for (const file of adminAccountRoots.flatMap((dir) => walk(dir)))
{
    assertSwitchesDoNotUseVisibleStateText(file);
}

const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json')
const packageJson = JSON.parse(read(packageJsonPath))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-admin-a11y-governance.mjs'
if (scripts['check:admin-a11y-governance'] !== checkScript) {
  fail(packageJsonPath, 1, 'check:admin-a11y-governance script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:admin-a11y-governance')) {
  fail(packageJsonPath, 1, 'check:views-constraints must run check:admin-a11y-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[admin-a11y-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log(`[admin-a11y-governance] ok taxonomyMutationProofs=${taxonomyMutationProofs}`)
