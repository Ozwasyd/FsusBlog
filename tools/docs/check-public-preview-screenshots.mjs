#!/usr/bin/env node

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const errors = []

const screenshots = [
  'public-home-light.png',
  'article-detail-light.png',
  'article-detail-mobile.png',
  'public-dark.png',
  'admin-dashboard.png',
  'article-editor.png',
  'comment-moderation.png',
  'security-console.png',
  'operations-status.png'
]

function read(path) {
  try {
    return readFileSync(resolve(root, path), 'utf8')
  } catch {
    errors.push(`missing ${path}`)
    return ''
  }
}

function includes(path, source, token) {
  if (!source.includes(token)) {
    errors.push(`${path} missing ${token}`)
  }
}

for (const file of screenshots) {
  const path = `docs/assets/screenshots/${file}`
  const fullPath = resolve(root, path)
  try {
    const buffer = readFileSync(fullPath)
    const stat = statSync(fullPath)
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    if (!isPng) errors.push(`${path} is not a PNG`)
    if (stat.size < 2048) errors.push(`${path} is unexpectedly small`)
  } catch {
    errors.push(`missing ${path}`)
  }
}

const gallery = read('docs/assets/screenshots/README.md')
for (const token of [
  'Public home page',
  'Article detail page',
  'Mobile article page',
  'Dark mode public page',
  'Admin dashboard',
  'Article editor',
  'Comment moderation console',
  'Security / anti-crawler console',
  'AOT / cache / operations status',
  'no real production domains',
  'no real personal emails',
  'no real IP addresses',
  'Brand And Asset Rights'
]) {
  includes('docs/assets/screenshots/README.md', gallery, token)
}

const readme = read('README.md')
for (const token of [
  'docs/assets/screenshots/',
  'public-home-light.png',
  'docs/known-limitations.md'
]) {
  includes('README.md', readme, token)
}

const releaseNotes = read('docs/releases/v1.1.0-public-preview.md')
for (const token of [
  'docs/assets/screenshots/',
  'docs/known-limitations.md',
  'ROADMAP.md',
  'docs/api/stability.md',
  'not stable production software'
]) {
  includes('docs/releases/v1.1.0-public-preview.md', releaseNotes, token)
}

const limitations = read('docs/known-limitations.md')
for (const token of [
  'v1.1.0 is public preview, not stable production release',
  'Internal API contracts may change before v1.2.0',
  'AEDS frame contracts are experimental',
  'Multi-node deployment is not supported until v1.3.0',
  'What Is Safe To Try',
  'What Should Not Be Relied On Yet',
  'Reporting Issues',
  'ROADMAP.md'
]) {
  includes('docs/known-limitations.md', limitations, token)
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[public-preview-screenshots] ${error}`)
  }
  process.exit(1)
}

console.log(`[public-preview-screenshots] ok screenshots=${screenshots.length}`)
