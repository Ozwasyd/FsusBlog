import { createHash } from 'node:crypto'
import { algorithm, decimal, digest, field, positiveInt, string, utc, verifyNativeSignature } from './verify-publication-proof.mjs'

const signerFields = ['keyId', 'keyVersion', 'keySha256', 'attestedAtUtc', 'signature']

function exact(value, fields) {
  return value && typeof value === 'object' && Object.keys(value).length === fields.length &&
    fields.every(name => Object.hasOwn(value, name))
}

function validSigner(value) {
  return digest(value.keySha256) && positiveInt(value.keyVersion) && typeof value.keyId === 'string' &&
    /^[A-Za-z0-9._-]{1,128}$/.test(value.keyId) && utc(value.attestedAtUtc)
}

function verifyAttestation(value, keys, fields) {
  const transcript = Buffer.from([
    ...fields, string('keyId', value.keyId), field('keyVersion', 'i', value.keyVersion),
    field('keySha256', 'h', value.keySha256), field('attestedAt', 't', value.attestedAtUtc), '',
  ].join('\n'), 'utf8')
  verifyNativeSignature(value, keys, value.attestedAtUtc, transcript)
}

const headFields = ['headVersion', 'kind', 'algorithm', 'origin', 'sequence', 'entrySha256', ...signerFields]

export function verifyPublicationHead(head, manifest, origin) {
  if (!exact(head, headFields) ||
      new URL(origin).origin !== origin || !origin.startsWith('https://') || origin.length > 256 ||
      head.headVersion !== 2 || head.kind !== 'native-publication-log-head' || head.algorithm !== algorithm ||
      head.origin !== origin || !decimal(head.sequence) || !digest(head.entrySha256) || !validSigner(head))
    throw new Error('Invalid native publication log head')
  verifyAttestation(head, manifest, [
    'fsusblog.integrity.native-publication-log-head.v2', 'headVersion:i:2',
    string('algorithm', algorithm), string('origin', origin), field('sequence', 'i', head.sequence),
    field('entrySha256', 'h', head.entrySha256),
  ])
  return { sequence: head.sequence, entrySha256: head.entrySha256 }
}

const checkpointFields = [
  'checkpointVersion', 'kind', 'checkpointKind', 'algorithm', 'origin', 'scopeKey', 'fromSequence', 'toSequence',
  'entryCount', 'rootSha256', 'headSequence', 'headEntrySha256', ...signerFields,
]
const leafDomain = 'fsusblog.integrity.native-publication-checkpoint-leaf.v2\0'
const nodeDomain = 'fsusblog.integrity.native-publication-checkpoint-node.v2\0'
const emptyDailyDomain = 'fsusblog.integrity.native-publication-daily-empty.v2\0'

function hash(domain, ...values) {
  const sha = createHash('sha256').update(domain)
  for (const value of values) sha.update(value)
  return sha.digest()
}

function dayEnd(scope) {
  if (typeof scope !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(scope) || scope === '9999-12-31') return null
  const day = new Date(`${scope}T00:00:00.000Z`)
  if (!Number.isFinite(day.valueOf()) || day.toISOString().slice(0, 10) !== scope) return null
  day.setUTCDate(day.getUTCDate() + 1)
  return day.toISOString().replace('.000Z', '.000000Z')
}

function leaf(sequence, entrySha256) {
  const bytes = Buffer.alloc(8)
  bytes.writeBigInt64BE(sequence)
  return hash(leafDomain, bytes, Buffer.from(entrySha256, 'hex'))
}

