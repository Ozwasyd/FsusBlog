#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const componentPath = path.join(repoRoot, 'src/frontend/src/components/public/pages/PublicFilterPageContent.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const failures = []

function requirePattern(pattern, message) {
  if (!pattern.test(source)) failures.push(message)
}

function forbidPattern(pattern, message) {
  if (pattern.test(source)) failures.push(message)
}

requirePattern(
  /<el-radio-group[\s\S]*?class="fsus-radio-group--touch"[\s\S]*?size="small"/,
  'search sorting must consume the public FsusUI 44px RadioButton modifier while retaining compact typography'
)
forbidPattern(
  /:deep\([^)]*\.el-radio-button|\.el-radio-button__(?:inner|original-radio)/,
  'consumer code must not style private FsusUI RadioButton DOM'
)

if (failures.length > 0) {
  console.error(failures.map((failure) => `[public-filter-controls] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[public-filter-controls] ok')
