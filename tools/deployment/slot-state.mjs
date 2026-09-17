#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  abortGatewayTransition,
    beginGatewayTransition,
    commitGatewayTransition,
    markGatewayRollbackRequired,
    readLegacySlotState,
    readSlotState,
    recordSlotFailure,
    recordSlotStart,
  recordSlotStop,
  reserveRuntimeGeneration,
  resolveSlotConfig,
    setActiveSlot,
    writeSlotStateAtomic
} from './slot-lib.mjs';
import { readDeploymentReleaseIdentity } from '../release/deployment-release-identity.mjs';

function parseArgs(argv)
{
    const command = argv[0];
  const options = {}
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${name ?? '<end>'}`)
    options[name.slice(2)] = value
  }
  return { command, options }
}

function statePath(options) {
  return path.resolve(options.state ?? process.env.FSUSBLOG_SLOT_STATE_FILE ?? '/var/lib/fsusblog/deployment/slots.json')
}

try
{
    const { command, options } = parseArgs(process.argv.slice(2));
    const file = statePath(options);
    if (command === 'read-legacy')
{
        console.log(JSON.stringify(readLegacySlotState(file)));
        process.exit(0);
    }
    const state = readSlotState(file);
    let output = state;
    switch (command)
{
    case 'ensure':
      if (!fs.existsSync(file)) writeSlotStateAtomic(file, state)
      output = state
      break
    case 'read':
      if (options.slot) {
        const config = resolveSlotConfig(options.slot)
                output = { activeSlot: state.activeSlot, slot: config.slot, config, record: state.slots[config.slot], lastTransition: state.lastTransition };
            }
            break;
        case 'record-start': {
            if (!options['release-manifest']) {throw new Error('record-start requires --release-manifest')};
            const releaseIdentity = readDeploymentReleaseIdentity(options['release-manifest'], {
                releaseId: options['release-id'],
                createdAtUtc: options['created-at-utc'],
                commitSha: options['commit-sha'],
                imageRef: options['image-ref'],
                imageDigest: options['image-digest']
            });
            recordSlotStart(state, {
                slot: options.slot,
                releaseId: releaseIdentity.releaseId,
                imageRef: releaseIdentity.imageRef,
                imageDigest: releaseIdentity.imageDigest,
                deploymentGeneration: options['deployment-generation'] === undefined
                    ? undefined
                    : Number(options['deployment-generation']),
        startedAt: options.at,
        environment: process.env
      })
            writeSlotStateAtomic(file, state);
            output = state;
            break;
        }
        case 'reserve-generation': {
            const generation = reserveRuntimeGeneration(state, { slot: options.slot, reservedAt: options.at });
            writeSlotStateAtomic(file, state);
      output = { generation, state }
      break
    }
    case 'record-stop':
      recordSlotStop(state, { slot: options.slot, stoppedAt: options.at })
      writeSlotStateAtomic(file, state)
      output = state
      break
    case 'record-failure':
      recordSlotFailure(state, {
        slot: options.slot,
        operation: options.operation,
        releaseId: options['release-id'] || null,
        message: options.message,
        failedAt: options.at
      })
      writeSlotStateAtomic(file, state)
      output = state
      break
    case 'set-active':
      setActiveSlot(state, { slot: options.slot, kind: options.kind, changedAt: options.at })
      writeSlotStateAtomic(file, state)
      output = state
      break
    case 'begin-transition':
      beginGatewayTransition(state, {
        slot: options.slot,
        releaseId: options['release-id'],
        imageDigest: options['image-digest'],
        kind: options.kind,
        startedAt: options.at
      })
      writeSlotStateAtomic(file, state)
      output = state
      break
    case 'commit-transition':
      commitGatewayTransition(state, { committedAt: options.at })
      writeSlotStateAtomic(file, state)
      output = state
      break
    case 'abort-transition':
      abortGatewayTransition(state, { message: options.message, abortedAt: options.at })
      writeSlotStateAtomic(file, state)
      output = state
      break
    case 'rollback-required':
      markGatewayRollbackRequired(state, { message: options.message, failedAt: options.at })
      writeSlotStateAtomic(file, state)
            output = state;
            break;
        default:
            throw new Error('usage: slot-state.mjs <ensure|read|read-legacy|reserve-generation|record-start|record-stop|record-failure|set-active|begin-transition|commit-transition|abort-transition|rollback-required> [--state file] [options]');
    }
    console.log(JSON.stringify(output));
}
 catch (error)
{
  console.error(`[slot-state] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
