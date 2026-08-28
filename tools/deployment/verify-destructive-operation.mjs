#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  readDestructiveOperationAuthority,
  verifyCandidateCleanupOwnership,
  verifyRuntimeSlotStop
} from './destructive-operation-authority.mjs'
import { readSlotState } from './slot-lib.mjs'
import { readRolloutState } from './release-rollout-lib.mjs'

try {
  const { command, options } = parseArgs(process.argv.slice(2))
  const authority = readDestructiveOperationAuthority(options.authority)
  if (command === 'runtime-candidate-cleanup') {
    const result = verifyCandidateCleanupOwnership({
      authority,
      slotState: readSlotState(requiredPath(options, 'slot-state'), { allowMissing: false }),
      rolloutState: readRolloutState(requiredPath(options, 'rollout-state')),
      candidate: {
        slot: options.slot,
        releaseId: options.release,
        imageDigest: options.digest,
        runtimeGeneration: positiveInteger(options.generation, '--generation')
      }
    })
    process.stdout.write(`${JSON.stringify({
      schema: 'fsusblog.destructive-operation-verification.v1', operation: command,
      status: 'pass', rolloutId: result.rolloutId, candidate: result.candidate, errors: []
    })}\n`)
    process.exit(0)
  }
  if (command !== 'runtime-slot-stop') {
    throw new Error('usage: verify-destructive-operation.mjs <runtime-slot-stop|runtime-candidate-cleanup> [options]')
  }
  const result = verifyRuntimeSlotStop({
    authority,
    slotState: readSlotState(requiredPath(options, 'slot-state'), { allowMissing: false }),
    rolloutState: readRolloutState(requiredPath(options, 'rollout-state')),
    targetObservation: readJson(requiredPath(options, 'target-observation')),
    activeObservation: readJson(requiredPath(options, 'active-observation'))
  })
  process.stdout.write(`${JSON.stringify({
    schema: 'fsusblog.destructive-operation-verification.v1',
    operation: command,
    status: 'pass',
    activeSlot: result.activeSlot,
    targetSlot: result.targetSlot,
    rolloutId: result.rolloutId,
    alreadyStopped: result.alreadyStopped,
    errors: []
  })}\n`)
} catch (error) {
  process.stderr.write(`[destructive-operation] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

function parseArgs(argv) {
  const command = argv.shift()
  const options = {}
  while (argv.length > 0) {
    const name = argv.shift()
    const value = argv.shift()
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`invalid argument near ${name ?? '<end>'}`)
    }
    options[name.slice(2)] = value
  }
  return { command, options }
}

function requiredPath(options, name) {
  if (!options[name]) throw new Error(`missing --${name}`)
  return path.resolve(options[name])
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`)
  return parsed
}