function verifyInclusion(proof, checkpoint, expectedEntry) {
  if (proof === null && expectedEntry === undefined) return null
  const daily = checkpoint.checkpointKind === 'daily'
  const fields = daily ? ['sequence', 'position', 'entrySha256', 'siblings'] : ['sequence', 'leafSha256', 'siblings']
  if (checkpoint.entryCount === 0 || !exact(proof, fields) || !decimal(proof.sequence) ||
      !digest(daily ? proof.entrySha256 : proof.leafSha256) ||
      !Array.isArray(proof.siblings) || proof.siblings.length > 12 || !proof.siblings.every(digest))
    throw new Error('Invalid native checkpoint inclusion proof')
  const sequence = BigInt(proof.sequence)
  const from = BigInt(checkpoint.fromSequence)
  const to = BigInt(checkpoint.toSequence)
  if (sequence < from || sequence > to) throw new Error('Checkpoint inclusion is outside its signed range')
  let position = daily ? proof.position : Number(sequence - from)
  if (daily && (!Number.isSafeInteger(position) || position < 0 || position >= checkpoint.entryCount ||
      (position === 0) !== (sequence === from) || (position === checkpoint.entryCount - 1) !== (sequence === to) ||
      sequence - from < BigInt(position) || to - sequence < BigInt(checkpoint.entryCount - 1 - position)))
    throw new Error('Invalid native daily checkpoint inclusion position')
  let current = daily ? leaf(sequence, proof.entrySha256) : Buffer.from(proof.leafSha256, 'hex')
  const isHead = proof.sequence === checkpoint.headSequence
  const expectedDigest = isHead ? checkpoint.headEntrySha256 : daily ? proof.entrySha256 : expectedEntry?.entrySha256
  if (expectedEntry !== undefined &&
      (proof.sequence !== expectedEntry.sequence || !digest(expectedEntry.entrySha256) || expectedEntry.entrySha256 !== expectedDigest))
      throw new Error('Checkpoint inclusion does not identify the expected ledger entry')
  if (expectedDigest !== undefined && !leaf(sequence, expectedDigest).equals(current))
    throw new Error('Checkpoint leaf does not bind the expected ledger digest')
  let width = checkpoint.entryCount
  let level = 0
  while (width > 1) {
    if (level >= proof.siblings.length) throw new Error('Incomplete checkpoint sibling path')
    const sibling = Buffer.from(proof.siblings[level++], 'hex')
    if ((position ^ 1) >= width && !sibling.equals(current)) throw new Error('Invalid checkpoint odd sibling')
    current = position % 2 === 0 ? hash(nodeDomain, current, sibling) : hash(nodeDomain, sibling, current)
    position = Math.floor(position / 2)
    width = Math.ceil(width / 2)
  }
  if (level !== proof.siblings.length || current.toString('hex') !== checkpoint.rootSha256)
    throw new Error('Checkpoint inclusion root mismatch')
  return proof.sequence
}

export function verifyPublicationCheckpoint(bundle, keys, head, origin, scope, expectedEntry, kind = 'release') {
  if (!exact(bundle, ['checkpoint', 'inclusion']) || !exact(bundle.checkpoint, checkpointFields))
    throw new Error('Invalid native checkpoint envelope')
  const value = bundle.checkpoint
  const pin = verifyPublicationHead(head, keys, origin)
  const daily = kind === 'daily'
  if ((kind !== 'release' && !daily) ||
      value.checkpointVersion !== 2 || value.kind !== 'native-publication-checkpoint' || value.checkpointKind !== kind ||
      value.algorithm !== algorithm || value.origin !== origin || typeof value.scopeKey !== 'string' || value.scopeKey !== scope ||
      value.headSequence !== pin.sequence || value.headEntrySha256 !== pin.entrySha256 || !digest(value.rootSha256) ||
      !validSigner(value) || value.attestedAtUtc < head.attestedAtUtc ||
      !Number.isSafeInteger(value.entryCount) || value.entryCount < 0 || value.entryCount > 4096)
    throw new Error(`Invalid native ${kind} checkpoint`)
  const empty = daily && value.entryCount === 0
  const until = daily ? dayEnd(scope) : null
  if (daily ? !until || head.attestedAtUtc < until : !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(scope) || value.entryCount === 0)
    throw new Error(`Invalid native ${kind} checkpoint scope`)
  if (empty ? value.fromSequence !== '0' || value.toSequence !== '0' || value.rootSha256 !== hash(emptyDailyDomain).toString('hex') :
      !decimal(value.fromSequence) || !decimal(value.toSequence))
    throw new Error(`Invalid native ${kind} checkpoint range`)
  const from = BigInt(value.fromSequence), to = BigInt(value.toSequence), headSequence = BigInt(pin.sequence)
  if (daily ? headSequence > 16384n : headSequence - from >= 16384n)
    throw new Error('Native checkpoint exceeds its signed range')
  if (!empty) {
    const span = to - from + 1n
    const count = BigInt(value.entryCount)
    if (from > to || to > headSequence || (daily && count > 1n ? count > span : count !== span))
      throw new Error('Native checkpoint exceeds its signed range')
  }
  verifyAttestation(value, keys, [
    `fsusblog.integrity.native-publication-${kind}-checkpoint.v2`, 'checkpointVersion:i:2', string('kind', kind),
    string('algorithm', algorithm), string('origin', origin), string('scopeKey', value.scopeKey),
    field('fromSequence', 'i', value.fromSequence), field('toSequence', 'i', value.toSequence), field('entryCount', 'i', value.entryCount),
    field('rootSha256', 'h', value.rootSha256), field('headSequence', 'i', pin.sequence), field('headEntrySha256', 'h', pin.entrySha256),
  ])
  const inclusionSequence = verifyInclusion(bundle.inclusion, value, expectedEntry)
  return { scopeKey: scope, fromSequence: value.fromSequence, toSequence: value.toSequence,
    rootSha256: value.rootSha256, headSequence: pin.sequence, inclusionSequence }
}

export function runCli(command) {
  try {
    console.log(JSON.stringify(command(process.argv.slice(2))))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
