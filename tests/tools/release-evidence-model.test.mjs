import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { checkReleaseEvidenceLayout } from '../../tools/operations/check-release-evidence-layout.mjs'
import {
  sealReleaseEvidenceBundle,
  writeReleaseIndexAfterRequireOk
} from '../../tools/operations/seal-release-evidence-bundle.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')
const temporaryRoots = []

function temporaryRoot(label) {
  const directory = mkdtempSync(path.join(tmpdir(), `fsusblog-${label}-`))
  temporaryRoots.push(directory)
  return directory
}

function copyPath(fromRoot, toRoot, relative) {
  const destination = path.join(toRoot, relative)
  mkdirSync(path.dirname(destination), { recursive: true })
  cpSync(path.join(fromRoot, relative), destination, { recursive: true })
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function layoutFixture() {
  const fixture = temporaryRoot('evidence-layout')
  for (const relative of [
    'security/evidence-contracts',
    'tests/fixtures/evidence',
    'docs/reports/open-source-readiness/v1.1.0-public-preview',
    'security/matrices/privacy-zk-comment.yml',
    '.github/workflows/release-evidence-storage.yml'
  ]) copyPath(root, fixture, relative)
  return fixture
}

function releaseManifest(status = 'collected-blocked') {
  return {
    status,
    releaseStamp: 'fixture',
    generatedAt: '2026-07-18T00:00:00Z',
    gitRevision: 'a'.repeat(12),
    commitSha: 'a'.repeat(40),
        workflowRun: { id: '12345', attempt: '1', workflow: 'fixture' },
        imageDigest: `sha256:${'b'.repeat(64)}`,
        releaseIdentity: {
            releaseId: '20260718000000-aaaaaaaaaaaa',
            createdAtUtc: '2026-07-18T00:00:00Z',
            commitSha: 'a'.repeat(40),
            imageDigest: `sha256:${'b'.repeat(64)}`,
            releaseSlot: 'green',
      runtimeProfile: { id: 'throughput-musl' }
    },
    artifacts: {},
    artifactDigests: {},
    evidenceSummary: {}
  }
}

function bundleFixture(status = 'collected-blocked') {
  const bundle = temporaryRoot('evidence-bundle')
  writeJson(path.join(bundle, 'manifest.json'), releaseManifest(status))
  writeJson(path.join(bundle, 'security', 'scan.json'), { status: 'ok', findingCount: 0 })
  writeFileSync(path.join(bundle, 'notes.txt'), 'fixture\n')
  return bundle
}

test.after(() => {
  for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true })
})

test('repository separates historical reports, static evidence, fixtures, and fresh authorities', () => {
  assert.deepEqual(checkReleaseEvidenceLayout(root), [])
  assert.deepEqual(checkReleaseEvidenceLayout(layoutFixture()), [])

  const sourceLayout = JSON.parse(readFileSync(path.join(root, 'tests/governance/repository-source-layout.json'), 'utf8'))
  assert.equal(sourceLayout.rootDirectories.find(entry => entry.path === 'release-index')?.classification, 'release-index')
  assert.ok(sourceLayout.forbiddenRootSourceDirectories.includes('release-evidence'))
  assert.equal(sourceLayout.rootDirectories.some(entry => entry.path === 'release-evidence'), false)
})

test('layout governance reports ambiguous, contradictory, historical, matrix, and index violations together', () => {
  const fixture = layoutFixture()
  writeJson(path.join(fixture, 'release-evidence', 'ambiguous.json'), { status: 'ok' })

  const attestationPath = path.join(fixture, 'security/evidence-contracts/public-revocation-distribution.json')
  const attestation = JSON.parse(readFileSync(attestationPath, 'utf8'))
  attestation.freshExecution = true
  attestation.status = 'ok'
  writeJson(attestationPath, attestation)

  const readmePath = path.join(fixture, 'docs/reports/open-source-readiness/v1.1.0-public-preview/README.md')
  writeFileSync(readmePath, '# Historical report without warning\n')

  const matrixPath = path.join(fixture, 'security/matrices/privacy-zk-comment.yml')
  const matrixSource = readFileSync(matrixPath, 'utf8')
  const dualClassNeedle = 'security/evidence-contracts/public-revocation-distribution.json'
  const freshItem = /^(?<indent>[ \t]*)fresh-run-evidence:\s*\n(?<itemIndent>[ \t]*)- /m.exec(matrixSource)
  assert.ok(freshItem, 'fixture matrix must declare fresh-run-evidence items')
  const insertAt = freshItem.index + freshItem[0].indexOf('\n') + 1
  const matrix = `${matrixSource.slice(0, insertAt)}${freshItem.groups.itemIndent}- ${dualClassNeedle}\n${matrixSource.slice(insertAt)}`
  writeFileSync(matrixPath, matrix)
  writeJson(path.join(fixture, 'release-index', 'forged.json'), {
    schema: 'wrong',
    status: 'green',
    path: 'tracked-static.json'
  })

  const errors = checkReleaseEvidenceLayout(fixture)
  assert.ok(errors.some(error => error.includes('top-level release-evidence/ is forbidden')))
  assert.ok(errors.some(error => error.includes('cannot claim freshExecution')))
  assert.ok(errors.some(error => error.includes('top-level status is ambiguous')))
  assert.ok(errors.some(error => error.includes('missing explicit historical snapshot banner')))
  assert.ok(errors.some(error => error.includes('classified as both')))
  assert.ok(errors.some(error => error.includes('strict identity and integrity schema')))
})

