import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CanonicalMediaAssetStore } from '../../tools/test-fixtures/canonical-media-asset-store.mjs'
import { materializePositiveMedia } from '../../tools/test-fixtures/media-positive-generator.mjs'
import {
  MEDIA_NEGATIVE_CASE_IDS,
  inspectVerifiedPng,
  loadMediaNegativeCorpusPlan,
  materializeMediaNegativeCorpus,
  scanMediaNegativeCorpusGovernance,
  validateMediaNegativeCorpusPlan,
  verifyMediaNegativeCorpusReceipt
} from '../../tools/test-fixtures/media-negative-corpus.mjs'

const positivePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function reseal(document) {
  delete document.contentDigest
  document.contentDigest = digest(stableStringify(document))
  return document
}

function positiveReceipt(overrides = {}) {
  const facts = inspectVerifiedPng(positivePng)
  return reseal({
    schema: 'fsusblog.media-positive-asset-receipt.v1',
    validityClass: 'canonical-positive',
    verificationStatus: 'verified',
    materializationOwner: 'canonical-media-positive-generator',
    assetId: '10000000-0000-5000-8000-000000000001',
    shapeId: 'png.square.alpha',
    format: facts.format,
    mime: facts.mime,
    extension: facts.extension,
    dimensions: { width: facts.width, height: facts.height },
    byteDigest: facts.byteDigest,
    byteLength: facts.byteLength,
    decodedDigest: digest('one-transparent-pixel'),
    ...overrides
  })
}

