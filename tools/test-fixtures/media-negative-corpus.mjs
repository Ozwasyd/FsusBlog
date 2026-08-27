import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const mediaNegativeCorpusPlanFile = path.join(root, 'config/testing/media-negative-corpus-plan.json')
export const mediaNegativeCorpusSchemaFile = path.join(root, 'config/schemas/media-negative-corpus-plan.schema.json')

export const MEDIA_NEGATIVE_CASE_IDS = Object.freeze([
  'corrupt-header',
  'mime-extension-mismatch',
  'missing-404',
  'oversized-dimensions',
  'truncated',
  'unsafe-path',
  'unsupported-format',
  'zero-byte'
])

const digestPattern = /^sha256:[a-f0-9]{64}$/u
const stableIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u
const canonicalAssetIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const unsupportedBytes = Buffer.from('FSUSBLOG_UNSUPPORTED_MEDIA_V1\0', 'ascii')
const conditionDefaults = Object.freeze({
  availability: 'present',
  'byte-state': 'non-empty',
  'declaration-consistency': 'match',
  'dimensions-admission': 'accepted',
  'format-support': 'supported',
  'header-magic': 'valid',
  'path-safety': 'safe',
  'payload-completeness': 'complete'
})
const faultValues = Object.freeze({
  availability: 'missing',
  'byte-state': 'empty',
  'declaration-consistency': 'mismatch',
  'dimensions-admission': 'rejected-oversized',
  'format-support': 'unsupported',
  'header-magic': 'corrupt',
  'path-safety': 'unsafe',
  'payload-completeness': 'truncated'
})

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function contentDigest(document) {
  const copy = structuredClone(document)
  delete copy.contentDigest
  return sha256(stableStringify(copy))
}

function sealed(document) {
  const result = structuredClone(document)
  result.contentDigest = contentDigest(result)
  return result
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function readPngChunks(bytes, { requireComplete = true } = {}) {
  if (!Buffer.isBuffer(bytes)) throw new Error('media bytes must be a Buffer')
  if (bytes.length < pngSignature.length || !bytes.subarray(0, 8).equals(pngSignature)) {
    throw new Error('PNG signature is invalid')
  }
  const chunks = []
  let offset = 8
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('PNG chunk framing is truncated')
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) throw new Error('PNG chunk payload is truncated')
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length)
    const actualCrc = crc32(bytes.subarray(offset + 4, offset + 8 + length))
    if (expectedCrc !== actualCrc) throw new Error(`PNG ${type} CRC is invalid`)
    chunks.push({ type, data, offset, length, end })
    offset = end
    if (type === 'IEND') break
  }
  if (offset !== bytes.length) throw new Error('PNG contains trailing bytes after IEND')
  if (chunks[0]?.type !== 'IHDR' || chunks[0].length !== 13) throw new Error('PNG IHDR is missing or invalid')
  if (requireComplete && chunks.at(-1)?.type !== 'IEND') throw new Error('PNG terminal IEND is missing')
  return chunks
}

export function inspectVerifiedPng(bytes) {
  const chunks = readPngChunks(bytes)
  const ihdr = chunks[0].data
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  if (width < 1 || height < 1) throw new Error('PNG dimensions must be positive')
  return Object.freeze({
    format: 'png',
    mime: 'image/png',
    extension: '.png',
    width,
    height,
    byteDigest: sha256(bytes),
    byteLength: bytes.length,
    hasCompletePayload: true
  })
}

