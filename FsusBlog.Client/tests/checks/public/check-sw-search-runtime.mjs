#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fetchWithTimeout, parseTimeoutMs, probeReachable } from '../../support/http.mjs'

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000'
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000)
const clientRoot = process.cwd()
const distRoot = resolve(clientRoot, 'dist')

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fetchBytes(path) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {}, requestTimeoutMs)
  assert(response.ok, `${path} failed: ${response.status}`)
  return {
    response,
    bytes: new Uint8Array(await response.arrayBuffer())
  }
}

async function fetchJson(path) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    headers: { Accept: 'application/json' }
  }, requestTimeoutMs)
  assert(response.ok, `${path} failed: ${response.status}`)
  return {
    response,
    json: await response.json()
  }
}

function validateDistArtifacts() {
  const required = [
    resolve(distRoot, 'sw.js'),
    resolve(distRoot, 'wasm/search_basic.js'),
    resolve(distRoot, 'wasm/search_basic.wasm'),
    resolve(distRoot, 'wasm/search_simd.js'),
    resolve(distRoot, 'wasm/search_simd.wasm')
  ]

  for (const file of required) {
    assert(existsSync(file), `missing dist artifact: ${file}`)
  }

  const swSource = readFileSync(resolve(distRoot, 'sw.js'), 'utf8')
  assert(swSource.includes('/search/index.manifest.json'), 'sw.js missing search manifest path')
  assert(swSource.includes('search-index.updated'), 'sw.js missing search-index.updated control path')
  assert(swSource.includes('shell.invalidate'), 'sw.js missing shell.invalidate control path')
}

async function main() {
  validateDistArtifacts()
  await probeReachable(`${baseUrl}/search/index.manifest.json`, '[check-sw-search-runtime backend]', requestTimeoutMs)

  const { response: manifestResponse, json: manifest } = await fetchJson('/search/index.manifest.json')
  const manifestCacheControl = manifestResponse.headers.get('cache-control') || ''
  assert(manifestCacheControl.includes('no-cache'), `manifest cache-control mismatch: ${manifestCacheControl || 'none'}`)

  assert(typeof manifest.currentVersion === 'string' && manifest.currentVersion.length >= 8, 'manifest currentVersion invalid')
  assert(Array.isArray(manifest.shards) && manifest.shards.length > 0, 'manifest shards invalid')
  assert(Array.isArray(manifest.initialRoles), 'manifest initialRoles invalid')
  assert(Array.isArray(manifest.backgroundRoles), 'manifest backgroundRoles invalid')
  assert(Array.isArray(manifest.deepRoles), 'manifest deepRoles invalid')
  assert(manifest.initialRoles.includes('core') && manifest.initialRoles.includes('recent'), 'manifest initialRoles must include core+recent')
  assert(manifest.backgroundRoles.includes('archive'), 'manifest backgroundRoles must include archive')
  assert(manifest.deepRoles.includes('body'), 'manifest deepRoles must include body')

  const { response: aliasResponse, bytes: aliasBytes } = await fetchBytes('/search/index.bin')
  const aliasCacheControl = aliasResponse.headers.get('cache-control') || ''
  assert(aliasCacheControl.includes('no-cache'), `alias index cache-control mismatch: ${aliasCacheControl || 'none'}`)
  assert(aliasBytes.byteLength > 32, 'alias index payload too small')

  const initialRoleSet = new Set(manifest.initialRoles)
  for (const shard of manifest.shards) {
    assert(typeof shard.fullUrl === 'string' && shard.fullUrl.startsWith('/search/index.'), `shard ${shard.role} fullUrl invalid`)
    assert(typeof shard.fullSha256 === 'string' && shard.fullSha256.length === 64, `shard ${shard.role} fullSha256 invalid`)
    const { response: fullResponse, bytes: fullBytes } = await fetchBytes(shard.fullUrl)
    const fullCacheControl = fullResponse.headers.get('cache-control') || ''
    assert(fullCacheControl.includes('immutable'), `shard ${shard.role} cache-control mismatch: ${fullCacheControl || 'none'}`)
    assert(sha256Hex(fullBytes) === shard.fullSha256, `shard ${shard.role} sha256 mismatch`)

    if (initialRoleSet.has(shard.role)) {
      assert(aliasBytes.includes(fullBytes[0]), 'alias package should contain shard payload bytes')
    }

    if (shard.patchUrl) {
      assert(typeof shard.patchSha256 === 'string' && shard.patchSha256.length === 64, `shard ${shard.role} patchSha256 missing`)
      const { response: patchResponse, bytes: patchBytes } = await fetchBytes(shard.patchUrl)
      const patchCacheControl = patchResponse.headers.get('cache-control') || ''
      assert(patchCacheControl.includes('immutable'), `shard ${shard.role} patch cache-control mismatch: ${patchCacheControl || 'none'}`)
      assert(sha256Hex(patchBytes) === shard.patchSha256, `shard ${shard.role} patch sha256 mismatch`)
    }
  }

  console.log('[check-sw-search-runtime] ok')
}

main().catch((error) => {
  console.error('[check-sw-search-runtime] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
