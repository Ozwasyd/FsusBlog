#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import {
  completeRollout,
  completeRolloutRecovery,
  completeRolloutStage,
  createRolloutState,
  failRolloutStage,
  failRolloutRecovery,
  markCandidateOnly,
  markContractMigrationApplied,
  markGatewaySwitchCommitted,
  planRolloutRecovery,
  readRolloutState,
  startRolloutStage,
  writeRolloutStateAtomic
} from './release-rollout-lib.mjs'

function parse(argv) {
  const command = argv[0]
  const options = {}
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${name ?? '<end>'}`)
    options[name.slice(2)] = value
  }
  return { command, options }
}

function identity(options, prefix) {
  return {
    slot: options[`${prefix}-slot`],
    releaseId: options[`${prefix}-release`],
    imageDigest: options[`${prefix}-digest`],
    runtimeGeneration: Number(options[`${prefix}-generation`])
  }
}

try {
  const { command, options } = parse(process.argv.slice(2))
  const file = path.resolve(options.state ?? process.env.FSUSBLOG_ROLLOUT_STATE_FILE ?? '/var/lib/fsusblog/deployment/rollout.json')
  let state
  if (command === 'create') {
    state = createRolloutState({
      rolloutId: options['rollout-id'],
      kind: options.kind,
      manifestPath: path.resolve(options.manifest),
      source: identity(options, 'source'),
      target: identity(options, 'target'),
      createdAtUtc: options.at
    })
  } else {
    state = readRolloutState(file)
  }

  switch (command) {
    case 'create':
      break
    case 'read':
      break
    case 'start-stage':
      startRolloutStage(state, options.stage, options.at)
      break
    case 'complete-stage':
      completeRolloutStage(state, options.stage, { evidencePath: options.evidence, completedAtUtc: options.at })
      break
    case 'fail-stage':
      failRolloutStage(state, options.stage, {
        errorCode: options.error,
        evidencePath: options.evidence,
        failedAtUtc: options.at
      })
      break
    case 'mark-switch':
      markGatewaySwitchCommitted(state, Number(options.generation), options.at)
      break
    case 'mark-contract':
      markContractMigrationApplied(state, options.at)
      break
    case 'candidate-only':
      markCandidateOnly(state, options.at)
      break
    case 'complete':
      completeRollout(state, { evidencePath: options.evidence, completedAtUtc: options.at })
      break
    case 'recovery-plan':
      console.log(JSON.stringify(planRolloutRecovery(state)))
      process.exit(0)
    case 'complete-recovery':
      completeRolloutRecovery(state, {
        action: options.action,
        evidencePath: options.evidence,
        completedAtUtc: options.at,
        terminalStatus: options['terminal-status']
      })
      break
    case 'fail-recovery':
      failRolloutRecovery(state, {
        action: options.action,
        evidencePath: options.evidence,
        errorCode: options.error,
        failedAtUtc: options.at
      })
      break
    default:
      throw new Error('usage: rollout-state.mjs <create|read|start-stage|complete-stage|fail-stage|mark-switch|mark-contract|candidate-only|complete|recovery-plan|complete-recovery|fail-recovery> --state <file> [options]')
  }
  if (command !== 'read') writeRolloutStateAtomic(file, state)
  console.log(JSON.stringify(state))
} catch (error) {
  console.error(`[rollout-state] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