export function loadMediaNegativeCorpusPlan(file = mediaNegativeCorpusPlanFile) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function validateMediaNegativeCorpusPlan(plan = loadMediaNegativeCorpusPlan(), schema = JSON.parse(fs.readFileSync(mediaNegativeCorpusSchemaFile, 'utf8'))) {
  const errors = []
  if (schema.$id !== 'fsusblog.media-negative-corpus-plan.v1' || schema.additionalProperties !== false) {
    errors.push('media negative corpus schema must be closed and versioned')
  }
  if (plan.schema !== 'fsusblog.media-negative-corpus-plan.v1') errors.push('media negative corpus plan schema identity is invalid')
  if (plan.owner !== 'media-negative-corpus') errors.push('media negative corpus plan owner is invalid')
  if (JSON.stringify(plan.executionClasses) !== JSON.stringify(['diagnostic-only', 'negative-invalid'])) {
    errors.push('media negative corpus execution classes must be exactly diagnostic-only and negative-invalid')
  }
  const authority = plan.positiveAuthority ?? {}
  if (authority.requiredReceiptSchema !== 'fsusblog.media-positive-asset-receipt.v1'
    || authority.requiredValidityClass !== 'canonical-positive'
    || authority.requiredVerificationStatus !== 'verified'
    || authority.materializationOwner !== 'canonical-media-positive-generator') {
    errors.push('media negative corpus must consume the canonical verified positive authority')
  }
  const limits = plan.resourceLimits ?? {}
  for (const key of ['maximumEncodedBytes', 'maximumPixelWidth', 'maximumPixelHeight', 'maximumPixelCount']) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) errors.push(`resource limit ${key} must be a positive integer`)
  }
  if (limits.maximumAttempts !== 1) errors.push('media negative corpus maximumAttempts must remain one')
  const cases = Array.isArray(plan.cases) ? plan.cases : []
  const ids = cases.map((item) => item.id)
  if (JSON.stringify(ids) !== JSON.stringify(MEDIA_NEGATIVE_CASE_IDS)) {
    errors.push(`media negative corpus cases must exactly match ${MEDIA_NEGATIVE_CASE_IDS.join(', ')}`)
  }
  const mutationIds = cases.map((item) => item.mutationId)
  const reasons = cases.map((item) => item.reasonCode)
  const conditions = cases.map((item) => item.faultCondition)
  for (const [label, values] of Object.entries({ mutationIds, reasons, conditions })) {
    if (new Set(values).size !== values.length) errors.push(`media negative corpus ${label} must be unique`)
  }
  for (const item of cases) {
    if (!stableIdPattern.test(item.id ?? '') || !stableIdPattern.test(item.mutationId ?? '')) errors.push('media negative corpus case IDs must be stable')
    if (!(item.faultCondition in faultValues)) errors.push(`case ${item.id} has unknown fault condition`)
    if (!/^media\.[a-z]+(?:\.[a-z]+)*$/u.test(item.reasonCode ?? '')) errors.push(`case ${item.id} has invalid reason code`)
    if (!Number.isInteger(item.httpStatus) || item.httpStatus < 400 || item.httpStatus > 499) errors.push(`case ${item.id} has invalid HTTP status`)
    if (item.storeStatus !== 'not-created' || item.retryPolicy !== 'none' || item.fallbackPolicy !== 'fixture-only-reject' || item.layoutPlaceholderAllowed !== false) {
      errors.push(`case ${item.id} must remain fail-closed without retry or positive materialization`)
    }
  }
  return errors
}