test('bundle sealer hashes every copied artifact and detects later tampering', () =>
{
    const bundle = bundleFixture();
    const result = sealReleaseEvidenceBundle(bundle, {
        releaseNamespace: '20260718000000-aaaaaaaaaaaa--bbbbbbbbbbbb',
        environment: {}
    });
    assert.equal(result.manifest.schema, 'fsusblog.release-evidence-manifest.v2');
  assert.equal(result.manifest.evidenceClass, 'fresh-run-evidence')
  assert.equal(result.manifest.artifactInventory.fileCount, 2)
  assert.deepEqual(result.manifest.artifactInventory.files.map(file => file.path), [
    'notes.txt',
    'security/scan.json'
  ])
  assert.equal(existsSync(path.join(bundle, 'release-index.json')), false)

  writeFileSync(path.join(bundle, 'notes.txt'), 'tampered\n')
  const checked = spawnSync(process.execPath, [
    path.join(root, 'tools/operations/check-release-evidence-manifest.mjs'),
    path.join(bundle, 'manifest.json')
  ], { cwd: root, encoding: 'utf8' })
  assert.notEqual(checked.status, 0)
  assert.match(checked.stderr, /artifactInventory\.files must exactly seal every copied bundle artifact/)
})

test('collected-ok bundle remains a fresh candidate until require-ok succeeds', () =>
{
    const bundle = bundleFixture('collected-ok');
    const result = sealReleaseEvidenceBundle(bundle, {
        releaseNamespace: '20260718000000-aaaaaaaaaaaa--bbbbbbbbbbbb',
        environment: {
            GITHUB_RUN_ID: '12345',
            GITHUB_REPOSITORY: 'Ozwasyd/FsusBlog'
    }
  })
  assert.equal(result.manifest.evidenceClass, 'fresh-run-evidence')
  assert.equal(result.manifest.productionFreshRun, true)
  assert.equal(result.manifest.targetEnvironment, 'production')
  assert.deepEqual(result.manifest.targetTopology, {
    releaseSlot: 'green',
    runtimeProfileId: 'throughput-musl'
  })
  assert.equal(existsSync(path.join(bundle, 'release-index.json')), false)
})

test('v2 checker rejects timestamp, environment, topology, namespace, and storage identity drift together', () =>
{
    const bundle = bundleFixture();
    const result = sealReleaseEvidenceBundle(bundle, {
        releaseNamespace: '20260718000000-aaaaaaaaaaaa--bbbbbbbbbbbb',
        environment: {
            GITHUB_RUN_ID: '12345',
            GITHUB_REPOSITORY: 'Ozwasyd/FsusBlog'
    }
  })
  result.manifest.generatedAt = 'not-a-timestamp'
  result.manifest.targetEnvironment = ''
  result.manifest.targetTopology.releaseSlot = 'blue'
  result.manifest.releaseNamespace = 'safe-but-unbound'
  result.manifest.storage.artifactName = 'fsusblog-release-evidence-forged-aaaaaaaaaaaa'
  writeJson(path.join(bundle, 'manifest.json'), result.manifest)

  const checked = spawnSync(process.execPath, [
    path.join(root, 'tools/operations/check-release-evidence-manifest.mjs'),
    path.join(bundle, 'manifest.json')
  ], { cwd: root, encoding: 'utf8' })
  assert.notEqual(checked.status, 0)
  assert.match(checked.stderr, /generatedAt must be an ISO UTC timestamp/)
  assert.match(checked.stderr, /targetEnvironment must explicitly identify/)
  assert.match(checked.stderr, /targetTopology must match/)
  assert.match(checked.stderr, /releaseNamespace must bind/)
  assert.match(checked.stderr, /storage artifact name must bind/)
})

test('small release index is created only after the require-ok authority succeeds', () => {
  const bundle = bundleFixture('collected-ok')
  const checker = path.join(temporaryRoot('accepting-checker'), 'checker.mjs')
    writeFileSync(checker, 'process.exit(0)\n');
    const result = writeReleaseIndexAfterRequireOk(bundle, {
        checkerPath: checker,
        releaseNamespace: '20260718000000-aaaaaaaaaaaa--bbbbbbbbbbbb',
        environment: {
            GITHUB_RUN_ID: '12345',
            GITHUB_REPOSITORY: 'Ozwasyd/FsusBlog'
    }
  })
    assert.equal(result.index.status, 'collected-ok');
    assert.equal(result.manifest.evidenceClass, 'release-closeout-evidence');
    assert.match(result.index.evidenceBundleSha256, /^sha256:[0-9a-f]{64}$/);
    assert.match(result.index.storageReference, /actions\/runs\/12345\/artifacts\/fsusblog-release-evidence-20260718000000-aaaaaaaaaaaa$/);
    assert.deepEqual(Object.keys(result.index).sort(), [
        'commitSha',
        'evidenceBundleSha256',
    'generatedAt',
    'imageDigest',
    'releaseId',
    'retentionDays',
    'schema',
    'status',
    'storageReference'
  ])
})

test('failed require-ok authority cannot leave a release index', () => {
  const bundle = bundleFixture('collected-ok')
  const checker = path.join(temporaryRoot('rejecting-checker'), 'checker.mjs')
    writeFileSync(checker, "process.stderr.write('blocked fixture\\n'); process.exit(1)\n");
    assert.throws(() => writeReleaseIndexAfterRequireOk(bundle, {
        checkerPath: checker,
        releaseNamespace: '20260718000000-aaaaaaaaaaaa--bbbbbbbbbbbb',
        environment: {
            GITHUB_RUN_ID: '12345',
            GITHUB_REPOSITORY: 'Ozwasyd/FsusBlog'
    }
  }), /requires successful --require-ok validation/)
  assert.equal(existsSync(path.join(bundle, 'release-index.json')), false)
  const manifest = JSON.parse(readFileSync(path.join(bundle, 'manifest.json'), 'utf8'))
  assert.equal(manifest.evidenceClass, 'fresh-run-evidence')
})
