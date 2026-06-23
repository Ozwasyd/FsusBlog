#!/usr/bin/env node

// check-copy-centralization.mjs
//
// FsusBlog 前端文案集中化治理：禁止在 .vue 模板 / <script setup> 字符串里
// 硬塞中文。所有 user-facing 文案必须通过 `@/copy` 引用 copy registry。
//
// 调性校准依据：FsusUI design.md §1 (The Intellectual Minimalist) + §9 + §10 + §13.5。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')
const errors = []

const repoPath = (path) => resolve(repoRoot, path)
const relPath = (path) => relative(repoRoot, path).replaceAll('\\', '/')
const read = (path) => readFileSync(repoPath(path), 'utf8')

const copyIndexPath = 'src/frontend/src/copy/index.ts'
const copyContractsPath = 'src/frontend/src/copy/contracts.ts'

function walk(dir, output = []) {
  if (!existsSync(dir)) return output
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (['node_modules', 'dist', 'coverage'].includes(entry)) continue
      walk(full, output)
      continue
    }
    if (/\.vue$/.test(full)) output.push(full)
  }
  return output
}

function addError(file, line, message) {
  errors.push(`${relPath(file)}:${line}: ${message}`)
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length
}

const hanPattern = /\p{Script=Han}/u
const copyImportPattern = /from\s+['"]@\/copy['"]/m
const copyImportPatternRelative = /from\s+['"](\.\.\/)+copy['"]/m

function isCopyImport(line) {
  return copyImportPattern.test(line) || copyImportPatternRelative.test(line)
}

const explicitFiles = [
  'src/frontend/src/views/auth/Register.vue',
  'src/frontend/src/views/auth/Login.vue',
  'src/frontend/src/views/auth/Recover.vue',
  'src/frontend/src/components/PolicyModal.vue',
  'src/frontend/src/views/user/IdentityCenter.vue',
  'src/frontend/src/views/user/IdentityCenterPlaceholder.vue',
  'src/frontend/src/views/user/Profile.vue',
  'src/frontend/src/components/security/FsusSecurityChallenge.vue',
  'src/frontend/src/components/security/FsusPasskeyStepUpChallenge.vue',
  'src/frontend/src/components/ui/PasskeyRegisterModal.vue',
  'src/frontend/src/components/ui/MfaSetupModal.vue',
  'src/frontend/src/components/ui/MfaChallengeModal.vue',
  'src/frontend/src/components/user/messages/MessagesConversationList.vue',
  'src/frontend/src/components/user/messages/MessagesEmptyState.vue',
  'src/frontend/src/components/user/messages/MessagesThreadPanel.vue',
  'src/frontend/src/components/user/messages/MessagesComposePanel.vue',
  'src/frontend/src/views/error/403.vue',
  'src/frontend/src/views/error/404.vue',
  'src/frontend/src/views/admin/moderation/ModerationReplay.vue',
  'src/frontend/src/components/layout/SiteChromeHeaderAdapter.vue',
  'src/frontend/src/components/home/HomeTextFirstRecommendations.vue',
  'src/frontend/src/components/ui/ThemeModeToggle.vue'
]

const scannedFiles = Array.from(new Set(explicitFiles.map(repoPath)))
  .filter((path) => existsSync(path))
  .sort()

function extractTemplate(source) {
  const openTag = '<template>'
  const closeTag = '</template>'
  const start = source.indexOf(openTag)
  if (start === -1) return ''
  const end = source.indexOf(closeTag, start)
  if (end === -1) return ''
  return source.slice(start + openTag.length, end)
}

function extractScript(source) {
  const scriptTag = '<script'
  const closeTag = '</script>'
  const start = source.indexOf(scriptTag)
  if (start === -1) return { body: '', inSetup: false }
  const end = source.indexOf(closeTag, start)
  if (end === -1) return { body: '', inSetup: false }
  const openTagEnd = source.indexOf('>', start)
  const attrs = source.slice(start, openTagEnd)
  const inSetup = /\blang=["']ts["']/.test(attrs) || /setup/.test(attrs)
  return { body: source.slice(openTagEnd + 1, end), inSetup }
}

function* iterateTemplateLines(template) {
  const lines = template.split('\n')
  for (const line of lines) yield line
}

function hasHanLiteral(line) {
  return hanPattern.test(line)
}

function isPureInterpolationToken(token) {
  // Allow `{{ copy.x }}` style interpolation as the only Han-bearing token
  return /^\{\{[^}]+\}\}$/.test(token.trim())
}

function isAttrValueEscapedHan(line) {
  // Allow `&#20013;` style HTML entity escapes (no literal Han)
  return /&#\d+;/.test(line) && !hanPattern.test(line)
}

function isAllowedQuotedHan(line) {
  // Permit Han characters appearing inside quoted string literals that are
  // immediately consumed by copy registry (`copy =` assignments) OR by code
  // identifiers. We require the token to be inside quotes (single / double /
  // backtick) and the surrounding line not be a JSX/template literal binding
  // to a UI element.
  return false
}

function stripTemplateComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, '')
}

