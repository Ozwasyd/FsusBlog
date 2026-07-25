#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), '../..')
const source = readFileSync(resolve(root, 'src/frontend/src/views/admin/moderation/ModerationRegions.vue'), 'utf8')
const errors = []

function fail(message) {
  errors.push(message)
}

if (!source.includes('variant="navigation"')) {
  fail('ModerationRegions DataList must use variant="navigation"')
}
if (/:deep\(\.el-data-list__/u.test(source)) {
  fail('ModerationRegions must not use :deep() on Element Plus DataList internals')
}
if (!source.includes('--el-data-list-hover-background:')) {
  fail('ModerationRegions must set --el-data-list-hover-background')
}
if (!source.includes('--el-data-list-active-background:')) {
  fail('ModerationRegions must set --el-data-list-active-background')
}
if (!source.includes('--el-data-list-focus-ring:')) {
  fail('ModerationRegions must set --el-data-list-focus-ring')
}
if (!source.includes('--el-data-list-active-indicator:')) {
  fail('ModerationRegions must set --el-data-list-active-indicator')
}
if (!source.includes('color: var(--el-data-list-row-accent-color);')) {
  fail('ModerationRegions must use --el-data-list-row-accent-color')
}

if (errors.length > 0) {
  console.error(errors.map((e) => `[moderation-regions-datalist] ${e}`).join('\n'))
  process.exit(1)
}
console.log('[moderation-regions-datalist] ok')
