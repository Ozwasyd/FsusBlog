import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { isValidReleaseId } from '../../tools/release/release-id.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const validReleaseId = '20260720010203-abcdef123456'
const invalidReleaseIds = [
  'release-20260720',
  '20260720999999-abcdef123456',
  '20260720010203-ABCDEF123456',
  'latest'
]

test('classic service worker generated validator matches the release ID authority', () => {
  const source = fs.readFileSync(path.join(root, 'src/frontend/public/generated/release-id-contract.js'), 'utf8')
  const context = { self: {} }
  vm.runInNewContext(source, context)

  assert.equal(context.self.FsusReleaseIdContract.isCanonicalReleaseId(validReleaseId), true)
  for (const releaseId of invalidReleaseIds) {
    assert.equal(context.self.FsusReleaseIdContract.isCanonicalReleaseId(releaseId), false)
    assert.equal(isValidReleaseId(releaseId, { forPublication: true }), false)
  }
})

test('release ID validator consumers use the authority adapters for their runtime', () => {
  for (const [relative, helpers] of [
    ['tools/operations/check-release-evidence-manifest.mjs', ['assertReleaseIdentity', 'isValidReleaseId']],
    ['tools/operations/seal-release-evidence-bundle.mjs', ['assertReleaseIdentity']],
    ['tools/operations/evidence-classification.mjs', ['isValidReleaseId']],
    ['tools/operations/check-release-evidence-layout.mjs', ['isValidReleaseId']]
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8')
    for (const helper of helpers) {
      assert.match(
        source,
        new RegExp(`import \\{[^}]*\\b${helper}\\b[^}]*\\} from '\\.\\.\\/release\\/release-id\\.mjs'`, 'su'),
        `${relative} must import ${helper}`
      )
      assert.match(source, new RegExp(`\\b${helper}\\(`, 'u'), `${relative} must call ${helper}`)
    }
    assert.doesNotMatch(source, /\^\[0-9A-Za-z\]\[0-9A-Za-z\._-\]\{5,127\}\$/u)
  }

  const collector = fs.readFileSync(path.join(root, 'tools/operations/collect-release-evidence.sh'), 'utf8')
  assert.match(collector, /tools\/release\/check-release-manifest\.mjs/u)
  const storageWorkflow = fs.readFileSync(path.join(root, '.github/workflows/release-evidence-storage.yml'), 'utf8')
  assert.match(storageWorkflow, /tools\/release\/release-id\.mjs assert/u)

  for (const relative of [
    'src/backend/Services/SearchIndexService.cs',
    'src/backend/Infrastructure/Storage/ReleaseStorageLayout.cs'
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8')
    assert.match(source, /ReleaseIdContract\.TryParse/u)
  }

  const serviceWorker = fs.readFileSync(path.join(root, 'src/frontend/public/sw.js'), 'utf8')
  assert.match(serviceWorker, /importScripts\('\/generated\/release-id-contract\.js'\)/u)
  assert.match(serviceWorker, /FsusReleaseIdContract\.isCanonicalReleaseId/u)
  assert.doesNotMatch(serviceWorker, /const CANONICAL_RELEASE_ID_PATTERN/u)
})

test('release build deployment and storage validators consume the authority', () => {
  for (const relative of [
    'tools/release/release-manifest.mjs',
    'tools/deployment/slot-lib.mjs',
    'tools/deployment/release-rollout-lib.mjs',
    'tools/deployment/zero-downtime-rehearsal-plan.mjs',
    'tools/deployment/active-release-fence.mjs',
    'tools/deployment/notification-stream-restart.mjs',
    'tools/storage/release-assets.mjs'
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8')
    assert.match(source, /import \{[^}]*isValidReleaseId[^}]*\} from/su, relative)
    assert.match(source, /isValidReleaseId\(/u, relative)
  }

  for (const relative of [
    'tools/build-final-image.sh',
    'tools/deploy-production.sh',
    'tools/deployment/deployment-control.sh',
    'tools/deployment/release-rollout.sh',
    'tools/deployment/slot-start.sh'
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8')
    if (relative === 'tools/build-final-image.sh') {
      assert.match(source, /tools\/release\/release-id\.mjs"? "\$\{identity_args\[@\]\}"/u, relative)
    } else {
      assert.match(source, /tools\/release\/release-id\.mjs"? validate/u, relative)
    }
  }
  const build = fs.readFileSync(path.join(root, 'tools/build-final-image.sh'), 'utf8')
  assert.match(build, /identity_args=\(snapshot/u)
})
