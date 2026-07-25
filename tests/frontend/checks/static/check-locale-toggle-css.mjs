#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), '../..')
const source = readFileSync(resolve(root, 'src/frontend/src/components/ui/LocaleToggle.vue'), 'utf8')
const controlRule = source.match(/\.fsusblog-locale-toggle\s*\{(?<body>[^}]+)\}/u)?.groups?.body ?? ''
const activeRule = source.match(/\.fsusblog-locale-toggle__active\s*\{(?<body>[^}]+)\}/u)?.groups?.body ?? ''
const errors = []

function fail(message) {
  errors.push(message)
}

if (!controlRule.includes('min-height: 2.75rem;')) {
  fail('LocaleToggle control must use 2.75rem (44px) min-height')
}
if (!controlRule.includes('font-size: 14px;')) {
  fail('LocaleToggle control must use 14px font-size')
}
if (!controlRule.includes('font-weight: 500;')) {
  fail('LocaleToggle control must use 500 font-weight')
}
if (!activeRule.includes('font-weight: 500;')) {
  fail('LocaleToggle active state must use 500 font-weight')
}
if (activeRule.includes('font-weight: 700;')) {
  fail('LocaleToggle active state must not use 700 bold font-weight')
}

if (errors.length > 0) {
  console.error(errors.map((e) => `[locale-toggle-css] ${e}`).join('\n'))
  process.exit(1)
}
console.log('[locale-toggle-css] ok')
