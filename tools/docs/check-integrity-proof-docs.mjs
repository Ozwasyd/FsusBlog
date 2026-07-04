#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outFile = resolve(root, '.tmp/docs/integrity-proof-docs.json')
const errors = []

function read(path) {
  const fullPath = resolve(root, path)
  if (!existsSync(fullPath)) {
    errors.push(`${path} missing`)
    return ''
  }
  return readFileSync(fullPath, 'utf8')
}

function requireToken(path, source, token) {
  if (!source.includes(token)) {
    errors.push(`${path} missing ${token}`)
  }
}

function requireAny(path, source, tokens) {
  if (!tokens.some((token) => source.includes(token))) {
    errors.push(`${path} missing one of ${tokens.join(', ')}`)
  }
}

function integrityDocs() {
  const dir = resolve(root, 'docs/integrity')
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => [`docs/integrity/${entry}`, read(`docs/integrity/${entry}`)])
}

function isExternalNonGoalLine(line) {
  return /\b(not|never|no|without|out[- ]of[- ]scope|non-goal|does not|do not|must not|isn't|不是|不在|不使用|不上链|禁止|不得)\b/iu.test(line)
}

function checkExternalAnchorClaims(path, source) {
  const externalTerms = /\b(IPFS|Arweave|blockchain|chain anchor|chain anchoring|on-chain|wallet)\b/iu
  const lines = source.split(/\r?\n/u)
  for (const [index, line] of lines.entries()) {
    if (!externalTerms.test(line)) continue
    const context = lines.slice(Math.max(0, index - 5), index + 1).join('\n')
    if (!isExternalNonGoalLine(context)) {
      errors.push(`${path}:${index + 1} describes external anchoring as current capability: ${line.trim()}`)
    }
  }
}

function checkStaleNaming(path, source) {
  if (/\brevisionId\b/u.test(source)) {
    errors.push(`${path} uses stale revisionId; use articleRevisionId plus revisionNo`)
  }

  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (/\bEd25519\b/u.test(line) && !/\b(not|future|reviewed dependency|not the current|explicit dependency)\b/iu.test(line)) {
      errors.push(`${path}:${index + 1} treats Ed25519 as current/default: ${line.trim()}`)
    }
    if (/integrity[- ]?proof.*ArticleMutationReplayEdges\.Required|ArticleMutationReplayEdges\.Required.*integrity[- ]?proof/iu.test(line)
      && !/\b(not|not part|intentionally not|does not|不得|不在|不属于)\b/iu.test(line)) {
      errors.push(`${path}:${index + 1} treats IntegrityProof as required replay edge: ${line.trim()}`)
    }
  }
}

const requiredFiles = {
  index: ['docs/integrity/index.md', [
    'IntegrityProof',
    'off-chain',
    'single-process',
    'C#/.NET 10',
    'PostgreSQL',
    'Redis',
    'PublicAOT',
    'ArticleDetailAeds',
    'PublicHotRead',
    'not a performance optimization',
    'not a privacy system',
    'docs/integrity/threat-model.md',
    'docs/integrity/runbook.md',
    'docs/integrity/implementation-notes.md',
    'docs/integrity/public-verification-guide.md'
  ]],
  threatModel: ['docs/integrity/threat-model.md', [
    'spoofing',
    'tamper',
    'replay',
    'key compromise',
    'private data leakage',
    'log deletion',
    'checkpoint mismatch',
    'artifact stale',
    'does not prove',
    'single-process'
  ]],
  runbook: ['docs/integrity/runbook.md', [
    'proof failed',
    'retrying',
    'pending',
    'superseded',
    'not-public',
    'key revoke',
    'compromise',
    'transparency log',
    'broken chain',
    'checkpoint',
    'tools/test/lanes/integrity-proof-verification.sh',
    'tools/integrity/verify-proof-fixtures.mjs'
  ]],
  implementationNotes: ['docs/integrity/implementation-notes.md', [
    'Article',
    'ArticleBody',
    'ArticleRevision.Id',
    'RevisionNo',
    'articleId',
    'articleRevisionId',
    'revisionNo',
    'PublicAOT',
    'ArticleDetailAeds',
    'PublicHotRead',
    'DistributionEndpoints',
    'ArticleMutationReplayEdges.Required',
    'ECDSA_P256_SHA256',
    'Span',
    'ReadOnlySpan',
    'unsafe',
    'C++23/Wasm',
    'admin principal id'
  ]],
  publicVerificationGuide: ['docs/integrity/public-verification-guide.md', [
    'public verification',
    'articleId',
    'articleRevisionId',
    'revisionNo',
    'canonical hash',
    'artifact digest',
    'signature',
    'transparency log',
    'Merkle checkpoint',
    'offline',
    'does not expose'
  ]]
}

for (const [path, tokens] of Object.values(requiredFiles)) {
  const source = read(path)
  for (const token of tokens) {
    requireToken(path, source, token)
  }
}

const verification = read('docs/integrity/verification.md')
requireToken('docs/integrity/verification.md', verification, 'docs/integrity/index.md')
requireToken('docs/integrity/verification.md', verification, 'externalNetwork: false')

const runbook = read('docs/integrity/runbook.md')
requireAny('docs/integrity/runbook.md', runbook, ['.tmp/release-evidence/integrity-proof-verification.json', '.tmp'])

for (const [path, source] of integrityDocs()) {
  checkExternalAnchorClaims(path, source)
  checkStaleNaming(path, source)
}

function writeSummary(status) {
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, `${JSON.stringify({
    schema: 'fsusblog.integrity-proof-docs.v1',
    status,
    generatedAt: new Date().toISOString(),
    checkedFiles: Object.values(requiredFiles).map(([path]) => path).concat('docs/integrity/verification.md'),
    errors
  }, null, 2)}\n`)
}

if (errors.length > 0) {
  writeSummary('failed')
  for (const error of errors) {
    console.error(`[integrity-proof-docs] ${error}`)
  }
  process.exit(1)
}

writeSummary('ok')
console.log('[integrity-proof-docs] ok')
