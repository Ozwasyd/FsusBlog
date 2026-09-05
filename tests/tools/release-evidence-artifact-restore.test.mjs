import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
    beginCurrentRunEvidencePublication,
    finalizeCurrentRunEvidencePublication
} from '../../tools/test/current-run-evidence-publication.mjs'
import { completeEvidenceLocatorRegistryEntry, governanceContentDigest } from '../../tools/test/evidence-location-contract.mjs'
import { packCurrentRunEvidenceTransport } from '../../tools/test/current-run-evidence-transport.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const restoreScript = path.join(root, 'tools/operations/restore-downloaded-artifacts.sh')
const d = (value) => `sha256:${value.repeat(64)}`

test('restore refuses downloaded artifacts without a transport manifest', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-artifact-restore-'))
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
  const downloadedRoot = path.join(fixtureRoot, 'downloaded')
  fs.mkdirSync(path.join(downloadedRoot, 'stripped'), { recursive: true })
  fs.writeFileSync(path.join(downloadedRoot, 'stripped/receipt.json'), '{}\n')
  const result = spawnSync('bash', [restoreScript, downloadedRoot, path.join(fixtureRoot, 'restored')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /without a transport manifest/u)
})

test('restore extracts downloaded evidence only through a transport manifest', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-artifact-transport-'))
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
  fs.mkdirSync(path.join(fixtureRoot, 'artifacts/current-run'), { recursive: true })
  const contextBody = {
    schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: 'run-1',
    attemptId: 'attempt-1', sourceCommit: 'a'.repeat(40), worktreeFingerprint: d('b'),
    candidateIdentity: { id: 'candidate', digest: d('c') },
    buildIdentity: { id: 'build', digest: d('d') }, ownedRoots: ['artifacts/current-run']
  }
  const context = { ...contextBody, contentDigest: governanceContentDigest(contextBody) }
  const entry = completeEvidenceLocatorRegistryEntry({
    consumerId: 'evidence-consumer.release.check-release-final',
    authorityId: 'evidence-consumer.release.check-release-final.current-run',
    producerId: 'evidence-consumer.release.check-release-final.producer',
    receiptSchema: 'fsusblog.current-run-evidence-reference.v1', locatorMode: 'explicit-run-path',
    requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId',
      'sourceCommit', 'worktreeFingerprint'],
    requiredDigestFields: ['contentDigest', 'producerReceiptDigest'], expectedCardinality: 'exact-one',
    allowedRoots: ['artifacts/current-run'], publicationMode: 'hooked',
    payloadBindingKey: 'FSUSBLOG_PAYLOAD_PATH', producerCommand: 'node producer.mjs'
  })
  const payloadPath = 'artifacts/current-run/payload.json'
  const outputPath = 'artifacts/current-run/reference.json'
  const session = beginCurrentRunEvidencePublication({
    authorityId: entry.authorityId, context, outputPath, payloadPath,
    producerId: entry.producerId, repositoryRoot: fixtureRoot
  })
  fs.writeFileSync(path.join(fixtureRoot, payloadPath), `${JSON.stringify({ schema: 'payload.v1', ok: true })}\n`)
  const published = finalizeCurrentRunEvidencePublication({
    authorityId: entry.authorityId, context, outputPath, payloadPath, payloadSchema: 'payload.v1',
    producerId: entry.producerId, repositoryRoot: fixtureRoot, sessionId: session.sessionId,
    terminalStatus: 'success'
  })
  packCurrentRunEvidenceTransport({
    context, repositoryRoot: fixtureRoot,
    archivePath: 'artifacts/current-run/transport-archive.json',
    manifestPath: 'artifacts/current-run/transport-manifest.json',
    transportRunId: 'transport-1', downloadRunId: 'download-1',
    objects: [{
      authorityId: entry.authorityId, producerId: entry.producerId, receiptSchema: entry.receiptSchema,
      originalRef: {
        path: outputPath, contentDigest: published.receipt.contentDigest,
        producerReceiptDigest: published.receipt.producerReceiptDigest
      },
      files: [{ path: outputPath }, { path: payloadPath }]
    }]
  })
  fs.rmSync(path.join(fixtureRoot, outputPath))
  fs.rmSync(path.join(fixtureRoot, payloadPath))
  const result = spawnSync('bash', [restoreScript, path.join(fixtureRoot, 'downloaded'), fixtureRoot], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FSUSBLOG_REPOSITORY_ROOT: fixtureRoot,
      FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST: path.join(fixtureRoot, 'artifacts/current-run/transport-manifest.json')
    },
    timeout: 10_000
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.existsSync(path.join(fixtureRoot, outputPath)), true)
})
