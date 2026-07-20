#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const read = (path) => readFileSync(new URL(path, `file://${root}/`), 'utf8')

const filterGroup = read('src/frontend/src/components/admin/AdminFilterGroup.vue')

assert.match(filterGroup, /class="grid gap-1"/, 'filter label and control must keep a 4px gap')
assert.match(filterGroup, /text-\[11px\][^"\n]*leading-4/, 'filter label must use a fixed 16px line-height')

console.log('admin article list layout checks passed')