function verifyPositiveReceipt(receipt, bytes, plan) {
  if (receipt?.schema !== plan.positiveAuthority.requiredReceiptSchema
    || receipt.validityClass !== plan.positiveAuthority.requiredValidityClass
    || receipt.verificationStatus !== plan.positiveAuthority.requiredVerificationStatus
    || receipt.materializationOwner !== plan.positiveAuthority.materializationOwner) {
    throw new Error('positive media receipt is not from the required verified canonical authority')
  }
  if (!canonicalAssetIdPattern.test(receipt.assetId ?? '') || !stableIdPattern.test(receipt.shapeId ?? '')) {
    throw new Error('positive media receipt has invalid canonical AssetId or stable shape identity')
  }
  if (!digestPattern.test(receipt.contentDigest ?? '') || receipt.contentDigest !== contentDigest(receipt)) {
    throw new Error('positive media receipt content digest is invalid')
  }
  if (!digestPattern.test(receipt.decodedDigest ?? '')) throw new Error('positive media receipt decoded digest is invalid')
  const observed = inspectVerifiedPng(bytes)
  const declared = {
    format: receipt.format,
    mime: receipt.mime,
    extension: receipt.extension,
    width: receipt.dimensions?.width,
    height: receipt.dimensions?.height,
    byteDigest: receipt.byteDigest,
    byteLength: receipt.byteLength
  }
  for (const key of Object.keys(observed)) {
    if (key === 'hasCompletePayload') continue
    if (declared[key] !== observed[key]) throw new Error(`positive media receipt ${key} does not match verified bytes`)
  }
  if (bytes.length > plan.resourceLimits.maximumEncodedBytes) throw new Error('positive media bytes exceed the corpus encoded-byte budget')
  if (observed.width > plan.resourceLimits.maximumPixelWidth
    || observed.height > plan.resourceLimits.maximumPixelHeight
    || observed.width * observed.height > plan.resourceLimits.maximumPixelCount) {
    throw new Error('positive media dimensions exceed the corpus admission budget')
  }
  return observed
}

function directorySnapshot(directory) {
  const base = fs.realpathSync(directory)
  const entries = []
  function visit(current, relative) {
    const names = fs.readdirSync(current).sort()
    for (const name of names) {
      const absolute = path.join(current, name)
      const nextRelative = path.posix.join(relative, name)
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new Error(`positive media root contains a symlink: ${nextRelative}`)
      if (stat.isDirectory()) visit(absolute, nextRelative)
      else if (stat.isFile()) entries.push({ path: nextRelative, size: stat.size, digest: sha256(fs.readFileSync(absolute)) })
      else throw new Error(`positive media root contains unsupported entry: ${nextRelative}`)
    }
  }
  visit(base, '')
  return sha256(stableStringify(entries))
}

function prepareRoots(positiveRoot, corpusRoot) {
  const positive = fs.realpathSync(positiveRoot)
  const corpusParent = fs.realpathSync(path.dirname(corpusRoot))
  const corpus = path.resolve(corpusRoot)
  if (path.dirname(corpus) !== corpusParent) throw new Error('negative corpus root parent contains a symlink or alias')
  if (corpus === positive || corpus.startsWith(`${positive}${path.sep}`) || positive.startsWith(`${corpus}${path.sep}`)) {
    throw new Error('negative corpus root must be physically isolated from the positive root')
  }
  if (fs.existsSync(corpus)) throw new Error('negative corpus root must be a fresh run-owned directory')
  fs.mkdirSync(corpus, { mode: 0o700 })
  return { positive, corpus }
}

function replacePngWidth(bytes, width) {
  const chunks = readPngChunks(bytes)
  const ihdr = chunks[0]
  const result = Buffer.from(bytes)
  result.writeUInt32BE(width, ihdr.offset + 8)
  const crcStart = ihdr.offset + 4
  const crcEnd = ihdr.offset + 8 + ihdr.length
  result.writeUInt32BE(crc32(result.subarray(crcStart, crcEnd)), crcEnd)
  return result
}

function mutate(caseId, sourceBytes, sourceFacts, plan) {
  switch (caseId) {
    case 'corrupt-header': {
      const bytes = Buffer.from(sourceBytes)
      bytes[0] ^= 0xff
      return { bytes, declaredFacts: sourceFacts }
    }
    case 'mime-extension-mismatch':
      return { bytes: Buffer.from(sourceBytes), declaredFacts: { ...sourceFacts, mime: 'image/jpeg' } }
    case 'missing-404':
      return { bytes: null, declaredFacts: sourceFacts }
    case 'oversized-dimensions': {
      const width = plan.resourceLimits.maximumPixelWidth + 1
      return {
        bytes: replacePngWidth(sourceBytes, width),
        declaredFacts: { ...sourceFacts, width }
      }
    }
    case 'truncated':
      return { bytes: Buffer.from(sourceBytes.subarray(0, sourceBytes.length - 12)), declaredFacts: sourceFacts }
    case 'unsafe-path':
      return { bytes: Buffer.from(sourceBytes), declaredFacts: sourceFacts, unsafeLogicalPath: true }
    case 'unsupported-format':
      return { bytes: Buffer.from(unsupportedBytes), declaredFacts: { ...sourceFacts, format: 'unsupported-safe-synthetic', mime: 'application/octet-stream', extension: '.bin' } }
    case 'zero-byte':
      return { bytes: Buffer.alloc(0), declaredFacts: sourceFacts }
    default:
      throw new Error(`unknown media negative case ${caseId}`)
  }
}

