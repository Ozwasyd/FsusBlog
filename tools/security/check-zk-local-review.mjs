#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateZkLocalReview } from './zk-local-review.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = parseArgs(process.argv.slice(2))
const output = resolvePath(args.output ?? '.tmp/security/zk-local-review-check.json')
const validation = validateZkLocalReview({
  root,
  manifestPath: args.manifest ?? 'security/zk/comment-v2-local-review.manifest.json',
  expectedVerifyingKeyHash: args.verifyingKeyHash ?? process.env.FSUSBLOG_ZK_VERIFYING_KEY_HASH ?? '',
  requireComplete: true
})

const summary = {
  schema: 'fsusblog.zk.local-cryptographic-review-check.v1',
  status: validation.status,
  ok: validation.ok,
  manifest: validation.manifestPath ? path.relative(root, validation.manifestPath) : null,
  checks: validation.checks,
  errors: validation.errors
}
mkdirSync(path.dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`)

if (!validation.ok) {
  for (const error of validation.errors) console.error(`[zk-local-review] ${error}`)
  process.exitCode = 1
} else {
  console.log(`[zk-local-review] locally_reviewed summary=${path.relative(root, output)}`)
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--manifest') parsed.manifest = requireValue(argv, ++index, token)
    else if (token === '--verifying-key-hash') parsed.verifyingKeyHash = requireValue(argv, ++index, token)
    else if (token === '--output') parsed.output = requireValue(argv, ++index, token)
    else throw new Error(`Unknown argument: ${token}`)
  }
  return parsed
}

function requireValue(argv, index, flag) {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

function resolvePath(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value)
}
