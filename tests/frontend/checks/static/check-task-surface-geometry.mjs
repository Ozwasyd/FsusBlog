#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const sourceRoot = resolve(repoRoot, 'src/frontend/src')
const geometryRoots = [
  'assets/account-shell-base.css',
  'assets/account-identity.css',
  'assets/admin-workspace.css',
  'assets/admin',
  'components/account',
  'components/admin',
  'components/ui/FsusDialog.vue',
  'components/ui/MfaSetupModal.vue',
  'components/ui/PasskeyRegisterModal.vue',
  'layouts/AccountLayout.vue',
  'views/admin',
  'views/user'
]
const excludedAuthoringFiles = new Set([
  'components/admin/article/ArticleAssetLibraryPanel.vue',
  'components/admin/article/ArticleBodyMarkdownPreview.vue',
  'components/admin/article/ArticlePrivatePreviewPanel.vue',
  'components/admin/article/ArticleRevisionPanel.vue',
  'components/admin/article/ArticleSeoPreviewPanel.vue',
  'components/admin/article/ArticleWriteEditor.vue',
  'components/admin/article/ArticleWriteSidebar.vue',
  'views/admin/article/Write.vue'
])
const sourceExtensions = new Set(['.css', '.vue'])
const spacingDeclaration = /(?:^|\n)\s*(?:gap|row-gap|column-gap|(?:padding|margin)(?:-(?:top|right|bottom|left|block(?:-start|-end)?|inline(?:-start|-end)?))?)\s*:\s*([^;\n}]+);/gu
const radiusDeclaration = /(?:^|\n)\s*border-radius\s*:\s*([^;\n}]+);/gu
const rawLength = /(?<![\w-])\d*\.?\d+(?:px|rem)\b/u
const allowedRadius = /^(?:0|var\(--fsus-radius-(?:control-small|control|popover|panel|panel-large|pill)(?:,\s*(?:4|6|10|12|24|999)px)?\))$/u
const fractionalUtility = /(?<![\w-])(?:-?(?:m|p)[trblxy]?|gap(?:-[xy])?|space-[xy])-\d+\.5\b/gu
const genericRadiusUtility = /\brounded(?:-(?:none|sm|md|lg|xl|2xl|3xl|full))?(?=[\s"'`])/gu
const mediaFeature = /\((min|max)-(width|height):\s*(\d+)px\)/gu
const allowedMediaFeatures = new Set([
  'min-width:640',
  'min-width:768',
  'min-width:1024',
  'min-width:1440',
  'max-width:639',
  'max-width:767',
  'max-width:1023',
  'max-width:1439',
  'max-height:520'
])
const dialogWidths = new Set([
  '50%',
  'min(92vw, 28rem)',
  'min(92vw, 24rem)',
  'min(92vw, 48rem)'
])
const errors = []

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length
}

function sourceRelative(path) {
  return relative(sourceRoot, path).replaceAll('\\', '/')
}

function collect(path) {
  const entries = readdirSync(path, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const child = resolve(path, entry.name)
    if (entry.isDirectory()) return collect(child)
    if (!entry.isFile() || !sourceExtensions.has(extname(entry.name))) return []
    return [child]
  })
}

const geometryFiles = geometryRoots.flatMap((entry) => {
  const path = resolve(sourceRoot, entry)
  return sourceExtensions.has(extname(path)) ? [path] : collect(path)
}).filter((path) => !excludedAuthoringFiles.has(sourceRelative(path)))

for (const path of geometryFiles) {
  const source = readFileSync(path, 'utf8')
  const file = sourceRelative(path)

  for (const match of source.matchAll(spacingDeclaration)) {
    if (rawLength.test(match[1])) {
      errors.push(`${file}:${lineNumberAt(source, match.index)} task spacing must consume --fsus-space-* tokens: ${match[1].trim()}`)
    }
  }

  for (const match of source.matchAll(radiusDeclaration)) {
    if (!allowedRadius.test(match[1].trim())) {
      errors.push(`${file}:${lineNumberAt(source, match.index)} task radius is outside the semantic radius scale: ${match[1].trim()}`)
    }
  }

  for (const match of source.matchAll(fractionalUtility)) {
    errors.push(`${file}:${lineNumberAt(source, match.index)} fractional spacing utility ${match[0]} is outside the 4px task scale`)
  }

  for (const match of source.matchAll(genericRadiusUtility)) {
    errors.push(`${file}:${lineNumberAt(source, match.index)} radius utility ${match[0]} must name a --fsus-radius-* token`)
  }

  for (const match of source.matchAll(mediaFeature)) {
    const key = `${match[1]}-${match[2]}:${match[3]}`
    if (!allowedMediaFeatures.has(key)) {
      errors.push(`${file}:${lineNumberAt(source, match.index)} responsive feature ${match[0]} is outside the shared task breakpoints`)
    }
  }
}

const dialogContractPath = resolve(sourceRoot, 'fsusui/dialog.ts')
const dialogContract = readFileSync(dialogContractPath, 'utf8')
for (const width of dialogWidths) {
  if (!dialogContract.includes(`'${width}'`)) {
    errors.push(`fsusui/dialog.ts: missing dialog width preset ${width}`)
  }
}

const dialogWrapper = readFileSync(resolve(sourceRoot, 'components/ui/FsusDialog.vue'), 'utf8')
for (const required of [
  'width?: FsusDialogWidth',
  'width: fsusDialogWidths.default',
  '--el-dialog-padding-primary: var(--fsus-space-6);',
  'max-width: var(--fsus-dialog-mobile-max-width);',
  'max-height: calc(100dvh - var(--fsus-space-8));'
]) {
  if (!dialogWrapper.includes(required)) errors.push(`components/ui/FsusDialog.vue: missing ${required}`)
}
if (dialogWrapper.includes('.fsus-dialog__footer') || dialogWrapper.includes('@media')) {
  errors.push('components/ui/FsusDialog.vue: footer geometry and responsive width must stay owned by FsusUI and the shared wrapper contract')
}

for (const path of collect(sourceRoot).filter((path) => extname(path) === '.vue')) {
  const source = readFileSync(path, 'utf8')
  for (const dialog of source.matchAll(/<FsusDialog\b[\s\S]*?>/gu)) {
    const literalWidth = dialog[0].match(/(?<!:)\bwidth="([^"]+)"/u)?.[1]
    if (literalWidth && !dialogWidths.has(literalWidth)) {
      errors.push(`${sourceRelative(path)}:${lineNumberAt(source, dialog.index)} dialog width ${literalWidth} is outside the whitelist`)
    }
  }
}

for (const [file, needle] of [
  ['views/admin/Category.vue', 'dialogWidth: fsusDialogWidths.extraCompact'],
  ['views/admin/Tag.vue', 'dialogWidth: fsusDialogWidths.extraCompact'],
  ['composables/useAdminTaxonomyManage.ts', 'dialogWidth: FsusDialogWidth']
]) {
  if (!readFileSync(resolve(sourceRoot, file), 'utf8').includes(needle)) {
    errors.push(`${file}: missing semantic taxonomy dialog width contract`)
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[task-surface-geometry] ${error}`)
  process.exit(1)
}

console.log(`[task-surface-geometry] ok files=${geometryFiles.length} dialogWidths=${dialogWidths.size}`)
