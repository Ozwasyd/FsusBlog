#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')
const srcRoot = resolve(repoRoot, 'src/frontend/src')
const errors = []

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function requireFile(path) {
  if (!existsSync(resolve(repoRoot, path))) {
    errors.push(`missing ${path}`)
  }
}

function walk(dir, predicate, results = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full, predicate, results)
    } else if (predicate(full)) {
      results.push(full)
    }
  }
  return results
}

requireFile('src/frontend/src/assets/motion.css')
requireFile('src/frontend/src/composables/useMotionPreference.ts')
requireFile('docs/frontend/motion-guidelines.md')

const mainCss = read('src/frontend/src/assets/main.css')
if (!mainCss.includes("@import '@/assets/motion.css';")) {
  errors.push('main.css must import motion.css')
}

const motionCss = read('src/frontend/src/assets/motion.css')
for (const token of [
  '--blog-motion-fast',
  '--blog-motion-control',
  '--blog-motion-panel',
  '--blog-motion-overlay',
  '--blog-motion-ease',
  '.blog-motion-page-enter',
  '.blog-motion-panel-enter',
  '.blog-motion-state-change',
  '.blog-motion-task-region',
  '.blog-motion-highlight',
  '.blog-motion-safe-transform',
  '.blog-motion-row-nudge'
]) {
  if (!motionCss.includes(token)) {
    errors.push(`motion.css missing ${token}`)
  }
}

const motionPreference = read('src/frontend/src/composables/useMotionPreference.ts')
if (!motionPreference.includes("REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'")) {
  errors.push('useMotionPreference must own the reduced-motion media query')
}
if (!motionPreference.includes('resolveMotionScrollBehavior')) {
  errors.push('useMotionPreference must expose scroll behavior resolver')
}

const scanned = walk(srcRoot, path => /\.(vue|ts|css)$/.test(path))
for (const file of scanned) {
  const rel = relative(repoRoot, file).replace(/\\/g, '/')
  const source = readFileSync(file, 'utf8')

  if (rel !== 'src/frontend/src/composables/useMotionPreference.ts'
      && /matchMedia\(["']\(prefers-reduced-motion: reduce\)["']\)/.test(source)) {
    errors.push(`${rel}: use useMotionPreference instead of direct reduced-motion matchMedia`)
  }

  if (!rel.endsWith('motion.css') && /@keyframes\s+/.test(source)) {
    errors.push(`${rel}: keyframes must be registered in assets/motion.css`)
  }

  if (!rel.endsWith('motion.css') && /cubic-bezier\(/.test(source)) {
    errors.push(`${rel}: use --blog-motion-ease instead of cubic-bezier`)
  }

  if (!rel.endsWith('motion.css') && /\b(?:hover|group-hover):(scale|translate)/.test(source)) {
    errors.push(`${rel}: use blog-motion-media-hover or blog-motion-icon-nudge instead of hover transform utilities`)
  }

  if (!rel.endsWith('motion.css') && /:hover[^{]*\{[^}]*\btransform\s*:/.test(source)) {
    errors.push(`${rel}: use a blog-motion-* semantic class instead of local hover transform CSS`)
  }

  if (!rel.endsWith('motion.css') && /:deep\(\.el-[^)]+\)[^{]*\{[^}]*(?:\btransition\s*:|\banimation\s*:|(?<!-)transform\s*:)/s.test(source)) {
    errors.push(`${rel}: do not rewrite Element Plus or FsusUI internal motion through :deep(.el-*)`)
  }

  if (!rel.endsWith('motion.css')) {
    for (const match of source.matchAll(/\btransition\s*:[^;\n]*/g)) {
      const declaration = match[0]
      const hasBareDuration = /(?:^|[\s,(])\d+(?:\.\d+)?m?s(?:[\s,);]|$)/.test(declaration)
      const hasBareEase = /(?:^|[\s,(])ease(?:[\s,);]|$)/.test(declaration)
      if (hasBareDuration || hasBareEase) {
        errors.push(`${rel}: transition must use --blog-motion-* or FsusUI motion tokens`)
        break
      }
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[motion-governance] ${error}`)
  }
  process.exit(1)
}

console.log(`[motion-governance] ok files=${scanned.length}`)
