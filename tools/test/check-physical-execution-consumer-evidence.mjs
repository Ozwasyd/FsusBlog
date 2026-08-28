#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  validateRunBoundConsumerEvidence,
  validateRunBoundProjection
} from './run-once.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function readRegularJson(file, label) {
  const metadata = fs.lstatSync(file)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`)
  }
  const bytes = fs.readFileSync(file)
  return { bytes, document: JSON.parse(bytes.toString('utf8')) }
}

export async function verifyConsumerEvidenceFile(file, {
  root = path.join(repoRoot, '.tmp', 'physical-executions')
} = {}) {
  const evidenceFile = path.resolve(file)
  const evidence = readRegularJson(evidenceFile, 'consumer evidence').document
  validateRunBoundConsumerEvidence(evidence)

  const repositoryRoot = path.resolve(evidence.physicalExecutionReceiptDocument.cwd)
  const projectionFile = path.resolve(repositoryRoot, evidence.sourceProjection)
  const receiptFile = path.resolve(repositoryRoot, evidence.physicalExecutionReceipt)
  const validated = await validateRunBoundProjection({
    root,
    runId: evidence.schedulerRunId,
    key: evidence.executionKey,
    consumerId: evidence.consumerId,
    projectionFile,
    receiptFile
  })
  if (`sha256:${sha256(validated.projectionBytes)}` !== evidence.sourceProjectionDigest
      || JSON.stringify(validated.projection) !== JSON.stringify(evidence.sourceProjectionDocument)
      || JSON.stringify(validated.receipt) !== JSON.stringify(evidence.physicalExecutionReceiptDocument)) {
    throw new Error('consumer evidence raw projection or receipt validation failed')
  }
  return evidence
}

async function main(argv) {
  if (argv.length !== 1) {
    throw new Error('usage: check-physical-execution-consumer-evidence.mjs <evidence-file>')
  }
  const evidence = await verifyConsumerEvidenceFile(argv[0])
  console.log(`[physical-execution-evidence] ok run=${evidence.schedulerRunId} key=${evidence.executionKey} consumer=${evidence.consumerId}`)
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[physical-execution-evidence] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
