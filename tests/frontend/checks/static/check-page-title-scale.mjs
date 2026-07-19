#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), '../..')
const read = path => readFileSync(resolve(root, path), 'utf8')

function assert(condition, message) {
  if (!condition) throw new Error(`[page-title-scale] ${message}`)
}

const componentFiles = [
  'src/frontend/src/components/filter/FilterHeader.vue',
  'src/frontend/src/components/public/pages/PublicArchivePageContent.vue',
  'src/frontend/src/components/public/pages/PublicAboutPageContent.vue',
  'src/frontend/src/components/home/FeaturedArticlesSection.vue',
  'src/frontend/src/views/auth/Login.vue',
  'src/frontend/src/views/auth/Register.vue',
  'src/frontend/src/views/auth/Recover.vue',
  'src/frontend/src/views/error/403.vue',
  'src/frontend/src/views/error/404.vue'
]

for (const file of componentFiles) {
  const source = read(file)
  assert(!/\btext-(?:4xl|5xl|6xl|7xl|8xl|9xl)\b/u.test(source), `${file} contains an oversized display utility`)
  const headings = [...source.matchAll(/<h1\b[^>]*>/gs)]
  assert(headings.length === 1, `${file} must expose exactly one page H1`)
  const heading = headings[0][0]
  for (const token of ['text-2xl', 'sm:text-3xl', 'font-bold', 'leading-tight', 'tracking-normal']) {
    assert(heading.includes(token), `${file} H1 is missing ${token}`)
  }
  assert(!/gradient|glow|text-shadow/u.test(source), `${file} must not create a decorative title focus layer`)
}

for (const file of ['src/frontend/src/views/auth/Login.vue', 'src/frontend/src/views/auth/Register.vue', 'src/frontend/src/views/auth/Recover.vue']) {
  const source = read(file)
  assert(/<header class="mb-6">[\s\S]*?<h1[\s\S]*?<p[\s\S]*?class="mt-4[^"]*text-sm[^"]*font-normal/u.test(source),
    `${file} must keep the 16px title-description and 24px description-control rhythm`)
}

for (const file of ['src/frontend/src/views/error/403.vue', 'src/frontend/src/views/error/404.vue']) {
  const source = read(file)
  assert(/<p class="mb-4 text-sm font-bold[^>]*aria-hidden="true">/u.test(source), `${file} error code must be an auxiliary label`)
  assert(/class="mt-6 flex flex-col gap-3 sm:flex-row"/u.test(source), `${file} first action must start 24px after the description`)
}

const account = read('src/frontend/src/assets/account-shell.css')
assert(/\.account-page-title\s*\{[^}]*font-size:\s*1\.5rem;[^}]*font-weight:\s*700;[^}]*line-height:\s*1\.25;/s.test(account),
  'account title mobile role must be 24px/700/1.25')
assert(/@media \(min-width:\s*640px\)\s*\{\s*\.account-page-title\s*\{[^}]*font-size:\s*1\.875rem;[^}]*line-height:\s*1\.2;/s.test(account),
  'account title desktop role must be 30px/1.2')

const identity = read('src/frontend/src/views/user/IdentityCenter.vue')
assert(/\.identity-section-header__copy h1\s*\{[^}]*font-size:\s*1\.5rem;/s.test(identity), 'identity title mobile role must be 24px')
assert(/\.identity-section-header__copy h1\s*\{[^}]*line-height:\s*1\.25;/s.test(identity), 'identity title mobile leading must be 1.25')
assert(/@media \(min-width:\s*640px\)\s*\{\s*\.identity-section-header__copy h1\s*\{[^}]*font-size:\s*1\.875rem;[^}]*line-height:\s*1\.2;/s.test(identity),
  'identity title desktop role must be 30px/1.2')

const themeTokens = read('src/frontend/src/ui-tokens/themeTokens.ts')
assert(/articleDetail:\s*\{[\s\S]*?title: `text-2xl sm:text-3xl font-bold[^`]*leading-\[1\.25\] sm:leading-\[1\.2\][^`]*tracking-normal/u.test(themeTokens),
  'article detail H1 must use the responsive 24/30px page-title role')

const writeView = read('src/frontend/src/views/admin/article/Write.vue')
assert(/\.write-command-title\s*\{[^}]*font-size:\s*1\.5rem;[^}]*font-weight:\s*700;[^}]*line-height:\s*1\.25;[^}]*letter-spacing:\s*0;/s.test(writeView),
  'article write H1 mobile role must be 24px/700/1.25 without negative tracking')
assert(/@media \(min-width:\s*640px\)\s*\{\s*\.write-command-title\s*\{[^}]*font-size:\s*1\.875rem;[^}]*line-height:\s*1\.2;/s.test(writeView),
  'article write H1 desktop role must be 30px/1.2')

console.log('[page-title-scale] public, account, auth and error H1 geometry is 24/30px')
