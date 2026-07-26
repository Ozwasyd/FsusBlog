import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { selectBrowserDiagnostics } from '../browser-diagnostics/catalog.mjs'
import { runBrowserDiagnostics } from '../browser-diagnostics/run.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
const localFsusUiFixture = Object.freeze({
  schema: 'fsusblog.browser-diagnostics.local-fsusui-identity.v1',
  commit: 'd'.repeat(40),
  contentDigest: `sha256:${'e'.repeat(64)}`
})

test('release-runtime catalog binds exact native IDs, artifacts and post-run producers', () => {
  const category = selectBrowserDiagnostics(['release-runtime'])[0]
  assert.deepEqual(category.probes.map((probe) => probe.testIds), [
    [
      'check:security:attack-matrix',
      'check:security:permissions',
      'release-runtime/release-rbac-negative'
    ],
    [
      'check:distribution-version-coherence',
      'check:pow-runtime',
      'check:public-hydration',
      'release-runtime/release-aot-consumption'
    ]
  ])
  assert.deepEqual(category.probes.map((probe) => probe.artifactPaths), [
    ['.tmp/browser-diagnostics-runtime/release-runtime/release-rbac-negative.json'],
    ['.tmp/browser-diagnostics-runtime/release-runtime/release-aot-consumption.json']
  ])
  const releaseRuntimeLane = read('tools/test/lanes/browser-diagnostics-risk.sh')
  for (const assertionId of [
    'check:security:attack-matrix',
    'check:security:permissions',
    'check:distribution-version-coherence',
    'check:pow-runtime',
    'check:public-hydration'
  ]) assert.match(releaseRuntimeLane, new RegExp(assertionId.replaceAll(':', '\\:')))
})

test('release-runtime runner writes one scoped receipt with exact native probe and assertion IDs', async () => {
  const token = `release-runtime-${process.pid}-${Date.now()}`
  const outputRoot = path.join(root, '.tmp/browser-diagnostics', token)
  const artifactRoot = path.join(root, '.tmp/browser-diagnostics-contract', token)
  const scopedReceiptFile = path.join(root, '.tmp/browser-diagnostics/release-runtime-receipt.json')
  const priorScopedReceipt = fs.existsSync(scopedReceiptFile)
    ? fs.readFileSync(scopedReceiptFile)
    : null
  const canonical = selectBrowserDiagnostics(['release-runtime'])[0]
  const categories = [{
    ...canonical,
    probes: canonical.probes.map((probe) => ({
      ...probe,
      artifactPaths: [`.tmp/browser-diagnostics-contract/${token}/${probe.id}.json`]
    }))
  }]
  try {
    const result = await runBrowserDiagnostics({
      mode: 'manual',
      categoryIds: [],
      planOnly: false,
      workers: 1,
      outputRoot,
      probeTimeoutMinutes: null
    }, {
      categories,
      runId: token,
      source: {
        commit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64),
        build: {
          contentDigest: `sha256:${'c'.repeat(64)}`,
          sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
        }
      },
      localFsusUi: localFsusUiFixture,
      executeProbe: async ({ probe }) => {
        writeJson(path.join(root, probe.artifactPaths[0]), { probeId: probe.id })
        return {
          status: 'success',
          failureClass: null,
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 1
        }
      }
    })
    assert.equal(result.status, 'success')
    const scoped = JSON.parse(fs.readFileSync(scopedReceiptFile, 'utf8'))
    assert.equal(scoped.schema, 'fsusblog.browser-diagnostics-release-runtime-receipt.v1')
    assert.equal(scoped.status, 'success')
    assert.equal(scoped.runId, token)
    assert.deepEqual(scoped.category.plannedProbeIds, [
      'release-aot-consumption',
      'release-rbac-negative'
    ])
    assert.deepEqual(scoped.category.probes.map((probe) => probe.testIds), [
      [
        'check:security:attack-matrix',
        'check:security:permissions',
        'release-runtime/release-rbac-negative'
      ],
      [
        'check:distribution-version-coherence',
        'check:pow-runtime',
        'check:public-hydration',
        'release-runtime/release-aot-consumption'
      ]
    ])
    assert.equal(scoped.diagnosticsReceipt.contentDigest, result.receipt.contentDigest)
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
    fs.rmSync(artifactRoot, { recursive: true, force: true })
    if (priorScopedReceipt) {
      fs.mkdirSync(path.dirname(scopedReceiptFile), { recursive: true })
      fs.writeFileSync(scopedReceiptFile, priorScopedReceipt)
    } else {
      fs.rmSync(scopedReceiptFile, { force: true })
    }
  }
})
