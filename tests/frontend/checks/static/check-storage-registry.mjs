#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const sourceRoot = join(repoRoot, 'src/frontend/src')
const registryPath = join(sourceRoot, 'services/privateStorageRegistry.ts')
const registry = await readFile(registryPath, 'utf8')
const sourceExtensions = new Set(['.js', '.mjs', '.ts', '.tsx', '.vue'])
const errors = []

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return await sourceFiles(path)
    return sourceExtensions.has(extname(entry.name)) ? [path] : []
  }))
  return nested.flat()
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function looksLikeFsusStorageKey(value) {
  return value.startsWith('fsus:')
    || value.startsWith('fsus_')
    || value.startsWith('fsusblog_')
    || value === 'notification_stream_guest_pow'
}

const discovered = new Map()
for (const path of await sourceFiles(sourceRoot)) {
  if (path === registryPath) continue
  const source = await readFile(path, 'utf8')
  const relativePath = relative(repoRoot, path).replaceAll('\\', '/')

  for (const match of source.matchAll(/(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem|removeItem)\s*\(\s*(['"`])([^'"`]+)\1/gu)) {
    if (looksLikeFsusStorageKey(match[2])) discovered.set(match[2], relativePath)
  }

  for (const match of source.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*(['"`])([^'"`]+)\2/gu)) {
    const [, identifier, , value] = match
    if (!looksLikeFsusStorageKey(value)) continue
    const storageUse = new RegExp(`(?:getItem|setItem|removeItem)\\s*\\(\\s*${escapeRegExp(identifier)}\\b`, 'u')
    if (storageUse.test(source)) discovered.set(value, relativePath)
  }
}

for (const [value, path] of discovered) {
  if (!registry.includes(`value: '${value}'`)) {
    errors.push(`${path}: persisted key ${value} is missing from PRIVATE_STORAGE_REGISTRY`)
  }
}

for (const requiredValue of [
  'fsus:article-draft:',
  'fsus:comment-draft:v1:',
  'fsus:console-welcome-callout:dismissed:',
  'fsus-shell-',
  'fsus-search-',
  'fsus-search-meta-'
]) {
  if (!registry.includes(`'${requiredValue}'`)) {
    errors.push(`src/frontend/src/services/privateStorageRegistry.ts: missing dynamic/cache prefix ${requiredValue}`)
  }
}

for (const token of [
  "PrivateStorageDataScope = 'public' | 'account' | 'admin' | 'session' | 'temporary'",
  "PrivateStorageMedium = 'local-storage' | 'session-storage' | 'cache-storage' | 'runtime'",
  "| 'admin-logout'",
  'registerPrivateStateCleanupHandler',
  'clearRegisteredPrivateState',
  'items: readonly PrivateStorageCleanupItemResult[]'
]) {
  if (!registry.includes(token)) errors.push(`src/frontend/src/services/privateStorageRegistry.ts: missing governance token ${token}`)
}

const composition = await readFile(join(sourceRoot, 'services/authBroadcastComposition.ts'), 'utf8')
for (const id of ['account-pinia', 'admin-pinia', 'notification-runtime', 'challenge-proof-runtime']) {
  if (!composition.includes(`registerPrivateStateCleanupHandler('${id}'`)) {
    errors.push(`src/frontend/src/services/authBroadcastComposition.ts: runtime cleanup handler ${id} is not installed`)
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exit(1)
}

console.log(`ok: storage registry owns ${discovered.size} persisted keys plus dynamic/cache/runtime boundaries`)
