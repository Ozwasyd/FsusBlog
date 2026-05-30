#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const manifestPath = resolve(root, 'public/manifest.webmanifest')
const serviceWorkerPath = resolve(root, 'public/sw.js')
const indexPath = resolve(root, 'index.html')

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function read(path) {
  assert(existsSync(path), `missing file: ${path}`)
  return readFileSync(path, 'utf8')
}

const manifest = JSON.parse(read(manifestPath))
const sw = read(serviceWorkerPath)
const index = read(indexPath)

assert(manifest.name === 'FsusBlog', 'manifest name must identify the site')
assert(manifest.start_url === '/', 'manifest start_url must stay public')
assert(manifest.scope === '/', 'manifest scope must stay site-root')
assert(manifest.display === 'standalone', 'manifest display must support installability')
assert(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest must expose icons')
assert(index.includes('rel="manifest" href="/manifest.webmanifest"'), 'index.html must discover the manifest')

const shellPathBlock = sw.slice(
  sw.indexOf('const PUBLIC_SHELL_PATHS'),
  sw.indexOf('const STATIC_ASSET_PATTERN')
)
assert(shellPathBlock.includes('/^\\/article\\/\\d+\\/?$/'), 'public article shell route must be cacheable')
assert(!shellPathBlock.includes('/user'), 'service worker must not cache /user shells')
assert(!shellPathBlock.includes('/admin'), 'service worker must not cache admin shells')
assert(!shellPathBlock.includes('/login'), 'service worker must not cache login shells')
assert(sw.includes("headers.set('X-Fsus-Offline-Stale', '1')"), 'offline shell responses must be marked stale')
assert(sw.includes("headers.set('Cache-Control', 'no-store')"), 'offline stale shell responses must not be re-cached by HTTP caches')
assert(sw.includes("url.pathname.startsWith('/api/binary/')"), 'binary API requests must stay outside shell cache handling')

console.log('[check-pwa-offline-policy] ok')
