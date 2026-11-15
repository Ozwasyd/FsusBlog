import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'

const algorithm = 'ECDSA_P256_SHA256'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const string = (name, value) => `${name}:s:${Buffer.from(value, 'utf8').toString('base64')}`
const field = (name, type, value) => `${name}:${type}:${value}`
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) &&
  BigInt(value) <= 9223372036854775807n
const positiveInt = value => Number.isInteger(value) && value > 0 && value <= 2147483647
const digest = value => typeof value === 'string' && value.length === 64 && /^[0-9a-f]+$/.test(value)
const utc = value => typeof value === 'string' && value.length === 27 && !value.startsWith('0000') &&
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(value) &&
  new Date(value).toISOString() === `${value.slice(0, 23)}Z`

function base64Url(value, size, exact) {
  if (typeof value !== 'string' || value.length > size * 2 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid Base64URL')
  const bytes = Buffer.from(value, 'base64url')
  if ((exact ? bytes.length !== size : bytes.length > size) || value !== bytes.toString('base64url')) throw new Error('Invalid Base64URL')
  return bytes
}

export function verifyPublicationProof(proof, manifest, expectedOrigin) {
  if (new URL(expectedOrigin).origin !== expectedOrigin || new URL(expectedOrigin).protocol !== 'https:' ||
      proof.origin !== expectedOrigin || proof.proofVersion !== 2 || proof.canonicalVersion !== 2 || proof.algorithm !== algorithm ||
      !positiveInt(proof.articleId) || !positiveInt(proof.publicationNo) || !positiveInt(proof.keyVersion) ||
      ![proof.revision, proof.publicationId, proof.rightsSnapshotId, proof.publicationOutboxId].every(decimal) ||
      ![proof.contentSha256, proof.policySha256, proof.keySha256].every(digest) ||
      typeof proof.keyId !== 'string' || proof.keyId.length < 1 || proof.keyId.length > 128 || /[^a-zA-Z0-9_.-]/.test(proof.keyId) ||
      !utc(proof.publishedAtUtc) || !utc(proof.issuedAtUtc) || proof.issuedAtUtc < proof.publishedAtUtc)
    throw new Error('Invalid native publication proof facts')
  if (manifest.manifestVersion !== 2 || manifest.kind !== 'native-publication-proof-keys' || manifest.algorithm !== algorithm ||
      !Array.isArray(manifest.keys) || manifest.keys.length > 64) throw new Error('Invalid native publication proof keys')
  const selected = manifest.keys.filter(key => key.keyId === proof.keyId)
  if (selected.length !== 1) throw new Error('Native proof key missing or ambiguous')
  const key = selected[0]
  if (key.keyVersion !== proof.keyVersion || key.keySha256 !== proof.keySha256 ||
      !utc(key.notBeforeUtc) || !utc(key.notAfterUtc) || proof.issuedAtUtc < key.notBeforeUtc || proof.issuedAtUtc > key.notAfterUtc ||
      key.compromisedAtUtc !== null || (key.revokedAtUtc !== null && (!utc(key.revokedAtUtc) || proof.issuedAtUtc >= key.revokedAtUtc)))
    throw new Error('Native proof key is ineligible')
  const der = base64Url(key.publicKey, 192, false)
  if (sha256(der) !== key.keySha256) throw new Error('Unexpected native proof key fingerprint')
  const publicKey = createPublicKey({ key: der, type: 'spki', format: 'der' })
  if (publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1' || !publicKey.export({ type: 'spki', format: 'der' }).equals(der))
    throw new Error('Unexpected native proof key curve or encoding')

  const bytes = Buffer.from([
    'fsusblog.integrity.native-publication-rights-proof.v2', 'proofVersion:i:2', 'canonicalVersion:i:2',
    string('algorithm', algorithm), string('origin', expectedOrigin), field('articleId', 'i', proof.articleId),
    field('revision', 'i', proof.revision), field('publicationId', 'i', proof.publicationId),
    field('publicationNo', 'i', proof.publicationNo), field('publishedAt', 't', proof.publishedAtUtc),
    field('rightsSnapshotId', 'i', proof.rightsSnapshotId), field('outboxId', 'i', proof.publicationOutboxId),
    field('contentSha256', 'h', proof.contentSha256), field('policySha256', 'h', proof.policySha256),
    string('keyId', proof.keyId), field('keyVersion', 'i', proof.keyVersion), field('keySha256', 'h', proof.keySha256),
    field('issuedAt', 't', proof.issuedAtUtc), '',
  ].join('\n'), 'utf8')
  if (!verify('sha256', bytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, base64Url(proof.signature, 64, true)))
    throw new Error('Invalid native publication signature')
}

function readJson(path) {
  const bytes = readFileSync(path)
  if (bytes.length > 65536) throw new Error('Proof input exceeds the verification limit')
  return JSON.parse(bytes)
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 5) throw new Error('Usage: verify-publication-proof.mjs HTTPS_ORIGIN KEYS_JSON PROOF_JSON')
    verifyPublicationProof(readJson(process.argv[4]), readJson(process.argv[3]), process.argv[2])
    console.log('Verified native publication rights signature.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
