#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), '../..')
const source = readFileSync(resolve(root, 'src/frontend/src/components/PolicyModal.vue'), 'utf8')
const style = source.match(/<style[^>]*>([\s\S]*?)<\/style>/u)?.[1] ?? ''
const errors = []

function fail(message) {
  errors.push(message)
}

if ((source.match(/:deep\(/gu) ?? []).length !== 0) {
  fail('PolicyModal must not use :deep() selectors')
}
if (!source.includes('class="policy-legal-doc"')) {
  fail('PolicyModal must declare policy-legal-doc class')
}
if (!source.includes('data-policy-document')) {
  fail('PolicyModal must use data-policy-document attribute')
}
if (!source.includes('mode="about"')) {
  fail('PolicyModal must pass mode="about" to MarkdownRenderer')
}
if (!style.includes('[data-policy-document].policy-legal-doc')) {
  fail('PolicyModal CSS must scope to [data-policy-document].policy-legal-doc')
}
const withoutScope = style.replaceAll('[data-policy-document].policy-legal-doc', '')
if (withoutScope.includes('.policy-legal-doc')) {
  fail('PolicyModal CSS must not use .policy-legal-doc without the full data scope')
}
if (style.includes('.el-')) {
  fail('PolicyModal CSS must not contain Element Plus internal selectors')
}
if (style.includes('!important')) {
  fail('PolicyModal CSS must not use !important')
}
if (/(?:^|[\s{;])margin(?:-[a-z]+)?:\s*-/mu.test(style)) {
  fail('PolicyModal CSS must not use negative margin')
}
if (style.includes('position: absolute')) {
  fail('PolicyModal CSS must not use position:absolute')
}

if (errors.length > 0) {
  console.error(errors.map((e) => `[policy-modal-boundary] ${e}`).join('\n'))
  process.exit(1)
}
console.log('[policy-modal-boundary] ok')