function conditionsFor(faultCondition) {
  return Object.fromEntries(Object.entries(conditionDefaults).map(([key, value]) => [key, key === faultCondition ? faultValues[key] : value]))
}

function inspectNegative(casePlan, mutation, sourceBytes, sourceFacts, plan) {
  const expected = {
    reasonCode: casePlan.reasonCode,
    httpStatus: casePlan.httpStatus,
    decodeStatus: casePlan.decodeStatus,
    storeStatus: casePlan.storeStatus,
    materializationStatus: casePlan.materializationStatus,
    fallbackPolicy: casePlan.fallbackPolicy,
    retryPolicy: casePlan.retryPolicy,
    layoutPlaceholderAllowed: casePlan.layoutPlaceholderAllowed
  }
  let reasonCode
  if (casePlan.id === 'missing-404' && mutation.bytes === null) reasonCode = 'media.missing'
  else if (casePlan.id === 'unsafe-path' && mutation.unsafeLogicalPath === true) reasonCode = 'media.path.unsafe'
  else if (mutation.bytes?.length === 0) reasonCode = 'media.bytes.empty'
  else if (casePlan.id === 'corrupt-header' && !mutation.bytes.subarray(0, 8).equals(pngSignature)) reasonCode = 'media.header.corrupt'
  else if (casePlan.id === 'unsupported-format' && mutation.bytes.equals(unsupportedBytes)) reasonCode = 'media.format.unsupported'
  else if (casePlan.id === 'mime-extension-mismatch'
    && (mutation.declaredFacts.mime !== sourceFacts.mime || mutation.declaredFacts.extension !== sourceFacts.extension)) reasonCode = 'media.declaration.mismatch'
  else if (casePlan.id === 'oversized-dimensions') {
    const observed = inspectVerifiedPng(mutation.bytes)
    if (observed.width > plan.resourceLimits.maximumPixelWidth
      || observed.height > plan.resourceLimits.maximumPixelHeight
      || observed.width * observed.height > plan.resourceLimits.maximumPixelCount) reasonCode = 'media.dimensions.oversized'
  } else if (casePlan.id === 'truncated') {
    if (mutation.bytes.subarray(0, 8).equals(pngSignature)) {
      try { readPngChunks(mutation.bytes) } catch { reasonCode = 'media.payload.truncated' }
    }
  }
  if (reasonCode !== casePlan.reasonCode) throw new Error(`case ${casePlan.id} did not produce its unique expected reason`)
  return { ...expected, attempts: 1, cleanSuccessAfterRetry: false }
}

