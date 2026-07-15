#!/usr/bin/env node

import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  createHash,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto'
import {
  appendFile,
  chmod,
  lstat,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

const MAGIC = Buffer.from('FSUSBLOG-BACKUP-ENVELOPE-V1\n', 'ascii')
const MAX_HEADER_BYTES = 64 * 1024
const AUTH_TAG_BYTES = 16
const CONTENT_KEY_BYTES = 32
const NONCE_BYTES = 12
const MIN_RSA_BITS = 3072

const args = process.argv.slice(2)
const command = args.shift()

function valueOf(name) {
  const index = args.indexOf(name)
  if (index < 0 || index + 1 >= args.length) {
    throw new Error(`missing argument: ${name}`)
  }
  return args[index + 1]
}

async function readRegularFile(path, { privateIdentity = false } = {}) {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('key material must be a regular non-symlink file')
  }
  if (privateIdentity && process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('private identity permissions must be 0600 or stricter')
  }
  return readFile(path)
}

function assertRsaStrength(key) {
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error('backup envelope key must be RSA')
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (bits < MIN_RSA_BITS) {
    throw new Error(`backup envelope RSA key must be at least ${MIN_RSA_BITS} bits`)
  }
  return bits
}

function keyIdFor(key) {
  const publicKey = key.type === 'public' ? key : createPublicKey(key)
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  return `sha256:${createHash('sha256').update(spki).digest('hex')}`
}

async function loadRecipient(path) {
  const encoded = await readRegularFile(path)
  if (encoded.includes(Buffer.from('PRIVATE KEY', 'ascii'))) {
    throw new Error('recipient file must not contain a private key')
  }
  const key = createPublicKey(encoded)
  const bits = assertRsaStrength(key)
  return { key, bits, keyId: keyIdFor(key) }
}

async function loadIdentity(path, passphraseFile) {
  const encoded = await readRegularFile(path, { privateIdentity: true })
  if (!encoded.includes(Buffer.from('PRIVATE KEY', 'ascii'))) {
    throw new Error('identity file must contain a private key')
  }
  let passphrase
  if (passphraseFile) {
    passphrase = (await readRegularFile(passphraseFile, { privateIdentity: true }))
      .toString('utf8')
      .trimEnd()
  }
  const key = createPrivateKey({ key: encoded, passphrase })
  const bits = assertRsaStrength(key)
  return { key, bits, keyId: keyIdFor(key) }
}

function encodeHeader(header) {
  const bytes = Buffer.from(JSON.stringify(header), 'utf8')
  if (bytes.length === 0 || bytes.length > MAX_HEADER_BYTES) {
    throw new Error('invalid envelope header length')
  }
  return bytes
}

async function createExclusiveFile(path) {
  const handle = await open(path, 'wx', 0o600)
  await handle.close()
  await chmod(path, 0o600)
}

async function requireOutputAbsent(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return
    throw error
  }
  throw new Error('output file already exists')
}

