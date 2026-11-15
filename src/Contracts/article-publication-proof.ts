import type { Article } from './public-articles.ts'
import { managedArticleCoverDigest } from './published-media.ts'

const keysPath = '/integrity/v2/keys.json'
const algorithm = 'ECDSA_P256_SHA256'
const encoder = new TextEncoder()
const lowerHex = /^[a-f0-9]{64}$/
const decimal = /^[1-9][0-9]{0,18}$/
const keyId = /^[A-Za-z0-9_.-]{1,128}$/
const exactTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

export class PublicationProofError extends Error {
  readonly reason: 'unavailable' | 'invalid'

  constructor(reason: 'unavailable' | 'invalid') {
    super(reason)
    this.reason = reason
  }
}

function check(value: unknown): asserts value {
  if (!value) throw new PublicationProofError('invalid')
}

function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && keyId.test(value)
}

function validHex(value: unknown): value is string {
  return typeof value === 'string' && lowerHex.test(value)
}

function milliseconds(value: string): string {
  return value.slice(0, 23) + 'Z'
}

function time(value: unknown): value is string {
  if (typeof value !== 'string' || !exactTime.test(value) || value.startsWith('0000')) return false
  const millis = milliseconds(value)
  const date = new Date(millis)
  return Number.isFinite(date.getTime()) && date.toISOString() === millis
}

function base64(bytes: Uint8Array): string {
  let source = ''
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    source += String.fromCharCode(...bytes.subarray(offset, offset + 16_384))
  }
  return btoa(source)
}

function fromBase64Url(value: unknown, bytes: number): Uint8Array<ArrayBuffer> {
  check(typeof value === 'string' && value.length === Math.ceil(bytes * 8 / 6) && /^[A-Za-z0-9_-]+$/.test(value))
  const decoded = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0))
  check(decoded.length === bytes &&
    base64(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === value)
  return decoded
}

function payload(...lines: string[]): Uint8Array<ArrayBuffer> {
  return encoder.encode(lines.join('\n') + '\n')
}

function stringLine(field: string, value: string): string {
  return `${field}:s:${base64(encoder.encode(value))}`
}

function intLine(field: string, value: number | bigint | string): string {
  return `${field}:i:${value}`
}

function boolLine(field: string, value: boolean): string {
  return `${field}:b:${value ? 1 : 0}`
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function articlePublicationDigests(article: Article, expectedVersion?: 2 | 3): Promise<{ content: string; policy: string }> {
  const rights = article.rights
  check(rights)
  const cover = managedArticleCoverDigest(article)
  check(article.coverImageUrl === '' || validHex(cover))
  const version = cover === undefined ? 2 : 3
  check(expectedVersion === undefined || expectedVersion === version)
  const tagIds = [...new Set(article.tags.map(tag => tag.id))].sort((a, b) => a - b)
  const content = await sha256(payload(
    `fsusblog.integrity.article-content.v${version}`, intLine('version', version),
    intLine('articleId', article.id), intLine('revision', article.revision),
    stringLine('title', article.title), stringLine('markdown', article.body),
    article.category.id === 0 ? 'categoryId:n' : intLine('categoryId', article.category.id),
    intLine('tagIds', tagIds.join(',')),
    ...(cover === undefined ? [] : [`coverMediaSha256:h:${cover}`]),
  ))
  const policy = await sha256(payload(
    'fsusblog.integrity.article-policy.v2', 'version:i:2',
    intLine('articleId', article.id), intLine('revision', article.revision), boolLine('enabled', rights.enabled),
    stringLine('licenseType', rights.licenseType), stringLine('copyrightHolder', rights.copyrightHolder),
    intLine('copyrightYear', rights.copyrightYear ?? 0), stringLine('rightsStatement', rights.rightsStatement),
    stringLine('attributionTemplate', rights.attributionTemplate), stringLine('copyPolicy', rights.copyPolicy),
    intLine('maxExcerptChars', rights.maxExcerptChars), boolLine('allowCodeCopy', rights.allowCodeCopy),
    boolLine('showPublicBadge', rights.showPublicBadge), boolLine('proofBindingEnabled', rights.proofBindingEnabled),
    `contentSha256:h:${content}`,
  ))
  return { content, policy }
}

export function publicationProofPath(article: Article): string {
  return `/integrity/v2/article/${article.id}/${article.publication}/rights.json`
}

async function readJson(path: string, maxBytes: number, signal: AbortSignal): Promise<string> {
  let response: Response
  try {
    response = await fetch(path, {
      cache: 'no-store', credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' }, signal,
    })
  } catch {
    throw new PublicationProofError('unavailable')
  }
  if (!response.ok) throw new PublicationProofError('unavailable')
  const cache = response.headers.get('cache-control')?.toLowerCase().split(',').map(value => value.trim())
  const age = response.headers.get('age')
  if (!cache?.includes('no-store') || (age !== null && age !== '0')) throw new PublicationProofError('unavailable')
  check(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json' && response.body)
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let json = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      check(size <= maxBytes)
      json += decoder.decode(value, { stream: true })
    }
    return json + decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof PublicationProofError) throw error
    throw new PublicationProofError('unavailable')
  } finally {
    reader.releaseLock()
  }
}