function verifySingleFault(casePlan, mutation, sourceBytes, sourceFacts, plan) {
  const changedConditions = Object.entries(conditionsFor(casePlan.faultCondition))
    .filter(([key, value]) => value !== conditionDefaults[key])
    .map(([key]) => key)
  if (JSON.stringify(changedConditions) !== JSON.stringify([casePlan.faultCondition])) {
    throw new Error(`case ${casePlan.id} is not a single-fault mutation`)
  }
  switch (casePlan.id) {
    case 'corrupt-header': {
      if (mutation.bytes.length !== sourceBytes.length) throw new Error('corrupt-header changed byte length')
      const changed = [...mutation.bytes].filter((value, index) => value !== sourceBytes[index]).length
      if (changed !== 1 || mutation.bytes.subarray(1).compare(sourceBytes.subarray(1)) !== 0) throw new Error('corrupt-header changed more than the first signature byte')
      break
    }
    case 'mime-extension-mismatch':
      if (!mutation.bytes.equals(sourceBytes) || mutation.declaredFacts.mime === sourceFacts.mime || mutation.declaredFacts.extension !== sourceFacts.extension) throw new Error('MIME-extension mismatch must only change declared MIME')
      break
    case 'missing-404':
      if (mutation.bytes !== null) throw new Error('missing-404 must not create readable bytes')
      break
    case 'oversized-dimensions': {
      const observed = inspectVerifiedPng(mutation.bytes)
      if (observed.width !== plan.resourceLimits.maximumPixelWidth + 1 || observed.height !== sourceFacts.height) throw new Error('oversized-dimensions changed unrelated dimensions')
      if (mutation.bytes.length !== sourceBytes.length) throw new Error('oversized-dimensions changed encoded size')
      break
    }
    case 'truncated':
      if (!mutation.bytes.subarray(0, 8).equals(pngSignature) || !sourceBytes.subarray(0, mutation.bytes.length).equals(mutation.bytes)) throw new Error('truncated must retain the recognizable source prefix')
      try { readPngChunks(mutation.bytes); throw new Error('truncated unexpectedly remained complete') } catch (error) {
        if (error.message === 'truncated unexpectedly remained complete') throw error
      }
      break
    case 'unsafe-path':
      if (!mutation.bytes.equals(sourceBytes) || mutation.unsafeLogicalPath !== true) throw new Error('unsafe-path must only change the logical path condition')
      break
    case 'unsupported-format':
      if (!mutation.bytes.equals(unsupportedBytes) || mutation.bytes.includes(Buffer.from('<script', 'ascii'))) throw new Error('unsupported format bytes must remain safe and synthetic')
      break
    case 'zero-byte':
      if (mutation.bytes.length !== 0) throw new Error('zero-byte must be exactly empty')
      break
    default:
      throw new Error(`unknown media negative case ${casePlan.id}`)
  }
  return { faultCondition: casePlan.faultCondition, conditions: conditionsFor(casePlan.faultCondition), independentFaultCount: 1 }
}

function caseFileName(caseId) {
  return `${caseId}.negative`
}

function receiptHasUnsafePath(value) {
  if (typeof value === 'string') return path.isAbsolute(value) || value.split(/[\\/]/u).includes('..')
  if (Array.isArray(value)) return value.some(receiptHasUnsafePath)
  return value && typeof value === 'object' && Object.values(value).some(receiptHasUnsafePath)
}

function verifyStoredCaseBytes(casePlan, item, bytes, plan, errors) {
  try {
    switch (casePlan.id) {
      case 'corrupt-header':
        if (bytes.length !== item.declaredFacts?.byteLength || bytes.length < pngSignature.length || bytes.subarray(0, 8).equals(pngSignature)) errors.push('corrupt-header is not an isolated header fault')
        break
      case 'mime-extension-mismatch': {
        const observed = inspectVerifiedPng(bytes)
        if (observed.byteDigest !== item.sourcePositiveByteDigest
          || item.declaredFacts?.mime === observed.mime
          || item.declaredFacts?.extension !== observed.extension) errors.push('mime-extension-mismatch changed bytes or more than one declaration dimension')
        break
      }
      case 'oversized-dimensions': {
        const observed = inspectVerifiedPng(bytes)
        if (observed.width !== plan.resourceLimits.maximumPixelWidth + 1
          || observed.height !== item.declaredFacts?.height
          || bytes.length !== item.declaredFacts?.byteLength) errors.push('oversized-dimensions is not a metadata-only bounded mutation')
        break
      }
      case 'truncated':
        if (bytes.length === 0 || bytes.length >= item.declaredFacts?.byteLength || !bytes.subarray(0, 8).equals(pngSignature)) errors.push('truncated does not retain a recognizable incomplete source prefix')
        try {
          readPngChunks(bytes)
          errors.push('truncated unexpectedly contains a complete PNG')
        } catch {}
        break
      case 'unsupported-format':
        if (!bytes.equals(unsupportedBytes)) errors.push('unsupported-format is not the safe minimal synthetic payload')
        break
      case 'zero-byte':
        if (bytes.length !== 0) errors.push('zero-byte case is not empty')
        break
      default:
        break
    }
  } catch (error) {
    errors.push(`case ${casePlan.id} failed independent byte verification: ${error.message}`)
  }
}

