#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { writeIntegrityProofProducer } from '../test-matrix/integrity-proof-producer.mjs'

function options(argv) {
  const values = { trx: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[++index]
    if (!key?.startsWith('--') || !value) throw new Error(`${key || 'option'} requires a value`)
    const name = key.slice(2)
    if (name === 'trx') values.trx.push(path.resolve(value))
    else values[name] = value
  }
  for (const name of ['catalog', 'root', 'commit', 'worktree-fingerprint', 'run-id', 'namespace', 'producer-output', 'source-output']) {
    if (!values[name]) throw new Error(`--${name} is required`)
  }
  if (values.trx.length === 0) throw new Error('--trx is required')
  return values
}

try {
  const value = options(process.argv.slice(2))
  const result = writeIntegrityProofProducer({
    catalog: JSON.parse(fs.readFileSync(path.resolve(value.catalog), 'utf8')),
    trxFiles: value.trx,
    repositoryRoot: path.resolve(value.root),
    sourceState: { commit: value.commit, worktreeFingerprint: value['worktree-fingerprint'] },
    runId: value['run-id'],
    namespace: value.namespace,
    producerOutput: path.resolve(value['producer-output']),
    sourceOutput: path.resolve(value['source-output'])
  })
  process.stdout.write(`[integrity-proof-producer] assertions=${result.receipt.assertions.length} source=${result.receipt.artifacts[0].path}\n`)
} catch (error) {
  process.stderr.write(`[integrity-proof-producer] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
