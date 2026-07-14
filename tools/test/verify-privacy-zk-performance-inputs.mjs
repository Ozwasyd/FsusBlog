#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { readRunBoundMarker } from '../test-matrix/run-bound-marker.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function readBoundJson(repositoryRoot, relativeFile, validate) {
  const file = path.join(repositoryRoot, relativeFile)
  if (!fs.existsSync(file)) throw new Error(`privacy-ZK performance input is missing: ${relativeFile}`)
  const source = fs.readFileSync(file)
  let value
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`privacy-ZK performance input is invalid JSON: ${relativeFile}`, { cause: error })
  }
  validate(value, relativeFile)
  return {
    path: relativeFile,
    digest: `sha256:${createHash('sha256').update(source).digest('hex')}`
  }
}

export function verifyPrivacyZkPerformanceInputs({
  runId = process.env.FSUSBLOG_TEST_RUN_ID,
  sourceState = {
    commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
    worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
  },
  repositoryRoot = root
} = {}) {
  const normalizedRunId = String(runId ?? '').trim()
  if (!normalizedRunId) throw new Error('privacy-ZK performance input verification requires FSUSBLOG_TEST_RUN_ID')
  const resolvedRoot = path.resolve(repositoryRoot)
  const failures = []
  const collect = (relativeFile, validate) => {
    try {
      return readBoundJson(resolvedRoot, relativeFile, validate)
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)))
      return null
    }
  }

  const markers = [
    ['backend-coverage-ready', 'backend-tests', 'backend-coverage-summary'],
    ['frontend-coverage-ready', 'frontend-tests', 'frontend-coverage-summary']
  ].map(([markerId, producerBundleId, producerStepId]) => {
    const relativeFile = `.tmp/test-runs/${normalizedRunId}/${markerId}.json`
    try {
      readRunBoundMarker(path.join(resolvedRoot, relativeFile), {
        root: resolvedRoot,
        markerId,
        runId: normalizedRunId,
        sourceState,
        producerBundleId,
        producerStepId
      })
      return readBoundJson(resolvedRoot, relativeFile, () => {})
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)))
      return null
    }
  })
  const frontendBuild = collect(
    `.tmp/test-runs/${normalizedRunId}/frontend-build-ready.json`,
    (marker, relativeFile) => {
      if (marker?.schema !== 'fsusblog.local-production.frontend-build-ready.v1'
        || marker.status !== 'success'
        || marker.schedulerRunId !== normalizedRunId
        || marker.buildLayout?.sourceCommit !== sourceState.commit
        || marker.buildLayout?.sourceFingerprint !== sourceState.worktreeFingerprint) {
        throw new Error(`privacy-ZK performance input is not the current frontend build marker: ${relativeFile}`)
      }
    }
  )
  const stages = ['contract', 'functional'].map((stage) => collect(
    `.tmp/security/privacy-zk-comment-matrix-stages/${stage}.json`,
    (receipt, relativeFile) => {
      if (receipt?.schema !== 'fsusblog.privacy-zk-comment-matrix-stage.v1'
        || receipt.status !== 'ok'
        || receipt.stage !== stage
        || receipt.runId !== normalizedRunId) {
        throw new Error(`privacy-ZK performance input is not a successful ${normalizedRunId} ${stage} receipt: ${relativeFile}`)
      }
    }
  ))
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `privacy-ZK performance inputs failed in ${failures.length} independent files: ${failures.map((error) => error.message).join('; ')}`
    )
  }
  return { runId: normalizedRunId, markers, frontendBuild, stages }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const evidence = verifyPrivacyZkPerformanceInputs()
    process.stdout.write(`${JSON.stringify({
      schema: 'fsusblog.privacy-zk-performance-inputs.v1',
      status: 'ok',
      ...evidence
    })}\n`)
  } catch (error) {
    console.error(`[privacy-zk-performance-inputs] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