function checkTemplate(file, source) {
  const rawTemplate = extractTemplate(source)
  if (!rawTemplate) return
  const template = stripTemplateComments(rawTemplate)

  const lines = template.split('\n')

  // Strip leading indentation for cleaner matching but preserve line numbers
  // by computing index in source.
  const sourceStart = source.indexOf(rawTemplate)
  const sourceBeforeTemplate = source.slice(0, sourceStart)
  const templateStartLine = sourceBeforeTemplate.split('\n').length

  lines.forEach((line, idx) => {
    const absoluteLine = templateStartLine + idx
    if (!hasHanLiteral(line)) return

    // Allow HTML entity escape (no literal Han)
    if (isAttrValueEscapedHan(line)) return

    // Strip Han characters from interpolation — if Han remains outside
    // interpolation OR the line has no interpolation, this is hardcoded copy.
    const outsideInterpolations = line.replace(/\{\{[^}]+\}\}/g, '')
    if (hasHanLiteral(outsideInterpolations)) {
      addError(file, absoluteLine, 'template contains hardcoded Han text — use {{ copy.* }} from @/copy')
    }
  })
}

function stripScriptComments(source) {
  // Strip /* ... */ block comments (incl. JSDoc /** ... */) line-by-line to
  // preserve line numbers, then strip // line comments.
  return source
    .split('\n')
    .map((line) => {
      // Remove trailing // line comments when not inside a string — conservative:
      // we only strip when // appears outside quotes. For simplicity we strip
      // // comments entirely and trust no strings contain literal //.
      const idx = line.indexOf('//')
      if (idx === -1) return line
      // Skip if // is inside quotes (rough heuristic: count quotes before it)
      const before = line.slice(0, idx)
      const singleQuotes = (before.match(/'/g) ?? []).length
      const doubleQuotes = (before.match(/"/g) ?? []).length
      const backticks = (before.match(/`/g) ?? []).length
      if (singleQuotes % 2 === 1 || doubleQuotes % 2 === 1 || backticks % 2 === 1) {
        return line
      }
      return line.slice(0, idx)
    })
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

function checkScript(file, source) {
  const { body, inSetup } = extractScript(source)
  if (!body || !inSetup) return

  const sourceStart = source.indexOf(body)
  const sourceBefore = source.slice(0, sourceStart)
  const scriptStartLine = sourceBefore.split('\n').length

  // Strip block comments from body while preserving line numbers via newline
  // replacement, then strip // line comments.
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))

  const lines = stripped.split('\n')
  let inImportBlock = true

  lines.forEach((line, idx) => {
    const absoluteLine = scriptStartLine + idx
    const trimmed = line.trim()

    if (!trimmed) return

    // Strip // comments before checking
    const withoutLineComment = (() => {
      const idx2 = line.indexOf('//')
      if (idx2 === -1) return line
      const before = line.slice(0, idx2)
      const singleQuotes = (before.match(/'/g) ?? []).length
      const doubleQuotes = (before.match(/"/g) ?? []).length
      const backticks = (before.match(/`/g) ?? []).length
      if (singleQuotes % 2 === 1 || doubleQuotes % 2 === 1 || backticks % 2 === 1) {
        return line
      }
      return line.slice(0, idx2)
    })()

    if (!hasHanLiteral(withoutLineComment)) return

    // Track import block: import lines until the first non-import statement
    if (inImportBlock) {
      if (/^import\s/.test(trimmed) || (/^export\s/.test(trimmed) && /\bfrom\b/.test(trimmed))) {
        return
      }
      inImportBlock = false
    }

    // Escape hatch: a line is exempted if it OR the immediately preceding
    // non-empty line carries a `// copy-source: ok` annotation.
    const sameLineAnnotated = /\/\/\s*copy-source:\s*ok\b/.test(line)
    let prevAnnotated = false
    if (!sameLineAnnotated) {
      for (let back = idx - 1; back >= 0; back--) {
        const prev = lines[back].trim()
        if (!prev) continue
        prevAnnotated = /\/\/\s*copy-source:\s*ok\b/.test(lines[back])
        break
      }
    }
    if (sameLineAnnotated || prevAnnotated) return

    addError(file, absoluteLine, 'script setup contains hardcoded Han string literal — use copy registry from @/copy (or annotate `// copy-source: ok` if intentional)')
  })
}

for (const file of scannedFiles) {
  const source = read(file)

  // Only require copy registry import when the file actually contains Han text.
  // Pure-prop / layout-only files don't need a copy import.
  const hasHan = hanPattern.test(source)

  if (hasHan && !isCopyImport(source)) {
    addError(repoPath(file), 1, 'component must import copy registry from @/copy')
    continue
  }

  if (hasHan) {
    checkTemplate(repoPath(file), source)
    checkScript(repoPath(file), source)
  }
}

if (!existsSync(repoPath(copyIndexPath))) {
  addError(copyIndexPath, 1, 'copy registry barrel missing — expected src/frontend/src/copy/index.ts')
}

if (existsSync(repoPath(copyContractsPath))) {
  const contracts = read(copyContractsPath)
  const expectedDomains = ['AuthCopy', 'IdentityCopy', 'SecurityCopy', 'MessagesCopy', 'ErrorsCopy', 'AdminCopy', 'LayoutCopy']
  for (const domain of expectedDomains) {
    if (!new RegExp(`export\\s+type\\s+${domain}\\b`).test(contracts)) {
      addError(copyContractsPath, 1, `missing contract type ${domain}`)
    }
  }
}

const indexSource = read(copyIndexPath)
const expectedExports = ['FSUSBLOG_AUTH_COPY', 'FSUSBLOG_IDENTITY_COPY', 'FSUSBLOG_SECURITY_COPY', 'FSUSBLOG_MESSAGES_COPY', 'FSUSBLOG_ERRORS_COPY', 'FSUSBLOG_ADMIN_COPY', 'FSUSBLOG_LAYOUT_COPY']
for (const token of expectedExports) {
  if (!new RegExp(`export\\s*\\{[^}]*${token}\\b`).test(indexSource)) {
    addError(copyIndexPath, 1, `barrel missing re-export of ${token}`)
  }
}

const packageJson = JSON.parse(read('src/frontend/package.json'))
const scripts = packageJson.scripts ?? {}
if (scripts['check:copy-centralization'] !== 'node ../../tests/frontend/checks/static/check-copy-centralization.mjs') {
  addError('src/frontend/package.json', 1, 'missing check:copy-centralization script')
}
const viewsConstraints = String(scripts['check:views-constraints'] ?? '')
if (!viewsConstraints.includes('check:copy-centralization')) {
  addError('src/frontend/package.json', 1, 'check:views-constraints must run check:copy-centralization')
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[copy-centralization] ${error}`)
  process.exit(1)
}

console.log(`[copy-centralization] ok files=${scannedFiles.length}`)