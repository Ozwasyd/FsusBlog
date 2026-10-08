#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import {
  completeRollout,
  completeRolloutRecovery,
  completeRolloutStage,
  createRolloutState,
  createCurrentActivationPlan,
  writeCurrentActivationPlanAtomic,
    failRolloutStage,
    failRolloutRecovery,
    markCandidateOnly,
    markActivationCommitted,
    markContractMigrationApplied,
    markDestructiveCutoverStarted,
    markGatewaySwitchCommitted,
    planRolloutRecovery,
    readRolloutState,
    startRolloutStage,
    writeRolloutStateAtomic
} from './release-rollout-lib.mjs';
import { readExplicitReleaseArtifact } from '../release/release-manifest.mjs';
import { RELEASE_ID_CONTRACT } from '../release/release-id.mjs';

import { readSlotState } from './slot-lib.mjs';
import { readDeploymentReleaseIdentity } from '../release/deployment-release-identity.mjs';

function parse(argv)
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
    if (command === 'create-current-activation-plan')
    {
        const required = ['state', 'manifest', 'manifest-sha256', 'active-candidate', 'active-manifest-digest'];
        if (required.some(key => !options[key]) || Object.keys(options).some(key => !required.includes(key)))
            throw new Error('current activation creation requires exact explicit state, manifest/digest and active identity inputs');
        const manifestReference = options.manifest;
        const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
            readExplicitReleaseArtifact(manifestReference, options['manifest-sha256'].replace(/^sha256:/u, ''))));
        const plan = createCurrentActivationPlan({ manifest, manifestReference, manifestSha256: options['manifest-sha256'],
            activeBefore: { candidateId: options['active-candidate'], manifestContentDigest: options['active-manifest-digest'] },
            releaseIdContract: RELEASE_ID_CONTRACT });
        writeCurrentActivationPlanAtomic(path.resolve(options.state), plan, manifest);
        process.stdout.write(`${JSON.stringify(plan)}\n`);
        process.exit(0);
    }
    const file = path.resolve(options.state ?? process.env.FSUSBLOG_ROLLOUT_STATE_FILE ?? '/var/lib/fsusblog/deployment/rollout.json');
    let state;
    if (command === 'create')
{
        if (!options.manifest) {throw new Error('create requires --manifest')};
        if (!options['slot-state']) {throw new Error('create requires --slot-state')};
        const targetRelease = readDeploymentReleaseIdentity(options.manifest, {
            releaseId: options['target-release'],
            imageDigest: options['target-digest']
        });
        const slotState = readSlotState(path.resolve(options['slot-state']), { allowMissing: false });
        const sourceSlot = options['source-slot'];
        const sourceRecord = slotState.slots?.[sourceSlot];
        if (slotState.activeSlot !== sourceSlot || !sourceRecord || sourceRecord.status !== 'running')
{
            throw new Error('source slot must be the persisted active running slot');
        }
        const source = identity(options, 'source');
        if (source.releaseId !== sourceRecord.releaseId
      || source.imageDigest !== sourceRecord.imageDigest
      || source.runtimeGeneration !== sourceRecord.deploymentGeneration)
{
            throw new Error('source identity does not match persisted slot state');
        }
        state = createRolloutState({
            rolloutId: options['rollout-id'],
            kind: options.kind,
            manifestPath: path.resolve(options.manifest),
            source,
            target: {
                slot: options['target-slot'],
                releaseId: targetRelease.releaseId,
                imageDigest: targetRelease.imageDigest,
                runtimeGeneration: Number(options['target-generation'])
            },
            createdAtUtc: options.at
        });
    }
 else
{
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
            markContractMigrationApplied(state, options.at);
            break;
        case 'mark-destructive-cutover':
            markDestructiveCutoverStarted(state, options.at);
            break;
        case 'mark-activation':
            markActivationCommitted(state, options.at);
            break;
        case 'candidate-only':
            markCandidateOnly(state, options.at);
            break;
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
            });
            break;
        default:
            throw new Error('usage: rollout-state.mjs <create|read|start-stage|complete-stage|fail-stage|mark-switch|mark-contract|mark-destructive-cutover|mark-activation|candidate-only|complete|recovery-plan|complete-recovery|fail-recovery> --state <file> [options]');
    }
    if (command !== 'read') {writeRolloutStateAtomic(file, state)};
    console.log(JSON.stringify(state));
} catch (error) {
  console.error(`[rollout-state] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