function jsonRecord(json: string): Record<string, unknown> {
  try {
    return record(JSON.parse(json))
  } catch {
    throw new PublicationProofError('invalid')
  }
}

function locateKey(manifest: Record<string, unknown>, id: string): Record<string, unknown> {
  check(manifest.manifestVersion === 2 && manifest.kind === 'native-publication-proof-keys' &&
    manifest.algorithm === algorithm && validId(manifest.currentKeyId) && Array.isArray(manifest.keys) && manifest.keys.length <= 64)
  const keys = new Map<string, Record<string, unknown>>()
  for (const value of manifest.keys) {
    const key = record(value)
    check(validId(key.keyId) && !keys.has(key.keyId))
    keys.set(key.keyId, key)
  }
  const key = keys.get(id)
  check(key && keys.has(manifest.currentKeyId))
  return key
}

export async function verifyCurrentPublication(article: Article, origin: string, signal: AbortSignal): Promise<void> {
  const rights = article.rights
  if (!origin.startsWith('https://') || !globalThis.crypto?.subtle || !rights?.enabled || !rights.proofBindingEnabled) {
    throw new PublicationProofError('unavailable')
  }
  const path = publicationProofPath(article)
  const first = await readJson(path, 4_096, signal)
  const proof = jsonRecord(first)
  check(proof.proofVersion === 2 && (proof.canonicalVersion === 2 || proof.canonicalVersion === 3) &&
    proof.algorithm === algorithm && proof.origin === origin &&
    proof.articleId === article.id && proof.revision === String(article.revision) &&
    proof.publicationId === String(article.publication) && proof.publicationNo === article.publicationNo &&
    proof.rightsSnapshotId === String(rights.snapshotId) && typeof proof.publicationOutboxId === 'string' &&
    decimal.test(proof.publicationOutboxId) && BigInt(proof.publicationOutboxId) <= 9_223_372_036_854_775_807n &&
    time(proof.publishedAtUtc) && time(proof.issuedAtUtc) && proof.issuedAtUtc >= proof.publishedAtUtc &&
    Date.parse(milliseconds(proof.publishedAtUtc)) === article.publishedAt && validId(proof.keyId) && positive(proof.keyVersion) &&
    validHex(proof.contentSha256) && validHex(proof.policySha256) && validHex(proof.keySha256))
  const { content, policy } = await articlePublicationDigests(article, proof.canonicalVersion)
  check(content === proof.contentSha256 && policy === proof.policySha256)

  const key = locateKey(jsonRecord(await readJson(keysPath, 131_072, signal)), proof.keyId)
  check(key.keyVersion === proof.keyVersion && key.keySha256 === proof.keySha256 &&
    time(key.notBeforeUtc) && time(key.notAfterUtc) && proof.issuedAtUtc >= key.notBeforeUtc &&
    proof.issuedAtUtc <= key.notAfterUtc && key.compromisedAtUtc === null &&
    (key.revokedAtUtc === null || (time(key.revokedAtUtc) && proof.issuedAtUtc < key.revokedAtUtc)))
  // DER SPKI with an uncompressed point and the named prime256v1 parameters.
  const spki = fromBase64Url(key.publicKey, 91)
  check(await sha256(spki) === proof.keySha256)
  const transcript = payload(
    'fsusblog.integrity.native-publication-rights-proof.v2', 'proofVersion:i:2', intLine('canonicalVersion', proof.canonicalVersion),
    stringLine('algorithm', algorithm), stringLine('origin', origin),
    intLine('articleId', article.id), intLine('revision', article.revision),
    intLine('publicationId', article.publication), intLine('publicationNo', article.publicationNo),
    `publishedAt:t:${proof.publishedAtUtc}`, intLine('rightsSnapshotId', rights.snapshotId),
    intLine('outboxId', proof.publicationOutboxId), `contentSha256:h:${content}`, `policySha256:h:${policy}`,
    stringLine('keyId', proof.keyId), intLine('keyVersion', proof.keyVersion), `keySha256:h:${proof.keySha256}`,
    `issuedAt:t:${proof.issuedAtUtc}`,
  )
  const signature = fromBase64Url(proof.signature, 64)
  try {
    const publicKey = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    check(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, transcript))
  } catch {
    throw new PublicationProofError('invalid')
  }

  // Check current publication and key eligibility again after the local work.
  check(await readJson(path, 4_096, signal) === first)
}
