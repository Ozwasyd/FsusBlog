#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic } from './release-assets.mjs';
import { executeReleaseAssetGc, normalizeGcState, observeReleaseAssetProtection, RELEASE_GC_EVIDENCE_SCHEMA } from './release-gc.mjs';
const {readRolloutState} = await import(new URL('../deployment/release-rollout-lib.mjs', import.meta.url));
const {readSlotState} = await import(new URL('../deployment/slot-lib.mjs', import.meta.url));
const {readDestructiveOperationAuthority, verifyArtifactGcActiveIdentity} = await import(new URL('../deployment/destructive-operation-authority.mjs', import.meta.url));

import { readReleaseManifest } from '../release/release-manifest.mjs';
import { observeRuntimeRoleDeploymentAuthority, verifyRuntimeRoleLiveContainers } from '../governance/check-monolithic-distributed-architecture.mjs';
import { verifyReleaseRolloutEvidence } from '../deployment/release-rollout-evidence-receipt-contract.mjs';
import * as runtimeRoleObservation from '../contracts/lib/runtime-role-observation.mjs';

function main() {
  let options = {}
  let observationLockDescriptor
  try {
    options = parseArgs(process.argv.slice(2))
    if (options.observeRuntime === true && options.observeProtection !== true) throw new Error('live runtime observation requires read-only protection mode')
    if (options['schema-pair']) throw new Error('legacy schema-pair inputs are retired; use current-only --current-schema-input')
    if (options['current-schema-input'] && options.observeRuntime !== true) throw new Error('current schema input requires live runtime observation')
    if (options['rollout-evidence'] && options.observeProtection !== true) throw new Error('rollout evidence requires read-only protection observation')
    if (options.observeProtection === true && process.argv.includes('--apply')) throw new Error('read-only protection cannot be combined with apply')
    const needsDeploymentLock = options.apply === true || options.observeProtection === true
    if (options.observeProtection === true) {
      if (options.locked === true || options['lock-token']) throw new Error('read-only protection does not accept caller lock claims')
      const deploymentLock = path.resolve(options['deployment-lock']
        ?? process.env.FSUSBLOG_DEPLOYMENT_LOCK_FILE ?? '/var/lock/fsusblog-deployment.lock')
      fs.mkdirSync(path.dirname(deploymentLock), { recursive: true, mode: 0o700 })
      observationLockDescriptor = fs.openSync(deploymentLock, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600)
      assertDeploymentObservationLock(options, observationLockDescriptor)
      // The child locks this inherited open file description. This process retains it
      // throughout the storage-lock observation; no environment or JSON assertion grants it.
      const locked = spawnSync('flock', ['--nonblock', '3'], {
        stdio: ['ignore', 'pipe', 'pipe', observationLockDescriptor], encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024
      })
      if (locked.error || locked.status !== 0) throw new Error('read-only protection could not acquire the deployment lock')
      assertDeploymentObservationLock(options, observationLockDescriptor)
    }
    if (needsDeploymentLock && options.locked === true
        && (!process.env.FSUSBLOG_GC_LOCK_TOKEN || options['lock-token'] !== process.env.FSUSBLOG_GC_LOCK_TOKEN)) {
      throw new Error('internal GC lock handoff is invalid')
    }
    if (needsDeploymentLock && options.observeProtection !== true && options.locked !== true && !hasInheritedDeploymentLock(options)) {
      const deploymentLock = path.resolve(options['deployment-lock']
        ?? process.env.FSUSBLOG_DEPLOYMENT_LOCK_FILE
        ?? '/var/lock/fsusblog-deployment.lock')
      fs.mkdirSync(path.dirname(deploymentLock), { recursive: true, mode: 0o700 })
      const token = crypto.randomUUID()
      const child = spawnSync('flock', [
        '--nonblock', deploymentLock, process.execPath, fileURLToPath(import.meta.url),
        ...process.argv.slice(2), '--locked', '--lock-token', token
      ], { stdio: 'inherit', env: { ...process.env, FSUSBLOG_GC_LOCK_TOKEN: token } })
      if (child.error) throw child.error
      process.exit(child.status ?? 1)
    }
    const storeDirectory = path.resolve(options.store ?? process.env.FSUSBLOG_RELEASE_ASSET_STORE ?? '/var/lib/fsusblog/release-assets')
    const stateFile = path.resolve(options.state ?? process.env.FSUSBLOG_RELEASE_RETENTION_STATE ?? path.join(storeDirectory, 'retention-state.json'))
    const state = normalizeGcState(JSON.parse(fs.readFileSync(stateFile, 'utf8')))
    if (options.observeProtection === true) {
      const files = {
        slotState: requiredPath(options, 'slot-state'),
        rolloutState: requiredPath(options, 'rollout-state'),
        retentionState: requiredPath(options, 'state')
      }
      if (options['current-schema-input']) files.currentSchemaInput = requiredPath(options, 'current-schema-input')
      if (options['rollout-evidence']) files.rolloutEvidence = requiredPath(options, 'rollout-evidence')
      let inputReferences
      let runtimeObservation
      let schemaObservation
      let rolloutObservation
      const observed = observeReleaseAssetProtection({
        storeDirectory,
        state,
        lockFile: options.lock ? path.resolve(options.lock) : null,
        readProtection: () => {
          assertDeploymentObservationLock(options, observationLockDescriptor)
          const current = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, durableFileReference(file)]))
          if (inputReferences && JSON.stringify(inputReferences) !== JSON.stringify(current)) {
            throw new Error('durable protection input bytes changed inside the observation locks')
          }
          inputReferences = current
          if (files.rolloutEvidence) {
            const currentRollout = verifyObservedRollout(files.rolloutEvidence, files.rolloutState)
            if (rolloutObservation && JSON.stringify(rolloutObservation) !== JSON.stringify(currentRollout)) {
              throw new Error('verified rollout identity changed inside observation locks')
            }
            rolloutObservation = currentRollout
          }
          if (options.observeRuntime === true) {
            const observedRuntime = readLiveRuntimeProtection(options, files.slotState)
            if (runtimeObservation && JSON.stringify(runtimeObservation) !== JSON.stringify(observedRuntime)) {
              throw new Error('live runtime image or mount identity changed inside observation locks')
            }
            runtimeObservation = observedRuntime
          }
          if (files.currentSchemaInput) {
            const schemaInput = JSON.parse(readDurableFile(files.currentSchemaInput).bytes.toString('utf8'))
            const currentSchema = readCurrentSchemaObservation(schemaInput, runtimeObservation, files.rolloutState)
            if (schemaObservation && schemaObservationIdentity(schemaObservation) !== schemaObservationIdentity(currentSchema)) {
              throw new Error('current schema observation changed inside observation locks')
            }
            schemaObservation = currentSchema
          }
          const protection = readActiveProtection(options, state)
          const terminal = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, durableFileReference(file)]))
          if (JSON.stringify(inputReferences) !== JSON.stringify(terminal)) {
            throw new Error('durable protection input bytes changed inside the observation locks')
          }
          assertDeploymentObservationLock(options, observationLockDescriptor)
          return protection
        }
      })
      assertDeploymentObservationLock(options, observationLockDescriptor)
      const evidence = {
        schema: 'fsusblog.release-assets.protection-observation.v1',
        status: 'observed',
        readOnly: true,
        qualificationEligible: false,
        inputReferences,
        ...(rolloutObservation ? { rolloutObservation } : {}),
        ...(runtimeObservation ? { runtimeObservation } : {}),
        ...(schemaObservation ? { schemaObservation } : {}),
        ...observed
      }
      if (options.out) {
        const output = path.resolve(options.out)
        if (fs.realpathSync(path.dirname(output)) !== path.dirname(output)
            || output === storeDirectory || output.startsWith(`${storeDirectory}${path.sep}`)) {
          throw new Error('read-only protection evidence must be outside the asset store with a canonical parent')
        }
        fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      }
      process.stdout.write(`${JSON.stringify(evidence)}\n`)
      return
    }
    const activeProtection = options.apply === true ? readActiveProtection(options, state) : null
    const reviewedDryRun = options.apply === true ? readReviewedDryRun(options, storeDirectory) : null
    const evidence = executeReleaseAssetGc({
      storeDirectory,
      state,
      apply: options.apply === true,
      evidenceFile: options.out ? path.resolve(options.out) : null,
      lockFile: options.lock ? path.resolve(options.lock) : null,
      activeProtection,
      refreshProtection: options.apply === true ? () => readActiveProtection(options, state) : null,
      reviewedDryRun
    })
    process.stdout.write(`${JSON.stringify({ ...evidence, retentionState: stateFile })}\n`)
  } catch (error) {
    const report = {
      schema: RELEASE_GC_EVIDENCE_SCHEMA,
      status: 'fail',
      dryRun: options.apply !== true,
      releaseActions: [],
      objectActions: [],
      errors: [error instanceof Error ? error.message : String(error)]
    }
    if (options.out && options.observeProtection !== true && options.observeRuntime !== true) {
      try { writeJsonAtomic(path.resolve(options.out), report) } catch {}
    }
    process.stdout.write(`${JSON.stringify(report)}\n`)
    process.exitCode = 1
  } finally {
    if (observationLockDescriptor !== undefined) fs.closeSync(observationLockDescriptor)
  }
}

