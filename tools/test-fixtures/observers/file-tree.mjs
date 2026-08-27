import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { freezeDeep } from '../receipt/canonical.mjs'
import { requireSafeId } from '../../test-runtime/contract.mjs'
import {
  assertOwnedHandle,
  normalizedObserverResult,
  stableRecords,
  zeroObserverSideEffects
} from './common.mjs'

function contained(root, candidate) {
  const parent = path.resolve(root)
  const child = path.resolve(candidate)
  return child === parent || child.startsWith(`${parent}${path.sep}`)
}

function fileDigest(file) {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let length = 0
  try {
    let read
    do {
      read = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (read > 0) {
        length += read
        hash.update(buffer.subarray(0, read))
      }
    } while (read > 0)
  } finally {
    fs.closeSync(descriptor)
  }
  return { length, contentDigest: `sha256:${hash.digest('hex')}` }
}

function semanticMode(stat) {
  return (stat.mode & 0o777).toString(8).padStart(3, '0')
}

export async function observeFileTree({ domain, identity, context }) {
  const handle = assertOwnedHandle(context?.handles?.[domain], identity, domain, 'file-tree root handle')
  const root = path.resolve(handle.root ?? '')
  const sessionRoot = path.resolve(handle.sessionRoot ?? '')
  if (!root || !sessionRoot || !contained(sessionRoot, root) || root === sessionRoot) throw new Error('file-tree root is not session-owned')
  if (handle.sourceRoot && contained(path.resolve(handle.sourceRoot), root)) throw new Error('file-tree observer refuses a source worktree root')
  const rootStat = fs.lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('file-tree root is missing or not a real directory')
  const rootReal = fs.realpathSync(root)
  if (!contained(fs.realpathSync(sessionRoot), rootReal)) throw new Error('file-tree root escapes its session through a link')
  const entries = []
  const pending = ['']
  while (pending.length > 0) {
    const relative = pending.pop()
    const current = path.join(root, relative)
    const names = fs.readdirSync(current).sort().reverse()
    for (const name of names) {
      const relativePath = path.posix.join(relative.replaceAll(path.sep, '/'), name)
      const absolute = path.join(root, ...relativePath.split('/'))
      const stat = fs.lstatSync(absolute)
      if (stat.dev !== rootStat.dev) throw new Error(`file-tree bind mount is unsupported: ${relativePath}`)
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute)
        let resolved
        try {
          resolved = fs.realpathSync(path.resolve(path.dirname(absolute), target))
        } catch (error) {
          throw new Error(`file-tree dangling link: ${relativePath}`, { cause: error })
        }
        if (!contained(rootReal, resolved)) throw new Error(`file-tree path-escape: ${relativePath}`)
        entries.push({
          rootId: requireSafeId(handle.rootId, 'file-tree rootId'),
          path: relativePath,
          kind: 'symlink',
          permissions: semanticMode(stat),
          length: Buffer.byteLength(target),
          contentDigest: null,
          linkIdentity: path.relative(rootReal, resolved).replaceAll(path.sep, '/') || '.',
          observationReason: 'catalog-declared-link'
        })
      } else if (stat.isDirectory()) {
        entries.push({
          rootId: requireSafeId(handle.rootId, 'file-tree rootId'),
          path: relativePath,
          kind: 'directory',
          permissions: semanticMode(stat),
          length: 0,
          contentDigest: null,
          linkIdentity: null,
          observationReason: 'catalog-declared-entry'
        })
        pending.push(relativePath)
      } else if (stat.isFile()) {
        const content = fileDigest(absolute)
        entries.push({
          rootId: requireSafeId(handle.rootId, 'file-tree rootId'),
          path: relativePath,
          kind: 'file',
          permissions: semanticMode(stat),
          ...content,
          linkIdentity: null,
          observationReason: 'catalog-declared-entry'
        })
      } else {
        throw new Error(`file-tree unsupported entry type: ${relativePath}`)
      }
    }
  }
  return normalizedObserverResult({
    kind: 'file-tree',
    rootId: requireSafeId(handle.rootId, 'file-tree rootId'),
    entries: stableRecords(entries, ['rootId', 'path', 'kind'], 'file-tree entries')
  }, {
    entryCount: entries.length,
    hostRootClass: 'session-owned'
  }, zeroObserverSideEffects)
}

export function createFileTreeObserver() {
  return Object.freeze({ observerId: 'fixture-file-tree', version: 'v1', observe: observeFileTree })
}
