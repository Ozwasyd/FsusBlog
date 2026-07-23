import { readFileSync } from 'node:fs'
import { relative, sep } from 'node:path'

export function normalizeChangedPath(value) {
  const path = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\/+/u, '')
  if (!path || path.startsWith('/') || path === '..' || path.startsWith('../') || path.includes('/../')) {
    throw new Error(`changed path must be repository-relative: ${value}`)
  }
  return path
}

function globExpression(pattern) {
  let result = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      const followedBySlash = pattern[index + 2] === '/'
      result += followedBySlash ? '(?:.*/)?' : '.*'
      index += followedBySlash ? 2 : 1
      continue
    }
    if (character === '*') {
      result += '[^/]*'
      continue
    }
    if (character === '?') {
      result += '[^/]'
      continue
    }
    result += /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character
  }
  return new RegExp(`${result}$`, 'u')
}

export function matchesChangedPath(path, patterns) {
  return patterns.some((pattern) => globExpression(normalizeChangedPath(pattern)).test(path))
}

export function resolveChangedCriticalSourceProject(path, sourceProjects) {
  const candidates = sourceProjects
    .map((project) => normalizeChangedPath(project).replace(/\/+$/u, ''))
    .filter((project) => path.startsWith(`${project}/`))
    .sort((left, right) => right.length - left.length)
  if (candidates.length === 0) {
    throw new Error(`critical source path has no source-project mapping: ${path}`)
  }
  return candidates[0]
}

export function readChangedPaths(path) {
  const raw = readFileSync(path, 'utf8')
  if (path.endsWith('.json')) {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('changed-path JSON must be an array')
    return parsed
  }
  return raw.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean)
}

export function repoRelative(root, path) {
  return relative(root, path).split(sep).join('/')
}