async function encrypt() {
  const input = valueOf('--input')
  const output = valueOf('--output')
  const recipientPath = valueOf('--recipient')
  await requireOutputAbsent(output)
  const recipient = await loadRecipient(recipientPath)
  const contentKey = randomBytes(CONTENT_KEY_BYTES)
  const nonce = randomBytes(NONCE_BYTES)
  const wrappedKey = publicEncrypt(
    {
      key: recipient.key,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    contentKey,
  )
  const header = {
    kind: 'fsusblog-site-backup-envelope',
    version: 1,
    contentEncryption: 'AES-256-GCM',
    keyWrap: 'RSA-OAEP-SHA256',
    recipientKeyId: recipient.keyId,
    nonce: nonce.toString('base64'),
    wrappedKey: wrappedKey.toString('base64'),
  }
  const headerBytes = encodeHeader(header)
  const headerLength = Buffer.alloc(4)
  headerLength.writeUInt32BE(headerBytes.length)
  const temporary = `${output}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`

  try {
    await createExclusiveFile(temporary)
    await appendFile(temporary, Buffer.concat([MAGIC, headerLength, headerBytes]))
    const cipher = createCipheriv('aes-256-gcm', contentKey, nonce, {
      authTagLength: AUTH_TAG_BYTES,
    })
    cipher.setAAD(headerBytes)
    await pipeline(
      createReadStream(input),
      cipher,
      createWriteStream(temporary, { flags: 'a', mode: 0o600 }),
    )
    await appendFile(temporary, cipher.getAuthTag())
    await rename(temporary, output)
    await chmod(output, 0o600)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  } finally {
    contentKey.fill(0)
  }

  process.stdout.write(`${JSON.stringify({ ...header, wrappedKey: undefined, nonce: undefined })}\n`)
}

async function readEnvelopeHeader(input) {
  const inputStat = await stat(input)
  const handle = await open(input, 'r')
  try {
    const prefix = Buffer.alloc(MAGIC.length + 4)
    const prefixRead = await handle.read(prefix, 0, prefix.length, 0)
    if (prefixRead.bytesRead !== prefix.length || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('backup package is not an authenticated FsusBlog envelope')
    }
    const headerLength = prefix.readUInt32BE(MAGIC.length)
    if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
      throw new Error('invalid envelope header length')
    }
    const headerBytes = Buffer.alloc(headerLength)
    const headerRead = await handle.read(headerBytes, 0, headerLength, prefix.length)
    if (headerRead.bytesRead !== headerLength) {
      throw new Error('truncated envelope header')
    }
    const header = JSON.parse(headerBytes.toString('utf8'))
    if (
      header.kind !== 'fsusblog-site-backup-envelope' ||
      header.version !== 1 ||
      header.contentEncryption !== 'AES-256-GCM' ||
      header.keyWrap !== 'RSA-OAEP-SHA256' ||
      typeof header.recipientKeyId !== 'string' ||
      typeof header.nonce !== 'string' ||
      typeof header.wrappedKey !== 'string'
    ) {
      throw new Error('unsupported envelope metadata')
    }
    const ciphertextStart = prefix.length + headerLength
    const authTagStart = inputStat.size - AUTH_TAG_BYTES
    if (authTagStart <= ciphertextStart) {
      throw new Error('truncated envelope ciphertext')
    }
    const authTag = Buffer.alloc(AUTH_TAG_BYTES)
    const tagRead = await handle.read(authTag, 0, AUTH_TAG_BYTES, authTagStart)
    if (tagRead.bytesRead !== AUTH_TAG_BYTES) {
      throw new Error('truncated envelope authentication tag')
    }
    return { header, headerBytes, ciphertextStart, authTagStart, authTag }
  } finally {
    await handle.close()
  }
}

async function decrypt() {
  const input = valueOf('--input')
  const output = valueOf('--output')
  const identityPath = valueOf('--identity')
  await requireOutputAbsent(output)
  const passphraseIndex = args.indexOf('--passphrase-file')
  const passphraseFile = passphraseIndex >= 0 ? args[passphraseIndex + 1] : undefined
  const identity = await loadIdentity(identityPath, passphraseFile)
  const envelope = await readEnvelopeHeader(input)
  if (identity.keyId !== envelope.header.recipientKeyId) {
    throw new Error('backup identity does not match envelope recipient')
  }
  const contentKey = privateDecrypt(
    {
      key: identity.key,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(envelope.header.wrappedKey, 'base64'),
  )
  if (contentKey.length !== CONTENT_KEY_BYTES) {
    throw new Error('invalid unwrapped content key length')
  }
  const nonce = Buffer.from(envelope.header.nonce, 'base64')
  if (nonce.length !== NONCE_BYTES) {
    throw new Error('invalid envelope nonce length')
  }
  const temporary = `${output}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`

  try {
    await createExclusiveFile(temporary)
    const decipher = createDecipheriv('aes-256-gcm', contentKey, nonce, {
      authTagLength: AUTH_TAG_BYTES,
    })
    decipher.setAAD(envelope.headerBytes)
    decipher.setAuthTag(envelope.authTag)
    await pipeline(
      createReadStream(input, {
        start: envelope.ciphertextStart,
        end: envelope.authTagStart - 1,
      }),
      decipher,
      createWriteStream(temporary, { flags: 'w', mode: 0o600 }),
    )
    await rename(temporary, output)
    await chmod(output, 0o600)
  } catch (error) {
    await rm(temporary, { force: true })
    throw new Error('backup envelope authentication or decryption failed')
  } finally {
    contentKey.fill(0)
  }

  process.stdout.write(
    `${JSON.stringify({
      kind: envelope.header.kind,
      version: envelope.header.version,
      contentEncryption: envelope.header.contentEncryption,
      keyWrap: envelope.header.keyWrap,
      recipientKeyId: envelope.header.recipientKeyId,
    })}\n`,
  )
}

async function recipientInfo() {
  const recipient = await loadRecipient(valueOf('--recipient'))
  process.stdout.write(
    `${JSON.stringify({
      keyType: 'RSA',
      keyBits: recipient.bits,
      recipientKeyId: recipient.keyId,
    })}\n`,
  )
}

try {
  if (command === 'encrypt') await encrypt()
  else if (command === 'decrypt') await decrypt()
  else if (command === 'recipient-info') await recipientInfo()
  else throw new Error('usage: backup-envelope.mjs encrypt|decrypt|recipient-info ...')
} catch (error) {
  process.stderr.write(`[backup-envelope] ${error instanceof Error ? error.message : 'operation failed'}\n`)
  process.exitCode = 1
}
