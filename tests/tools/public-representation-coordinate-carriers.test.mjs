import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  manifest
} from '../../tools/contracts/public-representation-coordinate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('transport harness is projection-only and adds no database or Redis hot-path lookup', async () => {
  const source = await readFile(path.join(root, 'tools/contracts/public-representation-coordinate.mjs'), 'utf8')
  assert.doesNotMatch(source, /SqlSugar|DbContext|StackExchange\.Redis|IDistributedCache|fetch\s*\(/u)
  assert.match(source, /projectCanonicalState/u)
  assert.match(source, /validateTransition/u)
})

test('existing artifact carriers expose every coordinate input without another wire authority', async () => {
  const [aotEntry, navigation, hotRead, serviceWorker, aedsAuthority, releaseAuthority] = await Promise.all([
    readFile(path.join(root, 'src/backend/Infrastructure/PublicAot/PublicAotCacheEntry.cs'), 'utf8'),
    readFile(path.join(root, 'src/backend/Infrastructure/PublicAot/PublicAotNavigationSnapshot.cs'), 'utf8'),
    readFile(path.join(root, 'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs'), 'utf8'),
    readFile(path.join(root, 'src/frontend/public/sw.js'), 'utf8'),
    readFile(path.join(root, manifest.existingAuthorities.aedsProtocol), 'utf8'),
    readFile(path.join(root, manifest.existingAuthorities.releaseIdentity), 'utf8')
  ])

  for (const field of ['RouteKey', 'RendererVersion', 'FrontendAssetVersion', 'HydrationSidecar']) {
    assert.match(aotEntry, new RegExp(`\\b${field}\\b`, 'u'))
  }
  for (const field of ['CanonicalPath', 'PayloadHash', 'SeoHead', 'PageKind']) {
    assert.match(navigation, new RegExp(`\\b${field}\\b`, 'u'))
  }
  for (const field of ['PublicationEvidence', 'SourceVersion', 'VisibilitySourceVersion', 'FrameType', 'IntegrityTag']) {
    assert.match(hotRead, new RegExp(`\\b${field}\\b`, 'u'))
  }
  assert.match(serviceWorker, /CACHE_NAMESPACE = FRONTEND_BUILD_ID/u)
  assert.match(aedsAuthority, /"version"\s*:\s*2/u)
  assert.match(releaseAuthority, /release-id/u)
  assert.doesNotMatch(JSON.stringify(manifest), /"aedsMagic"|"releaseIdRegex"/u)
})