test('real catalog generator and canonical AssetId store feed the complete negative corpus without ledger contamination', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fsusblog-media-e2e-'))
  const positiveRoot = path.join(directory, 'positive')
  const corpusRoot = path.join(directory, 'negative')
  try {
    const store = new CanonicalMediaAssetStore({ root: positiveRoot, runNamespace: 'media-negative-e2e' })
    const positive = materializePositiveMedia({ store, shapeIds: ['png-alpha'] }).receipts[0]
    const bytes = store.read({
      assetId: positive.assetId,
      storageKey: positive.storageRef.storageKey,
      byteDigest: positive.byteDigest
    })
    const ledgerBefore = store.receipt()
    const receipt = materializeMediaNegativeCorpus({
      positiveBytes: bytes,
      positiveReceipt: positive,
      positiveRoot,
      corpusRoot
    })
    assert.deepEqual(verifyMediaNegativeCorpusReceipt({ receipt, corpusRoot }), [])
    assert.deepEqual(receipt.cases.map((item) => item.caseId), MEDIA_NEGATIVE_CASE_IDS)
    assert.equal(receipt.sourceAssetId, positive.assetId)
    assert.deepEqual(store.receipt(), ledgerBefore)
    assert.equal(store.receipt().records.length, 1)
    assert.equal(receipt.cases.every((item) => item.isolation.positiveAssetIdCreated === false), true)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fsusblog-media-negative-'))
  const positiveRoot = path.join(directory, 'positive')
  fs.mkdirSync(positiveRoot, { mode: 0o700 })
  fs.writeFileSync(path.join(positiveRoot, 'asset.png'), positivePng, { mode: 0o600 })
  return {
    directory,
    positiveRoot,
    corpusRoot: path.join(directory, 'negative'),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('media negative plan is the closed single authority for all eight classes', () => {
  const plan = loadMediaNegativeCorpusPlan()
  assert.deepEqual(validateMediaNegativeCorpusPlan(plan), [])
  assert.deepEqual(plan.cases.map((item) => item.id), MEDIA_NEGATIVE_CASE_IDS)
  assert.equal(new Set(plan.cases.map((item) => item.faultCondition)).size, 8)
  assert.equal(new Set(plan.cases.map((item) => item.reasonCode)).size, 8)
  assert.deepEqual(scanMediaNegativeCorpusGovernance(), [])
})

test('runner materializes isolated single-fault cases with stable closed outcomes', () => {
  const sample = fixture()
  try {
    const positiveBefore = fs.readFileSync(path.join(sample.positiveRoot, 'asset.png'))
    const receipt = materializeMediaNegativeCorpus({
      positiveBytes: positivePng,
      positiveReceipt: positiveReceipt(),
      positiveRoot: sample.positiveRoot,
      corpusRoot: sample.corpusRoot
    })
    assert.deepEqual(verifyMediaNegativeCorpusReceipt({ receipt, corpusRoot: sample.corpusRoot }), [])
    assert.deepEqual(receipt.cases.map((item) => item.caseId), MEDIA_NEGATIVE_CASE_IDS)
    assert.equal(receipt.cases.every((item) => item.singleFault.independentFaultCount === 1), true)
    assert.equal(receipt.cases.every((item) => item.actual.reasonCode === item.expected.reasonCode), true)
    assert.equal(receipt.cases.every((item) => item.actual.attempts === 1 && item.actual.cleanSuccessAfterRetry === false), true)
    assert.equal(receipt.cases.every((item) => item.isolation.positiveAssetIdCreated === false), true)
    assert.equal(receipt.resourceSafety.actualHugeBitmapAllocated, false)
    assert.equal(receipt.resourceSafety.rootEscapeAttempted, false)
    assert.deepEqual(fs.readFileSync(path.join(sample.positiveRoot, 'asset.png')), positiveBefore)
    assert.equal(fs.existsSync(path.join(sample.corpusRoot, 'missing-404.negative')), false)
    assert.equal(fs.existsSync(path.join(sample.corpusRoot, 'unsafe-path.negative')), false)
    assert.equal(fs.statSync(path.join(sample.corpusRoot, 'zero-byte.negative')).size, 0)
    assert.ok(fs.statSync(path.join(sample.corpusRoot, 'oversized-dimensions.negative')).size < 1024)
    assert.doesNotMatch(JSON.stringify(receipt), /(?:\/tmp\/|\.\.\/)/u)
  } finally {
    sample.cleanup()
  }
})

test('rerun in another run-owned root produces the same failure semantics', () => {
  const sample = fixture()
  try {
    const first = materializeMediaNegativeCorpus({
      positiveBytes: positivePng,
      positiveReceipt: positiveReceipt(),
      positiveRoot: sample.positiveRoot,
      corpusRoot: sample.corpusRoot
    })
    const secondRoot = path.join(sample.directory, 'negative-rerun')
    const second = materializeMediaNegativeCorpus({
      positiveBytes: positivePng,
      positiveReceipt: positiveReceipt(),
      positiveRoot: sample.positiveRoot,
      corpusRoot: secondRoot
    })
    assert.equal(second.contentDigest, first.contentDigest)
    assert.deepEqual(second.cases.map((item) => item.actual), first.cases.map((item) => item.actual))
    assert.deepEqual(verifyMediaNegativeCorpusReceipt({ receipt: second, corpusRoot: secondRoot }), [])
  } finally {
    sample.cleanup()
  }
})

test('diagnostic execution remains non-qualifying and physically isolated', () => {
  const sample = fixture()
  try {
    const receipt = materializeMediaNegativeCorpus({
      positiveBytes: positivePng,
      positiveReceipt: positiveReceipt(),
      positiveRoot: sample.positiveRoot,
      corpusRoot: sample.corpusRoot,
      executionClass: 'diagnostic-only'
    })
    assert.equal(receipt.executionClass, 'diagnostic-only')
    assert.equal(receipt.cases.every((item) => item.validityClass === 'negative-invalid'), true)
    assert.equal(receipt.cases.every((item) => item.isolation.positiveProfileEntryCreated === false), true)
  } finally {
    sample.cleanup()
  }
})

test('independent verifier rejects byte, receipt, multi-fault, and retry tampering', () => {
  const sample = fixture()
  try {
    const receipt = materializeMediaNegativeCorpus({
      positiveBytes: positivePng,
      positiveReceipt: positiveReceipt(),
      positiveRoot: sample.positiveRoot,
      corpusRoot: sample.corpusRoot
    })
    fs.appendFileSync(path.join(sample.corpusRoot, 'unsupported-format.negative'), 'tamper')
    assert.match(verifyMediaNegativeCorpusReceipt({ receipt, corpusRoot: sample.corpusRoot }).join('\n'), /unsupported-format negative bytes were tampered/)

    const multiFault = structuredClone(receipt)
    const corrupt = multiFault.cases.find((item) => item.caseId === 'corrupt-header')
    fs.writeFileSync(path.join(sample.corpusRoot, 'corrupt-header.negative'), Buffer.alloc(0))
    corrupt.negativeByteDigest = digest(Buffer.alloc(0))
    corrupt.negativeByteLength = 0
    reseal(corrupt)
    reseal(multiFault)
    assert.match(verifyMediaNegativeCorpusReceipt({ receipt: multiFault, corpusRoot: sample.corpusRoot }).join('\n'), /corrupt-header is not an isolated header fault/)

    const retryTamper = structuredClone(receipt)
    retryTamper.cases[0].actual.attempts = 2
    reseal(retryTamper.cases[0])
    reseal(retryTamper)
    assert.match(verifyMediaNegativeCorpusReceipt({ receipt: retryTamper, corpusRoot: sample.corpusRoot }).join('\n'), /reason or retry evidence is invalid/)
  } finally {
    sample.cleanup()
  }
})

test('runner rejects unverified sources, stale metadata, root escape, and unsafe execution classes', () => {
  const sample = fixture()
  try {
    assert.throws(() => materializeMediaNegativeCorpus({
      positiveBytes: positivePng,
      positiveReceipt: positiveReceipt({ verificationStatus: 'claimed' }),
      positiveRoot: sample.positiveRoot,
      corpusRoot: sample.corpusRoot
    }), /not from the required verified canonical authority/)
    assert.throws(() => materializeMediaNegativeCorpus({
      positiveBytes: positivePng,
      positiveReceipt: positiveReceipt({ byteLength: positivePng.length + 1 }),
      positiveRoot: sample.positiveRoot,
      corpusRoot: sample.corpusRoot
    }), /byteLength does not match verified bytes/)
    assert.throws(() => materializeMediaNegativeCorpus({
      positiveBytes: positivePng,
      positiveReceipt: positiveReceipt(),
      positiveRoot: sample.positiveRoot,
      corpusRoot: path.join(sample.positiveRoot, 'escaped')
    }), /physically isolated/)
    assert.equal(fs.existsSync(path.join(sample.positiveRoot, 'escaped')), false)
    assert.throws(() => materializeMediaNegativeCorpus({
      positiveBytes: positivePng,
      positiveReceipt: positiveReceipt(),
      positiveRoot: sample.positiveRoot,
      corpusRoot: sample.corpusRoot,
      executionClass: 'runtime'
    }), /cannot consume/)
  } finally {
    sample.cleanup()
  }
})

test('plan and static governance reject second authority, multi-fault aliases, huge allocation, path I/O, and retry loops', () => {
  const plan = loadMediaNegativeCorpusPlan()
  plan.cases[1].faultCondition = plan.cases[0].faultCondition
  plan.cases[1].retryPolicy = 'until-success'
  plan.resourceLimits.maximumAttempts = 2
  assert.match(validateMediaNegativeCorpusPlan(plan).join('\n'), /conditions must be unique/)
  assert.match(validateMediaNegativeCorpusPlan(plan).join('\n'), /maximumAttempts must remain one/)
  assert.match(validateMediaNegativeCorpusPlan(plan).join('\n'), /fail-closed without retry/)

  const errors = scanMediaNegativeCorpusGovernance({
    additionalSources: [
      ['huge.mjs', 'Buffer.alloc(width * height * 4)'],
      ['escape.mjs', 'fs.writeFileSync(unsafeLogicalPath, bytes)'],
      ['retry.mjs', 'while (attempt < retry) attempt += 1'],
      ['pollution.mjs', "validityClass: 'canonical-positive', negative: true"]
    ]
  })
  assert.match(errors.join('\n'), /allocates a bitmap/)
  assert.match(errors.join('\n'), /filesystem I\/O with an unsafe path/)
  assert.match(errors.join('\n'), /retry recovery/)
  assert.match(errors.join('\n'), /canonical positive record/)
})
