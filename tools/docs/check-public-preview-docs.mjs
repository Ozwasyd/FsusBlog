#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const errors = []

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

const files = {
  readme: read('README.md'),
  overview: read('docs/architecture/overview.md'),
  roadmap: read('ROADMAP.md'),
  stability: read('docs/api/stability.md'),
  limitations: read('docs/known-limitations.md')
}

for (const token of [
  'public-preview',
  'docs/architecture/overview.md',
  'ROADMAP.md',
  'docs/api/stability.md',
  'docs/known-limitations.md',
  'SECURITY.md',
  'CONTRIBUTING.md'
]) {
  includes('README.md', files.readme, token)
}

for (const token of [
  'Kestrel-only',
  'single process',
  'reverse proxy',
  'CDN',
  'AEDS',
  'Public HotRead',
  'Public AOT',
  'Cache Layers',
  'Security, Moderation, And Anti-Crawler',
  'FsusUI Boundary',
  'RSS',
  'Atom',
  'JSON Feed',
  'Sitemap',
  'robots.txt',
  'health probes'
]) {
  includes('docs/architecture/overview.md', files.overview, token)
}

for (const token of [
  'v1.1.0 Public Preview',
  'v1.2.0',
  'v1.3.0',
  'Post-v1.3.0',
  'not a blocker',
  'Plugin system',
  'Theme system',
  'Font system'
]) {
  includes('ROADMAP.md', files.roadmap, token)
}

for (const token of [
  'Internal AEDS frame contracts are experimental',
  'Undocumented internal APIs may change without compatibility guarantees',
  'Database schema may change',
  'Admin API routes may change',
  'Deployment configuration may change',
  'No compatibility guarantee is provided for third-party clients',
  'Stable public extension points will be documented explicitly',
  'RSS',
  'Atom',
  'JSON Feed',
  'Sitemap',
  'robots.txt',
  'health probes'
]) {
  includes('docs/api/stability.md', files.stability, token)
}

includes('docs/known-limitations.md', files.limitations, 'not stable production software')

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[public-preview-docs] ${error}`)
  }
  process.exit(1)
}

console.log('[public-preview-docs] ok')
