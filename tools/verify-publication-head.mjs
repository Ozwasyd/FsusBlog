import { algorithm, string, field, decimal, positiveInt, digest, utc, readJson, verifyNativeSignature } from './verify-publication-proof.mjs'

const fields = [
  'headVersion', 'kind', 'algorithm', 'origin', 'sequence', 'entrySha256',
  'keyId', 'keyVersion', 'keySha256', 'attestedAtUtc', 'signature',
]

export function verifyPublicationHead(head, manifest, origin) {
  if (!head || typeof head !== 'object' || Object.keys(head).length !== fields.length ||
      !fields.every(name => Object.hasOwn(head, name)) ||
      new URL(origin).origin !== origin || !origin.startsWith('https://') || origin.length > 256 ||
      head.headVersion !== 2 || head.kind !== 'native-publication-log-head' || head.algorithm !== algorithm ||
      head.origin !== origin || !decimal(head.sequence) || !digest(head.entrySha256) || !digest(head.keySha256) ||
      !positiveInt(head.keyVersion) || typeof head.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(head.keyId) ||
      !utc(head.attestedAtUtc)) throw new Error('Invalid native publication log head')
  const transcript = Buffer.from([
    'fsusblog.integrity.native-publication-log-head.v2', 'headVersion:i:2',
    string('algorithm', algorithm), string('origin', origin), field('sequence', 'i', head.sequence),
    field('entrySha256', 'h', head.entrySha256), string('keyId', head.keyId), field('keyVersion', 'i', head.keyVersion),
    field('keySha256', 'h', head.keySha256), field('attestedAt', 't', head.attestedAtUtc), '',
  ].join('\n'), 'utf8')
  verifyNativeSignature(head, manifest, head.attestedAtUtc, transcript)
  return { sequence: head.sequence, entrySha256: head.entrySha256 }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 5) throw new Error('Usage: verify-publication-head.mjs HTTPS_ORIGIN KEYS_JSON HEAD_JSON')
    console.log(JSON.stringify(verifyPublicationHead(readJson(process.argv[4]), readJson(process.argv[3]), process.argv[2])))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
