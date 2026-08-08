/**
 * Shared consumer API for the canonical test inventory.
 *
 * Consumers read the canonical artifact through this module. When the
 * artifact is absent (standalone runs) the same canonical discovery code
 * computes membership in-memory; when the artifact is present but stale the
 * consumer fails closed instead of silently re-walking the repository.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { ADAPTER_VERSION, classifyFile } from './adapters.mjs'
import { canonicalStringify, discoverTestInventory } from './discovery.mjs'
import { INVENTORY_SCHEMA, validateInventoryArtifact } from './schema.mjs'

export const DEFAULT_ARTIFACT_PATH = '.tmp/release-evidence/test-inventory.json'

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`
}

/** Digest over the content fields only; runtime metadata never enters identity. */
export function computeInventoryDigest(artifact) {
  const content = { ...artifact }
  delete content.inventoryDigest
  return sha256(canonicalStringify(content))
}

/**
 * Return { stale: false } or { stale: true, reason } for a stored artifact.
 * Detects source/path/adapter changes, removed or duplicated membership,
 * adapter-version drift and matrix/coverage/requirement input drift.
 */
export function isInventoryStale(root, artifact, { runAdapters = true } = {}) {
  if (artifact?.schema !== INVENTORY_SCHEMA) {
    return { stale: true, reason: `schema is ${artifact?.schema ?? 'missing'}, expected ${INVENTORY_SCHEMA}` }
  }
  if (artifact.adapterVersion !== ADAPTER_VERSION) {
    return { stale: true, reason: `adapterVersion is ${artifact.adapterVersion}, expected ${ADAPTER_VERSION}` }
  }
  if (!Array.isArray(artifact.sourceFiles)) {
    return { stale: true, reason: 'sourceFiles is missing' }
  }
  for (const file of artifact.sourceFiles) {
    const absolute = path.join(root, file.path)
    if (!existsSync(absolute)) {
      return { stale: true, reason: `source file no longer exists: ${file.path}` }
    }
    const source = readFileSync(absolute, 'utf8')
    const currentDigest = `sha256:${createHash('sha256').update(source).digest('hex')}`
    if (currentDigest !== file.sourceDigest) {
      return { stale: true, reason: `source digest changed: ${file.path}` }
    }
    let classification = null
    try {
      classification = classifyFile(file.path, source)
    } catch (error) {
      return { stale: true, reason: `adapter membership changed for ${file.path}: ${error.message}` }
    }
    if (classification === null || classification.adapter !== file.adapter) {
      return {
        stale: true,
        reason: `adapter membership changed for ${file.path}: `
          + `${file.adapter} -> ${classification?.adapter ?? 'none'}`
      }
    }
  }
  const expected = discoverTestInventory(root, { runAdapters })
  if (expected.inventoryDigest !== artifact.inventoryDigest) {
    return { stale: true, reason: 'inventory content digest no longer matches current source/matrix/catalog input' }
  }
  return { stale: false }
}

/**
 * Load the canonical inventory. When the artifact exists it is validated and
 * freshness-checked; a stale artifact fails closed. When it is absent and
 * requireArtifact is false the canonical discovery computes membership
 * in-memory (same authority, no consumer-private walk).
 */
export function loadCanonicalInventory(root, { artifactPath = DEFAULT_ARTIFACT_PATH, requireArtifact = false, runAdapters = true } = {}) {
  const absolute = path.join(root, artifactPath)
  if (existsSync(absolute)) {
    let artifact
    try {
      artifact = JSON.parse(readFileSync(absolute, 'utf8'))
    } catch (error) {
      throw new Error(`test inventory artifact is not valid JSON: ${error.message}`)
    }
    validateInventoryArtifact(artifact)
    const stale = isInventoryStale(root, artifact, { runAdapters })
    if (stale.stale) {
      throw new Error(`test inventory artifact is stale: ${stale.reason}; run node tools/test-inventory/produce.mjs`)
    }
    return artifact
  }
  if (requireArtifact) {
    throw new Error(
      `test inventory artifact missing at ${artifactPath}; `
      + 'run node tools/test-inventory/produce.mjs before this consumer'
    )
  }
  return discoverTestInventory(root, { runAdapters })
}

/** Source-file membership projection used by quality, retention and docs consumers. */
export function inventorySourceFiles(root, options) {
  return loadCanonicalInventory(root, options).sourceFiles
}

