#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../../../..')
const sourceRoot = resolve(repoRoot, 'src/frontend/src');
const sourceExtensions = new Set(['.css', '.scss', '.vue', '.ts', '.tsx', '.js', '.jsx']);
const forbiddenRadiusPattern = /border-radius\s*:\s*(2px|3px|8px|0\.5rem)(?=\s*[;}])/gu;
const legacyConsumerRadiusPattern = /--fsusblog-reading-radius-/gu;
const errors = [];
let scannedFileCount = 0;

function collectSourceFiles(directory) {
  const files = []

  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path))
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      files.push(path)
    }
  }

  return files
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length
}

function relativePath(path) {
  return path.slice(repoRoot.length + 1)
}

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function expectCount(path, needle, count, label) {
  const source = read(path)
  const actual = source.split(needle).length - 1
  if (actual !== count) {
    errors.push(`${path}: expected ${count} ${label}, found ${actual}`)
  }
}

for (const path of collectSourceFiles(sourceRoot)) {
  const source = readFileSync(path, 'utf8')
  scannedFileCount += 1

  forbiddenRadiusPattern.lastIndex = 0
  for (const match of source.matchAll(forbiddenRadiusPattern)) {
    errors.push(
            `${relativePath(path)}:${lineNumberAt(source, match.index)} border-radius ${match[1]} is outside the 4/6/10/12/24/999px scale`
        );
    }

    legacyConsumerRadiusPattern.lastIndex = 0;
    for (const match of source.matchAll(legacyConsumerRadiusPattern))
{
        errors.push(`${relativePath(path)}:${lineNumberAt(source, match.index)} uses the retired --fsusblog-reading-radius-* namespace`);
    }
}

expectCount(
    'src/frontend/src/components/PolicyModal.vue',
    'border-radius: var(--fsusblog-radius-control, 6px);',
    1,
    'policy emphasis control radius'
);
expectCount(
  'src/frontend/src/assets/public-page.css',
  'border-radius: var(--fsus-radius-control-small, 4px);',
  1,
  'highlight small-control radius'
)
expectCount(
  'src/frontend/src/assets/markdown.css',
  'border-radius: var(--fsus-radius-pill, 999px);',
  2,
  'scrollbar pill radii'
);
expectCount(
    'src/frontend/src/components/article/ArticleCommentComposer.vue',
    'border-radius: var(--fsusblog-radius-control, 6px);',
    5,
    'composer control radii'
);
expectCount(
  'src/frontend/src/components/article/ArticleCommentComposer.vue',
  'border-radius: var(--fsus-radius-control-small, 4px);',
  1,
  'composer small-control radius'
)
expectCount(
  'src/frontend/src/components/admin/article/ArticlePrivatePreviewPanel.vue',
  '--preview-radius-inline: var(--fsus-radius-control-small, 4px);',
  1,
  'private preview inline-code radius token'
)
expectCount(
  'src/frontend/src/components/admin/article/ArticlePrivatePreviewPanel.vue',
  'border-radius: var(--preview-radius-inline);',
  1,
  'private preview inline-code radius usage'
)

const layoutRules = read('docs/public-layout-rules.md');
for (const requiredText of [
    '行内高亮与紧凑标记使用 `--fsus-radius-control-small`（4px）',
    '`--fsusblog-radius-control`（映射 `--fsus-radius-control`，默认 6px）',
    '`--fsusblog-radius-panel`（映射 `--fsus-radius-panel`，默认 12px）',
    '横向滚动条 thumb 是真实胶囊几何',
    '`border-radius` 禁止重新引入 2/3/8px 字面值'
])
{
  if (!layoutRules.includes(requiredText)) {
    errors.push(`docs/public-layout-rules.md: missing radius contract text: ${requiredText}`)
  }
}

const packageJson = JSON.parse(read('src/frontend/package.json'))
const scripts = packageJson.scripts ?? {}
if (!String(scripts['check:radius-scale-contract'] ?? '').includes('check-radius-scale-contract.mjs')) {
  errors.push('src/frontend/package.json: check:radius-scale-contract must run the radius guard')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:radius-scale-contract')) {
  errors.push('src/frontend/package.json: check:views-constraints must include check:radius-scale-contract')
}

if (errors.length > 0) {
  console.error('[check-radius-scale-contract] failed')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`[check-radius-scale-contract] ok (${scannedFileCount} source files; scale=4/6/10/12/24/999px)`)
}