export function scanMediaNegativeCorpusGovernance({ repositoryRoot = root, additionalSources = [] } = {}) {
  const errors = []
  const authorities = fs.readdirSync(path.join(repositoryRoot, 'config/testing'))
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      try {
        const file = path.join(repositoryRoot, 'config/testing', name)
        const document = JSON.parse(fs.readFileSync(file, 'utf8'))
        return document.owner === 'media-negative-corpus' ? [name] : []
      } catch { return [] }
    })
  if (JSON.stringify(authorities) !== JSON.stringify(['media-negative-corpus-plan.json'])) {
    errors.push(`media negative corpus must have one plan authority, found ${authorities.join(', ') || 'none'}`)
  }
  const sources = [
    ['tools/test-fixtures/media-negative-corpus.mjs', fs.readFileSync(path.join(repositoryRoot, 'tools/test-fixtures/media-negative-corpus.mjs'), 'utf8')],
    ...additionalSources
  ]
  for (const [name, source] of sources) {
    if (/Buffer\.alloc\([^\n)]*(?:width|height|pixel)/u.test(source)) errors.push(`${name} allocates a bitmap from untrusted dimensions`)
    if (/fs\.(?:readFileSync|writeFileSync|rmSync)\([^\n]*(?:unsafeLogicalPath|\.\.[/\\])/u.test(source)) errors.push(`${name} performs filesystem I/O with an unsafe path`)
    if (/(?:while|for)\s*\([^\n]*(?:retry|attempt)/iu.test(source)) errors.push(`${name} implements retry recovery in the negative runner`)
    if (/validityClass\s*[:=]\s*['"]canonical-positive['"][^\n]*(?:negative|corrupt|unsafe)/iu.test(source)) errors.push(`${name} places negative media in a canonical positive record`)
  }
  return errors
}

export function materializeMediaNegativeCorpus({
  positiveBytes,
  positiveReceipt,
  positiveRoot,
  corpusRoot,
  executionClass = 'negative-invalid',
  plan = loadMediaNegativeCorpusPlan()
}) {
  const planErrors = validateMediaNegativeCorpusPlan(plan)
  if (planErrors.length) throw new Error(planErrors.join('\n'))
  if (!plan.executionClasses.includes(executionClass)) throw new Error(`execution class ${executionClass} cannot consume the media negative corpus`)
  if (!Buffer.isBuffer(positiveBytes)) throw new Error('positiveBytes must be a Buffer')
  const sourceFacts = verifyPositiveReceipt(positiveReceipt, positiveBytes, plan)
  const roots = prepareRoots(positiveRoot, corpusRoot)
  const positiveBeforeDigest = directorySnapshot(roots.positive)
  const caseReceipts = []
  try {
    for (const casePlan of plan.cases) {
      const mutation = mutate(casePlan.id, positiveBytes, sourceFacts, plan)
      const singleFault = verifySingleFault(casePlan, mutation, positiveBytes, sourceFacts, plan)
      const actual = inspectNegative(casePlan, mutation, positiveBytes, sourceFacts, plan)
      let objectStatus = 'not-created'
      if (mutation.bytes !== null && !mutation.unsafeLogicalPath) {
        const file = path.join(roots.corpus, caseFileName(casePlan.id))
        fs.writeFileSync(file, mutation.bytes, { mode: 0o600, flag: 'wx' })
        objectStatus = 'isolated-negative-object'
      }
      const caseReceipt = sealed({
        schema: 'fsusblog.media-negative-case-receipt.v1',
        caseId: casePlan.id,
        mutationId: casePlan.mutationId,
        validityClass: 'negative-invalid',
        executionClass,
        sourcePositiveDigest: positiveReceipt.contentDigest,
        sourceAssetId: positiveReceipt.assetId,
        sourcePositiveByteDigest: sourceFacts.byteDigest,
        negativeByteDigest: mutation.bytes === null ? null : sha256(mutation.bytes),
        negativeByteLength: mutation.bytes === null ? null : mutation.bytes.length,
        declaredFacts: mutation.declaredFacts,
        singleFault,
        expected: {
          reasonCode: casePlan.reasonCode,
          httpStatus: casePlan.httpStatus,
          decodeStatus: casePlan.decodeStatus,
          storeStatus: casePlan.storeStatus,
          materializationStatus: casePlan.materializationStatus,
          fallbackPolicy: casePlan.fallbackPolicy,
          retryPolicy: casePlan.retryPolicy,
          layoutPlaceholderAllowed: casePlan.layoutPlaceholderAllowed
        },
        actual,
        isolation: {
          objectStatus,
          positiveAssetIdCreated: false,
          publicIndexEntryCreated: false,
          positiveProfileEntryCreated: false,
          scaleAssetEntryCreated: false,
          aotSuccessEntryCreated: false,
          normalImageLibraryEntryCreated: false,
          unsafePathRecorded: false
        }
      })
      caseReceipts.push(caseReceipt)
    }
    const positiveAfterDigest = directorySnapshot(roots.positive)
    if (positiveAfterDigest !== positiveBeforeDigest) throw new Error('positive media root changed while generating the negative corpus')
    const receipt = sealed({
      schema: 'fsusblog.media-negative-corpus-receipt.v1',
      planDigest: sha256(stableStringify(plan)),
      executionClass,
      sourcePositiveDigest: positiveReceipt.contentDigest,
      sourceAssetId: positiveReceipt.assetId,
      sourcePositiveByteDigest: sourceFacts.byteDigest,
      positiveRootBeforeDigest: positiveBeforeDigest,
      positiveRootAfterDigest: positiveAfterDigest,
      resourceSafety: {
        maximumEncodedBytes: plan.resourceLimits.maximumEncodedBytes,
        maximumPixelWidth: plan.resourceLimits.maximumPixelWidth,
        maximumPixelHeight: plan.resourceLimits.maximumPixelHeight,
        maximumPixelCount: plan.resourceLimits.maximumPixelCount,
        actualHugeBitmapAllocated: false,
        rootEscapeAttempted: false
      },
      cases: caseReceipts
    })
    if (receiptHasUnsafePath(receipt)) throw new Error('media negative receipt must not contain absolute or unsafe paths')
    fs.writeFileSync(path.join(roots.corpus, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    return receipt
  } catch (error) {
    fs.rmSync(roots.corpus, { recursive: true, force: true })
    throw error
  }
}

export function verifyMediaNegativeCorpusReceipt({ receipt, corpusRoot, plan = loadMediaNegativeCorpusPlan() }) {
  const errors = [...validateMediaNegativeCorpusPlan(plan)]
  if (receipt?.schema !== 'fsusblog.media-negative-corpus-receipt.v1') errors.push('media negative corpus receipt schema is invalid')
  if (!digestPattern.test(receipt?.contentDigest ?? '') || receipt.contentDigest !== contentDigest(receipt)) errors.push('media negative corpus receipt content digest is invalid')
  if (receipt?.planDigest !== sha256(stableStringify(plan))) errors.push('media negative corpus receipt plan digest is stale')
  if (!plan.executionClasses.includes(receipt?.executionClass)) errors.push('media negative corpus receipt execution class is invalid')
  if (!canonicalAssetIdPattern.test(receipt?.sourceAssetId ?? '')) errors.push('media negative corpus receipt source AssetId is invalid')
  if (receiptHasUnsafePath(receipt)) errors.push('media negative corpus receipt exposes an absolute or unsafe path')
  if (receipt?.positiveRootBeforeDigest !== receipt?.positiveRootAfterDigest) errors.push('positive media root changed during negative generation')
  if (receipt?.resourceSafety?.actualHugeBitmapAllocated !== false || receipt?.resourceSafety?.rootEscapeAttempted !== false) errors.push('media negative corpus resource safety proof is invalid')
  const cases = Array.isArray(receipt?.cases) ? receipt.cases : []
  if (JSON.stringify(cases.map((item) => item.caseId)) !== JSON.stringify(MEDIA_NEGATIVE_CASE_IDS)) errors.push('media negative corpus receipt case inventory is incomplete or reordered')
  for (const casePlan of plan.cases) {
    const item = cases.find((candidate) => candidate.caseId === casePlan.id)
    if (!item) continue
    if (!digestPattern.test(item.contentDigest ?? '') || item.contentDigest !== contentDigest(item)) errors.push(`case ${casePlan.id} content digest is invalid`)
    if (item.sourcePositiveDigest !== receipt.sourcePositiveDigest || item.sourcePositiveByteDigest !== receipt.sourcePositiveByteDigest || item.sourceAssetId !== receipt.sourceAssetId) errors.push(`case ${casePlan.id} positive source binding is invalid`)
    if (item.singleFault?.faultCondition !== casePlan.faultCondition || item.singleFault?.independentFaultCount !== 1) errors.push(`case ${casePlan.id} is not single-fault evidence`)
    const changed = Object.entries(item.singleFault?.conditions ?? {}).filter(([key, value]) => value !== conditionDefaults[key]).map(([key]) => key)
    if (JSON.stringify(changed) !== JSON.stringify([casePlan.faultCondition])) errors.push(`case ${casePlan.id} condition projection has multiple faults`)
    if (stableStringify(item.expected) !== stableStringify({
      reasonCode: casePlan.reasonCode,
      httpStatus: casePlan.httpStatus,
      decodeStatus: casePlan.decodeStatus,
      storeStatus: casePlan.storeStatus,
      materializationStatus: casePlan.materializationStatus,
      fallbackPolicy: casePlan.fallbackPolicy,
      retryPolicy: casePlan.retryPolicy,
      layoutPlaceholderAllowed: casePlan.layoutPlaceholderAllowed
    })) errors.push(`case ${casePlan.id} expected result drifted from the closed plan`)
    if (item.actual?.reasonCode !== casePlan.reasonCode || item.actual?.attempts !== 1 || item.actual?.cleanSuccessAfterRetry !== false || item.actual?.retryPolicy !== 'none') errors.push(`case ${casePlan.id} reason or retry evidence is invalid`)
    for (const key of ['positiveAssetIdCreated', 'publicIndexEntryCreated', 'positiveProfileEntryCreated', 'scaleAssetEntryCreated', 'aotSuccessEntryCreated', 'normalImageLibraryEntryCreated', 'unsafePathRecorded']) {
      if (item.isolation?.[key] !== false) errors.push(`case ${casePlan.id} contaminated ${key}`)
    }
    const shouldExist = !['missing-404', 'unsafe-path'].includes(casePlan.id)
    const file = path.join(corpusRoot, caseFileName(casePlan.id))
    if (shouldExist !== fs.existsSync(file)) errors.push(`case ${casePlan.id} isolated object presence is invalid`)
    if (shouldExist) {
      const bytes = fs.readFileSync(file)
      if (sha256(bytes) !== item.negativeByteDigest || bytes.length !== item.negativeByteLength) errors.push(`case ${casePlan.id} negative bytes were tampered`)
      verifyStoredCaseBytes(casePlan, item, bytes, plan, errors)
    }
  }
  return errors
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = [...validateMediaNegativeCorpusPlan(), ...scanMediaNegativeCorpusGovernance()]
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('media negative corpus plan is valid\n')
  }
}