main()

function parseArgs(argv) {
  const parsed = {}
  const readOnlyMode = argv.includes('--observe-protection') || argv.includes('--observe-runtime')
  const observedOptions = new Set()
  const readOnlyOptions = new Set([
    '--observe-protection', '--observe-runtime', '--store', '--state', '--slot-state', '--rollout-state',
    '--deployment-lock', '--lock', '--out', '--authority', '--environment-file',
    '--blue-manifest', '--green-manifest', '--schema-pair', '--current-schema-input', '--rollout-evidence', '--reviewed-dry-run', '--apply', '--dry-run', '--locked', '--lock-token'
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (readOnlyMode && (!readOnlyOptions.has(name) || observedOptions.has(name))) {
      throw new Error(`unknown or duplicate read-only observation option: ${name}`)
    }
    observedOptions.add(name)
    if (name === '--apply') {
      parsed.apply = true
      continue
    }
    if (name === '--dry-run') {
      parsed.apply = false
      continue
    }
    if (name === '--observe-protection') {
      parsed.observeProtection = true
      continue
    }
    if (name === '--observe-runtime') {
      parsed.observeRuntime = true
      continue
    }
    if (name === '--locked') {
      parsed.locked = true
      continue
    }
    if (!name?.startsWith('--')) throw new Error(`invalid argument: ${name ?? '<end>'}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${name}`)
    parsed[name.slice(2)] = value
    index += 1
  }
  return parsed
}

function verifyObservedRollout(evidenceFile, rolloutStateFile)
{
    const opened = readDurableFile(evidenceFile);
    const state = readRolloutState(rolloutStateFile);
    const evidence = JSON.parse(opened.bytes.toString('utf8'));
    const reads = new Map();
    const report = verifyReleaseRolloutEvidence(evidence, {
        evidencePath: evidenceFile,
        now: Date.now(),
        readBytes: (file) =>
        {
            const input = readDurableFile(file);
            const prior = reads.get(file);
            if (prior && JSON.stringify(prior.reference) !== JSON.stringify(input.reference))
            {
                throw new Error('rollout input changed while replaying canonical bytes');
            }
            reads.set(file, input);
            return input.bytes;
        }
    });
    if (report.schema !== 'fsusblog.release-rollout-evidence-verification.v1'
        || report.status !== 'pass' || report.rolloutId !== state.rolloutId
        || report.evidence !== evidenceFile)
    {
        throw new Error('canonical rollout evidence verification failed');
    }
    if (evidence.rolloutId !== state.rolloutId
        || JSON.stringify(evidence.source) !== JSON.stringify(state.source)
        || JSON.stringify(evidence.target) !== JSON.stringify(state.target)
        || evidence.manifestSha256 !== state.manifestSha256
        || evidence.candidateSourceRevision !== state.candidateSourceRevision
        || JSON.stringify(evidence.currentSchema) !== JSON.stringify(state.currentSchema)
        || JSON.stringify(opened.reference) !== JSON.stringify(durableFileReference(evidenceFile))
        || [...reads].some(([file, input]) => JSON.stringify(input.reference) !== JSON.stringify(durableFileReference(file))))
    {
        throw new Error('canonical rollout evidence does not bind the current durable rollout');
    }
    return { reference: opened.reference, verification: report };
}

function readDurableFile(file)
{
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file
        || fs.realpathSync(file) !== file)
    {
        throw new Error('durable protection input must be a canonical physical file');
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try
    {
        const before = fs.fstatSync(descriptor, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n)
        {
            throw new Error('durable protection input must be a single-link regular file');
        }
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor, { bigint: true });
        const current = fs.lstatSync(file, { bigint: true });
        const fields = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
        if (fs.realpathSync(file) !== file || !current.isFile() || current.isSymbolicLink()
            || BigInt(bytes.length) !== before.size
            || fields.some(field => before[field] !== after[field] || after[field] !== current[field]))
        {
            throw new Error('durable protection input identity changed while reading');
        }
        return { bytes, reference: { path: file,
            sha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
            bytes: bytes.length,
            epoch: Object.fromEntries(fields.map(field => [field, String(before[field])])) } };
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function durableFileReference(file)
{
    return readDurableFile(file).reference;
}

function assertDeploymentObservationLock(parsed, descriptor)
{
    const file = path.resolve(parsed['deployment-lock']
        ?? process.env.FSUSBLOG_DEPLOYMENT_LOCK_FILE ?? '/var/lock/fsusblog-deployment.lock');
    const held = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    if (!held.isFile() || held.nlink !== 1n || !current.isFile() || current.isSymbolicLink()
        || current.nlink !== 1n || held.dev !== current.dev || held.ino !== current.ino)
    {
        throw new Error('read-only deployment lock physical identity changed');
    }
}

function schemaObservationIdentity(value)
{
    return JSON.stringify({ status: value.status, readOnly: value.readOnly,
        qualificationEligible: value.qualificationEligible, runId: value.runId, sourceCommit: value.sourceCommit,
        source: value.sourceVerification.stableIdentity, target: value.targetVerification.stableIdentity });
}

function readCurrentSchemaObservation(input, runtime, rolloutStateFile)
{
    const rollout = readRolloutState(rolloutStateFile);
    for (const role of ['source', 'target'])
    {
        const manifest = runtime.manifestIdentities[rollout[role].slot];
        const observed = input?.[role];
        if (!manifest || manifest.releaseId !== rollout[role].releaseId
            || observed?.candidateSourceRevision !== manifest.commitSha
            || observed?.receiptPath !== manifest.currentSchema?.receipt?.reference
            || observed?.receiptSha256 !== manifest.currentSchema?.receipt?.sha256)
        {
            throw new Error('current schema input does not bind the actual rollout release manifests');
        }
    }
    if (typeof runtimeRoleObservation.verifyRuntimeRoleCurrentSchemaPair !== 'function')
    {
        throw new Error('current-only runtime schema observation owner is not connected');
    }
    const result = runtimeRoleObservation.verifyRuntimeRoleCurrentSchemaPair(input);
    if (result?.then || result?.readOnly !== true || result?.qualificationEligible !== false
        || !result?.sourceVerification?.stableIdentity || !result?.targetVerification?.stableIdentity)
    {
        throw new Error('current-only runtime schema observation must preserve the synchronous read-only source boundary');
    }
    return result;
}

function readActiveProtection(parsed, expectedRetentionState)
{
    const slotStateFile = requiredPath(parsed, 'slot-state');
    const rolloutStateFile = requiredPath(parsed, 'rollout-state');
    const stateFile = requiredPath(parsed, 'state');
    const currentRetentionState = normalizeGcState(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    if (JSON.stringify(currentRetentionState) !== JSON.stringify(expectedRetentionState))
    {
        throw new Error('durable retention state changed after GC planning');
    }
    return verifyArtifactGcActiveIdentity({
        authority: readDestructiveOperationAuthority(parsed.authority),
        slotState: readSlotState(slotStateFile, { allowMissing: false }),
        rolloutState: readRolloutState(rolloutStateFile),
        retentionState: currentRetentionState
    });
}

function readReviewedDryRun(parsed, storeDirectory)
{
    const reviewedFile = requiredPath(parsed, 'reviewed-dry-run');
    const evidence = JSON.parse(fs.readFileSync(reviewedFile, 'utf8'));
    if (path.resolve(evidence.storeDirectory ?? '') !== storeDirectory)
    {
        throw new Error('GC reviewed dry-run evidence store does not match the requested store');
    }
    return evidence;
}

function requiredPath(parsed, name)
{
    if (!parsed[name])
    {
        throw new Error(`GC apply requires --${name}`);
    }
    return path.resolve(parsed[name]);
}

function readLiveRuntimeProtection(parsed, slotStateFile) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const environmentFile = path.resolve(parsed['environment-file'] ?? path.join(repositoryRoot, '.env.production'))
  const env = { ...process.env, FSUSBLOG_PRODUCTION_ENV_FILE: environmentFile,
    FSUSBLOG_PRODUCTION_COMPOSE_FILE: path.join(repositoryRoot, 'ops/docker/docker-compose.production.yml') }
  const authority = observeRuntimeRoleDeploymentAuthority({ root: repositoryRoot })
  const state = readSlotState(slotStateFile, { allowMissing: false })
  const status = readCommandJson('bash', [path.join(repositoryRoot, 'tools/deployment/slot-status.sh'), '--state-file', slotStateFile], env)
  if (status.schema !== 'fsusblog.deployment-slot-status.v1'
      || status.activeStateConsistent !== true || status.runtimeGenerationsConsistent !== true) {
    throw new Error('live slot status is inconsistent with durable identity')
  }
  const slots = {}
  const manifestReferences = {}
  const manifestIdentities = {}
  for (const slot of ['blue', 'green']) {
    const manifestFile = requiredPath(parsed, `${slot}-manifest`)
    manifestReferences[slot] = durableFileReference(manifestFile)
    const manifest = readReleaseManifest(manifestFile, {
      expectedReleaseId: state.slots[slot]?.releaseId,
      expectedImageDigest: state.slots[slot]?.imageDigest
    })
    manifestIdentities[slot] = { releaseId: manifest.releaseId, commitSha: manifest.commitSha,
      imageDigest: manifest.imageDigest, currentSchema: manifest.currentSchema }
    const runtime = status.slots?.[slot]
    if (!runtime?.exists || runtime.running !== true || runtime.identityMatchesSlot !== true
        || runtime.readiness !== 'ok' || runtime.liveness !== 'ok'
        || runtime.release?.commitSha !== manifest.commitSha) {
      throw new Error(`live ${slot} status/commit is not admitted by its release manifest`)
    }
    const containers = readCommandJson('docker', ['inspect', '--type', 'container', runtime.containerName], env)
    const images = readCommandJson('docker', ['image', 'inspect', manifest.imageRef], env)
    if (!Array.isArray(containers) || containers.length !== 1 || !Array.isArray(images) || images.length !== 1) {
      throw new Error(`live ${slot} engine identity is ambiguous`)
    }
    const compose = readCommandJson('bash', ['-c',
      'source "$1"; SlotConfigure "$2"; SlotLoadManifest "$3" "$2"; export FSUSBLOG_RELEASE_MANIFEST_HOST_PATH="$3"; SlotCompose config --format json',
      'runtime-role-readonly', path.join(repositoryRoot, 'tools/deployment/slot-common.sh'), slot, manifestFile], env)
    slots[slot] = { container: containers[0], image: images[0], compose,
      releaseId: manifest.releaseId, imageDigest: manifest.imageDigest }
  }
  return {
    authorityDigest: authority.authorityContentDigest,
    environmentReference: durableFileReference(environmentFile),
    manifestReferences,
    manifestIdentities,
    slots: verifyRuntimeRoleLiveContainers({ authority, slots })
  }
}

function readCommandJson(command, args, env) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`read-only runtime observation command failed: ${command}`)
  return JSON.parse(result.stdout)
}


function hasInheritedDeploymentLock(parsed)
{
    const descriptor = process.env.FSUSBLOG_DEPLOYMENT_LOCK_FD;
    if (!/^[0-9]+$/u.test(descriptor ?? ''))
    {
        return false;
    }
    const deploymentLock = path.resolve(parsed['deployment-lock']
    ?? process.env.FSUSBLOG_DEPLOYMENT_LOCK_FILE
    ?? '/var/lock/fsusblog-deployment.lock');
    try
    {
        return fs.realpathSync(`/proc/self/fd/${descriptor}`) === fs.realpathSync(deploymentLock);
    }
    catch
    {
        throw new Error('inherited deployment lock descriptor is invalid');
    }
}
