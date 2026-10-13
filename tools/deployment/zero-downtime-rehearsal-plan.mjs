#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { isValidReleaseId } from '../release/release-id.mjs';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { processGroupOrJobIdentityMatches } from '../test/process-identity.mjs';
import { loadPhysicalExecutionProcessPolicy, terminatePhysicalExecutionAuthoritySync } from '../test/physical-execution-process-tree.mjs';

export const CURRENT_REHEARSAL_PLAN_SCHEMA = 'fsusblog.zero-downtime-rehearsal-plan.v2';
const CURRENT_INPUT_FLAGS = Object.freeze({
  backupRestore: '--backup-restore-evidence', productionBuildReceipt: '--production-build-receipt',
  trafficScenario: '--traffic-scenario', trafficBindingKey: '--traffic-binding-key-file',
  notificationAuthStorageState: '--notification-auth-storage-state',
  assetScenario: '--asset-compatibility-scenario', assetBrowserBindingKey: '--asset-browser-binding-key-file',
  workerLedger: '--worker-ledger', faultInjection: '--fault-injection-evidence',
  challengeKindTargetMap: '--challenge-kind-target-map',
  perceptionReleaseTarget: '--perception-v3-release-target', perceptionPoolManifest: '--perception-v3-pool-manifest'
});

function exactCurrentFields(value, fields, label) {
  object(value, label);
  const actual = Object.keys(value).sort();
  if (!isDeepStrictEqual(actual, [...fields].sort())) fail(`${label} fields are not the exact current contract`);
}

function currentFileBytes(file, maximum = Number.MAX_SAFE_INTEGER) {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) fail('current input must be an absolute canonical file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum)) fail('current input must be a bounded regular file');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) fail('current input ended early');
      offset += read;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('current input changed while reading');
    return bytes;
  } finally { fs.closeSync(fd); }
}

function currentWholeSha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

/** Operational inputs only: never load a sealed migration plan, journal, or historical DTO. */
export async function resolveCurrentRehearsalPlan(raw, context) {
  exactCurrentFields(raw, ['schema', 'environment', 'nonProductionOnly', 'acknowledgement', 'rehearsalId',
    'workRoot', 'publicUrl', 'controlOrigin', 'envFile', 'adminHeaderFile', 'source', 'target',
    'runtime', 'rollout', 'evidenceInputs', 'notificationResyncScenario', 'perceptionPolicyVersion', 'timeoutSeconds'], 'current plan');
  if (raw.schema !== CURRENT_REHEARSAL_PLAN_SCHEMA) fail(`current plan schema must be ${CURRENT_REHEARSAL_PLAN_SCHEMA}`);
  if (raw.environment !== 'Test' || raw.nonProductionOnly !== true
    || raw.acknowledgement !== 'DESTROY_ISOLATED_LOCAL_REHEARSAL_ONLY') fail('current rehearsal must be explicitly non-production Test');
  const repoRoot = canonicalDirectory(context.repoRoot, 'repository root');
  const planFile = canonicalFile(context.planFile, 'plan file');
  const planBytes = currentFileBytes(planFile);
  if (!isDeepStrictEqual(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(planBytes)), raw)) fail('current plan bytes differ from the parsed input');
  const rehearsalId = safeId(raw.rehearsalId, 'rehearsalId');
  const publicUrl = localUrl(raw.publicUrl, '/health/ready', 'publicUrl');
  const controlOrigin = localUrl(raw.controlOrigin, null, 'controlOrigin');
  if (new URL(publicUrl).origin !== new URL(controlOrigin).origin) fail('current control/public origins differ');
  const workRoot = resolveFrom(planFile, raw.workRoot);
  ensureWithin(workRoot, path.join(repoRoot, '.tmp'), 'current workRoot');
  if (workRoot === path.join(repoRoot, '.tmp')) fail('current workRoot must be a dedicated child');
  assertNoSymlinkTraversal(workRoot, repoRoot, 'current workRoot');
  const envFile = privateMaterialFile(planFile, raw.envFile, 'envFile');
  assertTestEnvironment(envFile, publicUrl);
  const adminHeaderFile = privateMaterialFile(planFile, raw.adminHeaderFile, 'adminHeaderFile');
  assertPrivateAdminHeader(adminHeaderFile);
  const { validateReleaseManifest, readCurrentSchemaReleaseBinding } = await import('../release/release-manifest.mjs');
  const manifests = {};
  for (const role of ['source', 'target']) {
    exactCurrentFields(raw[role], ['manifest', 'sha256'], `current ${role}`);
    if (typeof raw[role].sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(raw[role].sha256)) fail(`${role} whole manifest SHA is invalid`);
    const file = materialFile(planFile, raw[role].manifest, `${role}.manifest`);
    const bytes = currentFileBytes(file);
    if (currentWholeSha(bytes) !== raw[role].sha256) fail(`${role} whole manifest SHA mismatch`);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const errors = validateReleaseManifest(value, { requireRegistryDigest: true, requireConcreteRuntimeProfile: true });
    if (errors.length) fail(errors.join('\n'));
    const binding = readCurrentSchemaReleaseBinding(value.currentSchema.receipt.reference, value.currentSchema.receipt.sha256);
    if (!isDeepStrictEqual(binding, value.currentSchema)) fail(`${role} manifest/current receipt binding mismatch`);
    if (envFile.includes(',') || value.currentSchema.receipt.reference.includes(',')) fail('current Docker mount source cannot contain commas');
    manifests[role] = { file, sha256: raw[role].sha256, value };
  }
  if (manifests.source.value.releaseId === manifests.target.value.releaseId
    || manifests.source.value.imageDigest === manifests.target.value.imageDigest) fail('current source/target releases must differ');
  for (const field of ['target', 'database', 'actualSchemaDigest']) {
    if (!isDeepStrictEqual(manifests.source.value.currentSchema[field], manifests.target.value.currentSchema[field])) {
      fail(`current source/target ${field} differ; an old image cannot share the current database`);
    }
  }
  exactCurrentFields(raw.runtime, ['directory', 'slotState'], 'current runtime');
  const runtime = canonicalDirectory(resolveFrom(planFile, raw.runtime.directory), 'current runtime directory');
  ensureWithin(runtime, workRoot, 'current runtime');
  const slotState = materialFile(planFile, raw.runtime.slotState, 'current slot state');
  ensureWithin(slotState, runtime, 'current slot state');
  assertNoSymlinkTraversal(runtime, repoRoot, 'current runtime');
  exactCurrentFields(raw.rollout, ['id', 'stateFile', 'evidenceRoot', 'assetStore', 'retentionState'], 'current rollout');
  if (typeof raw.rollout.id !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/u.test(raw.rollout.id)) fail('current rollout id is invalid');
  const outputs = {};
  for (const key of ['stateFile', 'evidenceRoot', 'assetStore', 'retentionState']) {
    outputs[key] = resolveFrom(planFile, raw.rollout[key]);
    ensureWithin(outputs[key], workRoot, `current ${key}`);
    if (outputs[key] === workRoot) fail(`current ${key} must be a dedicated child`);
    assertNoSymlinkTraversal(outputs[key], repoRoot, `current ${key}`);
  }
  exactCurrentFields(raw.evidenceInputs, Object.keys(CURRENT_INPUT_FLAGS), 'current evidence inputs');
  const inputs = {};
  for (const key of Object.keys(CURRENT_INPUT_FLAGS)) {
    inputs[key] = key.endsWith('Key') || key === 'notificationAuthStorageState'
      ? privateMaterialFile(planFile, raw.evidenceInputs[key], `evidenceInputs.${key}`)
      : materialFile(planFile, raw.evidenceInputs[key], `evidenceInputs.${key}`);
  }
  for (const key of ['trafficBindingKey', 'assetBrowserBindingKey']) {
    const bytes = fs.statSync(inputs[key]).size;
    if (bytes < 32 || bytes > 4096) fail(`${key} must contain 32..4096 bytes`);
  }
  const notificationResyncScenario = materialFile(planFile, raw.notificationResyncScenario, 'notification resync scenario');
  if (readJson(notificationResyncScenario, 'notification resync scenario').schema !== 'fsusblog.release-notification-resync-scenario.v1') fail('notification resync scenario schema is invalid');
  if (typeof raw.perceptionPolicyVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(raw.perceptionPolicyVersion)) fail('perception policy version is invalid');
  const timeoutSeconds = boundedInteger(raw.timeoutSeconds, 10, 1800, 'current timeoutSeconds');
  const { readSlotState } = await import('./slot-lib.mjs');
  const slot = readSlotState(slotState, { allowMissing: false });
  if (!['source', 'target'].some(role => slot.activeReleaseId === manifests[role].value.releaseId
    && slot.activeImageDigest === manifests[role].value.imageDigest)) fail('current active slot is not bound to either explicit current manifest');
  return { schema: 'fsusblog.zero-downtime-rehearsal-resolved-plan.v2', rehearsalId, repoRoot, planFile,
    planSha256: currentWholeSha(planBytes), workRoot, publicUrl, controlOrigin,
    envFile, adminHeaderFile, manifests, runtime, slotState, rolloutId: raw.rollout.id, outputs,
    privateInputs: [envFile, adminHeaderFile].map(file => ({ file, sha256: currentWholeSha(currentFileBytes(file)), mode: fs.statSync(file).mode & 0o777 })),
    inputs, notificationResyncScenario, perceptionPolicyVersion: raw.perceptionPolicyVersion, timeoutSeconds };
}

function currentProcIdentity(pid, procRoot = '/proc') {
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    const bootId = fs.readFileSync(path.join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim();
    if (!/^\d+$/u.test(tail[19] ?? '') || !bootId) fail('current command kernel identity is incomplete');
    return { pid, state: tail[0], processGroupId: Number(tail[2]), sessionId: Number(tail[3]),
      processStartIdentity: `linux:${bootId}:${tail[19]}` };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}

/** Only kernel group/start identity and an inherited invocation nonce; never a full executable-digest claim. */
export function observeCurrentCommandGroup(authority, ownerToken, { procRoot = '/proc', knownStarts = new Map() } = {}) {
  try {
    const leader = currentProcIdentity(authority.leaderPid, procRoot);
    if (leader && (leader.sessionId !== authority.groupId || !processGroupOrJobIdentityMatches(authority, { ...authority,
      groupId: leader.processGroupId, leaderProcessStartIdentity: leader.processStartIdentity }))) fail('current command leader identity changed');
    const identities = [];
    for (const entry of fs.readdirSync(procRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
      const before = currentProcIdentity(Number(entry.name), procRoot);
      if (!before || before.processGroupId !== authority.groupId || before.state === 'Z') continue;
      const environment = fs.readFileSync(path.join(procRoot, entry.name, 'environ'), 'utf8').split('\0');
      const after = currentProcIdentity(before.pid, procRoot);
      if (!after) continue;
      if (after.state === 'Z') continue;
      if (after.processStartIdentity !== before.processStartIdentity || after.processGroupId !== authority.groupId
        || after.sessionId !== authority.groupId
        || !environment.includes(`FSUSBLOG_CURRENT_REHEARSAL_COMMAND_OWNER=${ownerToken}`)
        || (knownStarts.has(after.pid) && knownStarts.get(after.pid) !== after.processStartIdentity)) fail('current command group ownership is unconfirmed');
      knownStarts.set(after.pid, after.processStartIdentity);
      identities.push(after);
    }
    return { status: 'verified', identities };
  } catch (error) {
    return { status: 'unverifiable', identities: [], reason: message(error) };
  }
}

async function currentCommand(command, args, options) {
  if (process.platform !== 'linux') fail('current command requires verifiable Linux process-group ownership');
  const policy = loadPhysicalExecutionProcessPolicy();
  return new Promise(resolve => {
    const stdoutFd = fs.openSync(options.stdoutPath, 'wx', 0o600);
    const stderrFd = fs.openSync(options.stderrPath, 'wx', 0o600);
    const stdoutHash = crypto.createHash('sha256'), stderrHash = crypto.createHash('sha256');
    const ownerToken = crypto.randomUUID();
    const child = spawn(command, args, { cwd: options.cwd,
      env: { ...options.env, FSUSBLOG_CURRENT_REHEARSAL_COMMAND_OWNER: ownerToken }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let failure = null, closed = false, finishing = false, pipeTimer = null;
    let authority = null, termination = null;
    const knownStarts = new Map();
    try {
      const initial = currentProcIdentity(child.pid);
      if (!initial || initial.processGroupId !== child.pid || initial.sessionId !== child.pid) fail('spawned current command group identity is unconfirmed');
      knownStarts.set(child.pid, initial.processStartIdentity);
      authority = { schema: 'fsusblog.process-group-or-job-identity.v1', platform: 'linux', kind: 'process-group',
        groupId: child.pid, leaderPid: child.pid, leaderProcessStartIdentity: initial.processStartIdentity };
    } catch (error) { failure = error; }
    const collectMembers = () => authority
      ? observeCurrentCommandGroup(authority, ownerToken, { knownStarts })
      : { status: 'unverifiable', identities: [], reason: 'spawn identity was not established' };
    const terminate = () => {
      if (closed || !authority) return;
      termination = terminatePhysicalExecutionAuthoritySync({ authority, reason: 'current-rehearsal-owned-command', policy,
        collectMembers, validateMembers: () => ({ status: 'verified' }) });
      if (!termination.terminated || termination.postObservation !== 'zero-members') {
        failure ??= new Error(`current command termination unconfirmed: ${termination.reason}`);
      }
    };
    const boundPipeClosure = () => {
      if (closed || pipeTimer !== null) return;
      pipeTimer = setTimeout(() => {
        if (closed) return;
        failure ??= new Error('current command pipes did not close within the original process policy');
        terminate();
        // An unconfirmed inventory remains a failure, never a successful terminal. Closing our
        // readers cannot prove an escaped process absent; retain the observed authority below.
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        complete(null, null);
      }, policy.pipeCloseTimeoutMs);
    };
    const onSignal = () => { failure ??= new Error('current rehearsal interrupted'); terminate(); boundPipeClosure(); };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal);
    const timer = setTimeout(() => { failure ??= new Error('current rehearsal command timed out'); terminate(); boundPipeClosure(); }, options.timeoutSeconds * 1000);
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', chunk => {
      if (closed) return;
      try {
        fs.writeFileSync(key === 'stdout' ? stdoutFd : stderrFd, chunk);
        (key === 'stdout' ? stdoutHash : stderrHash).update(chunk);
      } catch (error) {
        failure ??= error; terminate(); boundPipeClosure();
      }
    });
    const cleanup = () => {
      clearTimeout(timer);
      if (pipeTimer !== null) clearTimeout(pipeTimer);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, onSignal);
      fs.closeSync(stdoutFd); fs.closeSync(stderrFd);
    };
    child.once('error', error => { failure ??= error; });
    child.once('exit', () => {
      const observed = collectMembers();
      if (observed.status === 'verified' && observed.identities.length > 0) {
        failure ??= new Error('current command leader exited with live group members');
        terminate();
      } else if (observed.status !== 'verified') {
        failure ??= new Error(`current command exit inventory unconfirmed: ${observed.reason}`);
      }
      boundPipeClosure();
    });
    const complete = async (exitCode, signal) => {
      if (closed || finishing) return;
      finishing = true;
      const initial = collectMembers();
      if (initial.status === 'verified' && initial.identities.length > 0) {
        failure ??= new Error('current command leader closed with live group members');
        terminate();
      }
      let zeroObservations = 0;
      for (let index = 0; index < policy.zeroMemberObservations; index += 1) {
        const observed = collectMembers();
        if (observed.status !== 'verified' || observed.identities.length !== 0) {
          failure ??= new Error(`current command group terminal unconfirmed: ${observed.reason ?? 'live members remain'}`);
          break;
        }
        zeroObservations += 1;
        if (index + 1 < policy.zeroMemberObservations) await delay(policy.observationIntervalMs);
      }
      closed = true; cleanup(); resolve({ command, args, pid: child.pid, exitCode, signal,
        processGroup: { authority, ownerToken, zeroObservations, termination,
          postObservation: zeroObservations === policy.zeroMemberObservations ? 'zero-members' : 'unverifiable' },
        stdoutSha256: stdoutHash.digest('hex'), stderrSha256: stderrHash.digest('hex'), failure: failure?.message ?? null });
    };
    child.once('close', complete);
  });
}

/** Fresh pinned Server read-only observations; no offline migration command is ever executed. */
export async function runCurrentRehearsal(resolved, { mode, runId }) {
  if (!['normal', 'resume'].includes(mode)) fail('current rehearsal mode must be normal or resume; image rollback is retired');
  if (resolved.schema !== 'fsusblog.zero-downtime-rehearsal-resolved-plan.v2') fail('resolved current rehearsal schema is invalid');
  if (typeof runId !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._-]{2,47}$/u.test(runId) || runId.includes('..')) fail('current run id is invalid');
  const { readRolloutState } = await import('./release-rollout-lib.mjs');
  const { readSlotState } = await import('./slot-lib.mjs');
  const active = readSlotState(resolved.slotState, { allowMissing: false });
  if (mode === 'normal' && (active.activeReleaseId !== resolved.manifests.source.value.releaseId
    || active.activeImageDigest !== resolved.manifests.source.value.imageDigest)) fail('normal current slot must match the explicit source manifest');
  if (mode === 'normal' && fs.existsSync(resolved.outputs.stateFile)) fail('normal current state already exists; use explicit resume');
  if (mode === 'resume') {
    const state = readRolloutState(resolved.outputs.stateFile);
    const target = resolved.manifests.target;
    if (state.rolloutId !== resolved.rolloutId || state.manifestSha256 !== target.sha256
      || state.candidateSourceRevision !== target.value.commitSha
      || !isDeepStrictEqual(state.currentSchema, target.value.currentSchema)
      || state.target.releaseId !== target.value.releaseId || state.target.imageDigest !== target.value.imageDigest
      || state.source.releaseId !== resolved.manifests.source.value.releaseId
      || state.source.imageDigest !== resolved.manifests.source.value.imageDigest) fail('resume current bindings differ');
  }
  const runRoot = path.join(resolved.workRoot, resolved.rehearsalId, runId);
  assertNoSymlinkTraversal(runRoot, resolved.repoRoot, 'current run root');
  fs.mkdirSync(path.dirname(runRoot), { recursive: true, mode: 0o700 });
  fs.mkdirSync(runRoot, { mode: 0o700 });
  const commands = [], errors = [];
  const command = async (name, binary, args, env = process.env, { allowFailure = false, stdoutMaximum = null, timeoutSeconds = resolved.timeoutSeconds } = {}) => {
    const stdout = path.join(runRoot, `${commands.length}-${name}.stdout`);
    const stderr = path.join(runRoot, `${commands.length}-${name}.stderr`);
    const result = await currentCommand(binary, args, { cwd: resolved.repoRoot, env, timeoutSeconds, stdoutPath: stdout, stderrPath: stderr });
    commands.push({ name, command: binary, args, pid: result.pid, exitCode: result.exitCode, signal: result.signal,
      failure: result.failure, processGroup: result.processGroup, stdout: { path: stdout, sha256: result.stdoutSha256 },
      stderr: { path: stderr, sha256: result.stderrSha256 } });
    if (!allowFailure && (result.failure || result.exitCode !== 0)) fail(`${name} failed: ${result.failure ?? result.exitCode ?? result.signal}`);
    // Only bounded typed stdout is read. stderr and release/rm output stay in their original raw files.
    if (!result.failure && result.exitCode === 0 && stdoutMaximum !== null) {
      result.stdout = new TextDecoder('utf-8', { fatal: true }).decode(currentFileBytes(stdout, stdoutMaximum));
    }
    return result;
  };
  const verifyInputsUnchanged = () => {
    if (currentWholeSha(currentFileBytes(resolved.planFile)) !== resolved.planSha256) fail('current operational plan changed');
    for (const input of resolved.privateInputs) {
      if (currentWholeSha(currentFileBytes(input.file)) !== input.sha256
        || (fs.statSync(input.file).mode & 0o777) !== input.mode) fail('current private input changed');
    }
  };
  let releaseEvidence = null;
  try {
    verifyInputsUnchanged();
    const { validateCurrentSchemaAdmissionOutput } = await import('../release/release-manifest-value-contract.mjs');
    const { readCurrentSchemaReleaseBinding } = await import('../release/release-manifest.mjs');
    for (const role of ['source', 'target']) {
      const manifest = resolved.manifests[role];
      const receipt = manifest.value.currentSchema.receipt;
      if (currentWholeSha(currentFileBytes(manifest.file)) !== manifest.sha256) fail(`${role} manifest changed before admission`);
      if (!isDeepStrictEqual(readCurrentSchemaReleaseBinding(receipt.reference, receipt.sha256), manifest.value.currentSchema)) fail(`${role} receipt changed before admission`);
      const name = `fsusblog-zdt-current-${crypto.randomUUID()}`;
      let container = null;
      try {
        const created = (await command(`${role}-create`, 'docker', ['create', '--name', name,
          '--label', `io.fsusblog.rehearsal.owner=${name}`, '--network', 'fsus-infra-network',
          '--mount', `type=bind,source=${resolved.envFile},target=/run/current/production.env,readonly`,
          '--mount', `type=bind,source=${receipt.reference},target=/run/current/receipt.json,readonly`,
          '--entrypoint', '/app/FsusBlog.Server', manifest.value.imageRef,
          'current-schema-check', '--env-file', '/run/current/production.env', '--receipt', '/run/current/receipt.json',
          '--receipt-sha256', receipt.sha256, '--candidate-source-revision', manifest.value.commitSha], process.env, { stdoutMaximum: 65 })).stdout.trim();
        if (!/^[0-9a-f]{64}$/u.test(created)) fail('admission container ID is invalid');
        container = created;
        // The sole Server projects six fields from the original <=1MiB Shared receipt codec; no new global log limit.
        const output = JSON.parse((await command(`${role}-admission`, 'docker', ['start', '--attach', container], process.env,
          { stdoutMaximum: 1024 * 1024 })).stdout);
        const bindingErrors = validateCurrentSchemaAdmissionOutput(output, manifest.value.currentSchema, manifest.value.commitSha);
        if (bindingErrors.length) fail(bindingErrors.join('\n'));
        if (currentWholeSha(currentFileBytes(manifest.file)) !== manifest.sha256
          || !isDeepStrictEqual(readCurrentSchemaReleaseBinding(receipt.reference, receipt.sha256), manifest.value.currentSchema)) fail(`${role} references changed during admission`);
      } catch (error) {
        errors.push(message(error));
        throw error;
      } finally {
        // A lost create response is not success. Inspect the uniquely labelled task container before cleanup.
        const format = '{"Id":{{json .Id}},"Name":{{json .Name}},"Owner":{{json (index .Config.Labels "io.fsusblog.rehearsal.owner")}}}';
        const maximum = Buffer.byteLength(JSON.stringify({ Id: 'f'.repeat(64), Name: `/${name}`, Owner: name })) + 1;
        const inspect = await command(`${role}-inspect`, 'docker', ['inspect', '--format', format, name], process.env,
          { allowFailure: true, timeoutSeconds: 30, stdoutMaximum: maximum });
        if (inspect.exitCode === 0 && !inspect.failure) {
          const value = JSON.parse(inspect.stdout);
          const owned = isDeepStrictEqual(Object.keys(value).sort(), ['Id', 'Name', 'Owner'])
            && value.Name === `/${name}` && value.Owner === name && /^[0-9a-f]{64}$/u.test(value.Id)
            && (container === null || container === value.Id);
          if (!owned) fail('admission cleanup ownership is not confirmed');
          await command(`${role}-remove`, 'docker', ['rm', '--force', value.Id]);
        } else fail('admission container absence or cleanup could not be confirmed; inspect failure retained');
      }
    }
    verifyInputsUnchanged();
    const args = ['--release-manifest', resolved.manifests.target.file, '--env-file', resolved.envFile,
      '--slot-state-file', resolved.slotState, '--rollout-state-file', resolved.outputs.stateFile,
      '--rollout-id', resolved.rolloutId, '--evidence-root', resolved.outputs.evidenceRoot,
      '--asset-store', resolved.outputs.assetStore, '--retention-state', resolved.outputs.retentionState,
      '--public-url', resolved.publicUrl, '--control-origin', resolved.controlOrigin,
      '--admin-header-file', resolved.adminHeaderFile, '--perception-v3-policy-version', resolved.perceptionPolicyVersion];
    for (const [key, flag] of Object.entries(CURRENT_INPUT_FLAGS)) args.push(flag, resolved.inputs[key]);
    if (mode === 'resume') args.push('--resume');
    const runtime = resolved.runtime;
    const env = { ...process.env, ASPNETCORE_ENVIRONMENT: 'Test', FSUSBLOG_ROLLOUT_REHEARSAL: '1',
      FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE: '1', FSUSBLOG_REHEARSAL_WORK_DIR: runtime,
      FSUSBLOG_REHEARSAL_SLOT_STATE_FILE: resolved.slotState, FSUSBLOG_SLOT_STATE_FILE: resolved.slotState,
      FSUSBLOG_REHEARSAL_GATEWAY_DIR: path.join(runtime, 'gateway'),
      FSUSBLOG_REHEARSAL_GATEWAY_CONFIG: path.join(runtime, 'gateway', 'openresty.conf'),
      FSUSBLOG_GATEWAY_ACTIVE_UPSTREAM: path.join(runtime, 'gateway', 'active-upstream.conf'),
      FSUSBLOG_GATEWAY_CONFIG_FILE: path.join(runtime, 'gateway', 'openresty.conf'),
      FSUSBLOG_OPENRESTY_BIN: path.join(resolved.repoRoot, 'tools/deployment/rehearsal-openresty.sh'),
      FSUSBLOG_DEPLOYMENT_LOCK_FILE: path.join(runtime, 'deployment.lock'),
      FSUSBLOG_GATEWAY_EVIDENCE_DIR: path.join(runtime, 'gateway-evidence'),
      FSUSBLOG_ROLLOUT_DISK_PATH: runtime, FSUSBLOG_ROLLOUT_SOURCE_MANIFEST: resolved.manifests.source.file,
      FSUSBLOG_ROLLOUT_NOTIFICATION_RESYNC_SCENARIO: resolved.notificationResyncScenario };
    await command('current-release', 'bash', [path.join(resolved.repoRoot, 'tools/deployment/release-rollout.sh'), ...args], env);
    verifyInputsUnchanged();
    for (const manifest of Object.values(resolved.manifests)) {
      if (currentWholeSha(currentFileBytes(manifest.file)) !== manifest.sha256
        || !isDeepStrictEqual(readCurrentSchemaReleaseBinding(manifest.value.currentSchema.receipt.reference,
          manifest.value.currentSchema.receipt.sha256), manifest.value.currentSchema)) fail('current manifest or receipt changed during release');
    }
    const state = readRolloutState(resolved.outputs.stateFile);
    if (state.status !== 'completed' || state.outcome !== 'succeeded' || state.rolloutId !== resolved.rolloutId) fail('current release did not durably complete');
    const file = path.join(resolved.outputs.evidenceRoot, resolved.rolloutId, 'evidence', 'release-rollout.json');
    const bytes = currentFileBytes(file);
    const value = JSON.parse(bytes.toString('utf8'));
    const { verifyReleaseRolloutEvidence } = await import('./release-rollout-evidence-verifier.mjs');
    const replay = verifyReleaseRolloutEvidence(value, { evidencePath: file, readBytes: currentFileBytes, now: Date.now() });
    if (replay.status !== 'pass') fail(replay.errors.join('\n'));
    const target = resolved.manifests.target;
    const source = resolved.manifests.source;
    if (value.rolloutId !== state.rolloutId || state.finalEvidencePath !== file
      || !isDeepStrictEqual(value.source, state.source) || !isDeepStrictEqual(value.target, state.target)
      || state.source.releaseId !== source.value.releaseId || state.source.imageDigest !== source.value.imageDigest
      || state.target.releaseId !== target.value.releaseId || state.target.imageDigest !== target.value.imageDigest
      || value.manifestSha256 !== target.sha256 || value.candidateSourceRevision !== target.value.commitSha
      || !isDeepStrictEqual(value.currentSchema, target.value.currentSchema)
      || state.manifestSha256 !== target.sha256 || state.candidateSourceRevision !== target.value.commitSha
      || !isDeepStrictEqual(state.currentSchema, target.value.currentSchema)) fail('completed current evidence bindings differ');
    releaseEvidence = { path: file, sha256: currentWholeSha(bytes), verification: replay };
  } catch (error) { errors.push(message(error)); }
  const report = { schema: 'fsusblog.zero-downtime-rehearsal-summary.v2', scope: 'current-release-consumption',
    status: errors.length ? 'fail' : 'pass', mode, runId, rehearsalId: resolved.rehearsalId,
    plan: { reference: resolved.planFile, sha256: resolved.planSha256 },
    source: resolved.manifests.source, target: resolved.manifests.target, commands, releaseEvidence, errors,
    completedAtUtc: new Date().toISOString() };
  fs.writeFileSync(path.join(runRoot, 'rehearsal-summary.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return report;
}

export const REHEARSAL_PLAN_SCHEMA = 'fsusblog.zero-downtime-rehearsal-plan.v1';
export const RESOLVED_PLAN_SCHEMA = 'fsusblog.zero-downtime-rehearsal-resolved-plan.v1';
export const MODE_EVIDENCE_SCHEMA = 'fsusblog.zero-downtime-rehearsal-mode-evidence.v1'

export const ROLLOUT_STAGES = Object.freeze([
  'manifest-validate',
  'capacity-preflight',
  'backup-restore-gate',
  'expand-migration',
  'asset-materialize',
  'candidate-start',
  'candidate-readiness',
    'candidate-smoke',
    'compatibility-smoke',
    'gateway-switch',
    'source-drain',
    'active-fence',
    'public-verify',
    'source-stop',
    'release-evidence'
]);

export const HOST_INTERRUPTION_STAGES = Object.freeze([
  'source-drain',
  'source-stop',
  'release-evidence'
])

export const FAULT_CASES = Object.freeze([
  'manifest-digest-mismatch',
  'capacity-insufficient',
  'expand-failure',
  'candidate-readiness',
  'asset-hash-mismatch',
  'gateway-reload-failure',
  'active-fence-failure',
  'public-probe-failure',
  'drain-timeout',
  'source-stop-failure',
  'host-interruption',
  'redis-disconnect',
  'postgres-disconnect'
])
export const MIGRATION_QUALIFICATION_CASES = Object.freeze([
  'expand-with-old-active',
  'blue-green-concurrent-read-write',
  'backfill-checkpoint-resume',
  'missing-expand-candidate-not-ready',
  'contract-rollback-window-rejected',
  'contract-applied-non-rollback-compatible',
  'advisory-lock-timeout',
  'database-disconnect',
  'partial-failure-recovery',
    'history-integrity-rejected'
]);

const MODES = new Set(['normal', 'explicit-rollback', 'post-switch-rollback', 'sigkill-resume']);
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{2,127}$/u;
const NORMAL_WORKER_KINDS = Object.freeze([
  'scheduled-publish',
  'article-mutation-outbox',
  'audit-writer',
  'visit-view-projection',
  'public-hot-aot',
  'upload-cleanup',
  'active-singleton-control',
  'multi-consumer-safe-control'
])

export function resolveRehearsalPlan(raw, context) {
  object(raw, 'plan')
  if (raw.schema !== REHEARSAL_PLAN_SCHEMA) fail(`plan schema must be ${REHEARSAL_PLAN_SCHEMA}`)
  if (raw.nonProductionOnly !== true || raw.environment !== 'Test') {
    fail('rehearsal plan must be explicitly non-production and use environment Test')
  }
  if (raw.acknowledgement !== 'DESTROY_ISOLATED_LOCAL_REHEARSAL_ONLY') {
    fail('local destructive rehearsal acknowledgement is missing')
  }

  const planFile = canonicalFile(context.planFile, 'plan file')
  const repoRoot = canonicalDirectory(context.repoRoot, 'repository root')
  const rehearsalId = safeId(raw.rehearsalId, 'rehearsalId')
  const publicUrl = localUrl(raw.publicUrl, '/health/ready', 'publicUrl')
  const controlOrigin = localUrl(raw.controlOrigin ?? new URL(publicUrl).origin, null, 'controlOrigin')
  const publicPort = boundedInteger(raw.publicPort ?? Number(new URL(publicUrl).port), 1024, 65535, 'publicPort')
  if (Number(new URL(publicUrl).port) !== publicPort) fail('publicPort must match publicUrl')
  if (new URL(publicUrl).origin !== new URL(controlOrigin).origin) fail('controlOrigin must match publicUrl origin')

  const workRoot = resolveFrom(planFile, raw.workRoot)
  const allowedWorkRoot = path.join(repoRoot, '.tmp')
  ensureWithin(workRoot, allowedWorkRoot, 'workRoot')
  if (workRoot === allowedWorkRoot) fail('workRoot must be a dedicated child of repository .tmp')
  assertNoSymlinkTraversal(allowedWorkRoot, repoRoot, 'repository .tmp')
  assertNoSymlinkTraversal(workRoot, repoRoot, 'workRoot')
  assertNoSymlinkTraversal(path.join(workRoot, rehearsalId), repoRoot, 'rehearsal root')

  const envFile = privateMaterialFile(planFile, raw.envFile, 'envFile')
  assertTestEnvironment(envFile, publicUrl)
  const adminHeaderFile = privateMaterialFile(planFile, raw.adminHeaderFile, 'adminHeaderFile')
  assertPrivateAdminHeader(adminHeaderFile)
  const notificationAuthStorageState = privateMaterialFile(
    planFile,
    raw.notificationAuthStorageState,
    'notificationAuthStorageState')

  object(raw.source, 'source')
  object(raw.target, 'target')
  if (raw.source.slot !== 'blue' || raw.target.slot !== 'green') {
    fail('rehearsal topology is fixed to source blue and target green')
  }
  const sourceManifest = releaseManifest(materialFile(planFile, raw.source.manifest, 'source.manifest'), 'source manifest')
  const targetManifest = releaseManifest(materialFile(planFile, raw.target.manifest, 'target.manifest'), 'target manifest')
  const sourcePreviousRollbackRelease = safeId(
    raw.source.previousRollbackRelease,
    'source.previousRollbackRelease')
  if (sourcePreviousRollbackRelease === sourceManifest.releaseId) {
    fail('source.previousRollbackRelease must differ from source releaseId')
  }
  if (sourceManifest.releaseId === targetManifest.releaseId || sourceManifest.imageDigest === targetManifest.imageDigest) {
    fail('source and target manifests must identify different immutable releases')
  }

  object(raw.evidenceInputs, 'evidenceInputs')
  const backupRestore = materialFile(planFile, raw.evidenceInputs.backupRestore, 'evidenceInputs.backupRestore')
  const trafficScenario = materialFile(planFile, raw.evidenceInputs.trafficScenario, 'evidenceInputs.trafficScenario')
  const trafficBindingKey = privateMaterialFile(
    planFile,
    raw.evidenceInputs.trafficBindingKey,
    'evidenceInputs.trafficBindingKey')
  const trafficBindingKeyBytes = fs.statSync(trafficBindingKey).size
  if (trafficBindingKeyBytes < 32 || trafficBindingKeyBytes > 4096) {
    fail('evidenceInputs.trafficBindingKey must contain 32..4096 bytes')
  }
  const assetBrowserBindingKey = privateMaterialFile(
    planFile,
    raw.evidenceInputs.assetBrowserBindingKey,
    'evidenceInputs.assetBrowserBindingKey')
  const assetBrowserBindingKeyBytes = fs.statSync(assetBrowserBindingKey).size
  if (assetBrowserBindingKeyBytes < 32 || assetBrowserBindingKeyBytes > 4096) {
    fail('evidenceInputs.assetBrowserBindingKey must contain 32..4096 bytes')
  }
  const notificationResyncScenario = materialFile(
    planFile,
    raw.evidenceInputs.notificationResyncScenario,
    'evidenceInputs.notificationResyncScenario')
  if (readJson(notificationResyncScenario, 'notification resync scenario').schema !== 'fsusblog.release-notification-resync-scenario.v1') {
    fail('evidenceInputs.notificationResyncScenario schema is invalid')
  }
  const migrationServerDll = materialFile(planFile, raw.target.migrationServerDll, 'target.migrationServerDll')

  object(raw.migrationQualification, 'migrationQualification')
  const migrationQualificationTemplate = materialFile(
    planFile,
    raw.migrationQualification.scenarioTemplate,
    'migrationQualification.scenarioTemplate')
  const migrationQualificationTimeoutSeconds = boundedInteger(
    raw.migrationQualification.timeoutSeconds ?? 900,
    60,
    1800,
    'migrationQualification.timeoutSeconds')
  const expandMigrationId = safeId(raw.migrationQualification.expandMigrationId, 'migrationQualification.expandMigrationId')
  const backfillMigrationId = safeId(raw.migrationQualification.backfillMigrationId, 'migrationQualification.backfillMigrationId')
  const contractMigrationId = safeId(raw.migrationQualification.contractMigrationId, 'migrationQualification.contractMigrationId')

  object(raw.assets, 'assets')
  const deployAssetScenario = materialFile(planFile, raw.assets.deployScenario, 'assets.deployScenario')
  const rollbackAssetScenario = materialFile(planFile, raw.assets.rollbackScenario, 'assets.rollbackScenario')
  assertAssetScenario(deployAssetScenario, sourceManifest.releaseId, targetManifest.releaseId, 'deploy asset scenario')
  assertAssetScenario(rollbackAssetScenario, targetManifest.releaseId, sourceManifest.releaseId, 'rollback asset scenario')
  const assetStore = resolveFrom(planFile, raw.assets.store)
  const retentionState = resolveFrom(planFile, raw.assets.retentionState)
  ensureWithin(assetStore, workRoot, 'assets.store')
  ensureWithin(retentionState, workRoot, 'assets.retentionState')
  assertNoSymlinkTraversal(assetStore, repoRoot, 'assets.store')
  assertNoSymlinkTraversal(retentionState, repoRoot, 'assets.retentionState')

  object(raw.workers, 'workers')
  const workerTimeoutSeconds = boundedInteger(raw.workers.timeoutSeconds ?? 300, 10, 1800, 'workers.timeoutSeconds')
  const workerObserverEnvFile = privateMaterialFile(
    planFile,
    raw.workers.observerEnvFile,
    'workers.observerEnvFile')
  const workerPhases = {}
  for (const phase of ['deploy', 'rollback', 'resume']) {
    object(raw.workers[phase], `workers.${phase}`)
    const startStage = String(raw.workers[phase].startStage ?? 'public-verify')
    const startIndex = ROLLOUT_STAGES.indexOf(startStage)
    if (startIndex < ROLLOUT_STAGES.indexOf('candidate-start')
      || startIndex > ROLLOUT_STAGES.indexOf('public-verify')) {
      fail(`workers.${phase}.startStage must be candidate-start..public-verify`)
    }
    const scenario = materialFile(planFile, raw.workers[phase].scenario, `workers.${phase}.scenario`)
    const normalScenario = materialFile(planFile, raw.workers[phase].normalScenario, `workers.${phase}.normalScenario`)
    const observerServicePlanFile = materialFile(
      planFile,
      raw.workers[phase].observerServicePlan,
      `workers.${phase}.observerServicePlan`)
    const drill = workerScenario(scenario, `workers.${phase}.scenario`)
    const normal = normalWorkerScenario(normalScenario, `workers.${phase}.normalScenario`)
    const observerServicePlan = workerObserverServicePlan(
      observerServicePlanFile,
      `workers.${phase}.observerServicePlan`)
    if (normal.baseUrl !== observerServicePlan.baseUrl) {
      fail(`workers.${phase}.normalScenario.baseUrl must equal observer service listen origin`)
    }
    if (!drill.allowedHttpOrigins.includes(observerServicePlan.baseUrl)) {
      fail(`workers.${phase}.scenario must allow the observer service listen origin`)
    }
    workerPhases[phase] = {
      ...drill,
      normalScenario: normal,
      observerServicePlan,
      startStage
    }
  }

  object(raw.faults, 'faults')
  const faultPlanTemplate = materialFile(planFile, raw.faults.planTemplate, 'faults.planTemplate')
  const faultTokens = resolveFaultTokens(raw.faults.tokens, planFile, repoRoot, workRoot)

  object(raw.hostInterruption, 'hostInterruption')
  const interruptStages = raw.hostInterruption.stages
  if (!Array.isArray(interruptStages)
    || interruptStages.join('\n') !== HOST_INTERRUPTION_STAGES.join('\n')) {
    fail(`hostInterruption.stages must be the exact ordered late-stage set: ${HOST_INTERRUPTION_STAGES.join(', ')}`)
  }
  const interruptTimeoutSeconds = boundedInteger(
    raw.hostInterruption.timeoutSeconds ?? 180,
    10,
    300,
    'hostInterruption.timeoutSeconds')

  return {
    schema: RESOLVED_PLAN_SCHEMA,
    rehearsalId,
    nonProductionOnly: true,
    environment: 'Test',
    acknowledgement: raw.acknowledgement,
    planFile,
    repoRoot,
    workRoot,
    publicUrl,
    controlOrigin: new URL(controlOrigin).origin,
    publicPort,
    envFile,
    adminHeaderFile,
    notificationAuthStorageState,
    source: {
      slot: 'blue',
      ...sourceManifest,
      previousRollbackRelease: sourcePreviousRollbackRelease
    },
    target: { slot: 'green', ...targetManifest, migrationServerDll },
    evidenceInputs: {
      backupRestore,
      trafficScenario,
      trafficBindingKey,
      assetBrowserBindingKey,
      notificationResyncScenario
    },
    migrationQualification: {
      scenarioTemplate: migrationQualificationTemplate,
      timeoutSeconds: migrationQualificationTimeoutSeconds,
      expandMigrationId,
      backfillMigrationId,
      contractMigrationId
    },
    assets: { deployScenario: deployAssetScenario, rollbackScenario: rollbackAssetScenario, store: assetStore, retentionState },
    workers: { timeoutSeconds: workerTimeoutSeconds, observerEnvFile: workerObserverEnvFile, ...workerPhases },
    faults: { planTemplate: faultPlanTemplate, tokens: faultTokens },
    hostInterruption: { stages: [...HOST_INTERRUPTION_STAGES], timeoutSeconds: interruptTimeoutSeconds }
  }
}

export function materializeMigrationQualificationScenario(resolved, input) {
  assertResolvedPlan(resolved)
  object(input, 'migration qualification materialization input')
  const runRoot = path.resolve(input.runRoot)
  ensureWithin(runRoot, resolved.workRoot, 'migration qualification run root')
  const runtime = path.resolve(input.runtime)
  ensureWithin(runtime, runRoot, 'migration qualification runtime')
  const template = readJson(
    canonicalFile(resolved.migrationQualification.scenarioTemplate, 'migration qualification scenario template'),
    'migration qualification scenario template')
  const databaseIsolationId = safeId(input.databaseIsolationId, 'migration qualification databaseIsolationId')
  if (/prod(?:uction)?/iu.test(databaseIsolationId)) fail('migration qualification databaseIsolationId must be non-production')
  const sourceOrigin = localUrl(input.sourceOrigin, null, 'migration qualification sourceOrigin')
  const targetOrigin = localUrl(input.targetOrigin, null, 'migration qualification targetOrigin')
  if (new URL(sourceOrigin).origin === new URL(targetOrigin).origin) fail('migration qualification source/target origins must differ')
  const replacements = new Map([
    ['REPLACE_DATABASE_ISOLATION_ID', databaseIsolationId],
    ['REPLACE_SOURCE_ORIGIN', new URL(sourceOrigin).origin],
    ['REPLACE_TARGET_ORIGIN', new URL(targetOrigin).origin],
    ['REPLACE_QUALIFICATION_ADAPTER', canonicalFile(path.join(resolved.repoRoot, 'tools/deployment/rehearsal-schema-qualification-probe.mjs'), 'qualification adapter')],
    ['REPLACE_MIGRATION_RUNNER', canonicalFile(path.join(resolved.repoRoot, 'tools/db/run-online-migrations.sh'), 'migration runner')],
    ['REPLACE_SERVER_DLL', canonicalFile(resolved.target.migrationServerDll, 'migration server DLL')],
    ['REPLACE_ENV_FILE', privateMaterialFile(resolved.planFile, input.envFile, 'migration qualification env file')],
    ['REPLACE_ADMIN_HEADER_FILE', privateMaterialFile(resolved.planFile, input.adminHeaderFile, 'migration qualification admin header')],
    ['REPLACE_SOURCE_WRITE_BODY', canonicalFile(input.sourceWriteBody, 'source bridge write body')],
    ['REPLACE_TARGET_WRITE_BODY', canonicalFile(input.targetWriteBody, 'target bridge write body')],
    ['REPLACE_CONTRACT_WINDOW_EVIDENCE', canonicalFile(input.contractWindowEvidence, 'contract window evidence')],
    ['REPLACE_CONTRACT_QUALIFIED_EVIDENCE', canonicalFile(input.contractQualifiedEvidence, 'qualified Contract evidence')],
    ['REPLACE_EXPAND_MIGRATION_ID', resolved.migrationQualification.expandMigrationId],
    ['REPLACE_BACKFILL_MIGRATION_ID', resolved.migrationQualification.backfillMigrationId],
    ['REPLACE_CONTRACT_MIGRATION_ID', resolved.migrationQualification.contractMigrationId]
  ])
  const scenario = replaceStrings(template, replacements)
  if (scenario.schema !== 'fsusblog.release-migration-qualification-scenario.v1'
    || !Array.isArray(scenario.cases)
    || scenario.cases.length !== 10) {
    fail('materialized migration qualification scenario is incomplete')
  }
  const serialized = JSON.stringify(scenario)
  if (/REPLACE_[A-Z0-9_]+/u.test(serialized)) fail('migration qualification scenario contains unresolved placeholders')
  return scenario
}

export function materializeFaultPlan(
  resolved,
  runRoot,
  kind = 'deploy',
  rolloutIdOverride = null,
  resolvedPlanFileInput = null) {
  assertResolvedPlan(resolved)
  if (!['deploy', 'rollback'].includes(kind)) fail('fault plan kind must be deploy or rollback')
  const root = path.resolve(runRoot)
  ensureWithin(root, resolved.workRoot, 'fault run root')
  const source = kind === 'deploy' ? resolved.source : resolved.target
  const target = kind === 'deploy' ? resolved.target : resolved.source
  const rolloutId = rolloutIdOverride === null
    ? `${kind}-${target.releaseId}`
    : safeId(rolloutIdOverride, 'fault rolloutId override')
  const template = readJson(resolved.faults.planTemplate, 'fault plan template')
  const orchestrator = canonicalFile(
    path.join(resolved.repoRoot, 'tools/deployment/zero-downtime-rehearsal.sh'),
    'zero-downtime rehearsal orchestrator')
  const resolvedPlanFile = canonicalFile(
    resolvedPlanFileInput ?? resolved.planFile,
    'resolved rehearsal plan for fault cases')
  const replacements = new Map([
    ['REPLACE_ROLLOUT_ID', rolloutId],
    ['REPLACE_TARGET_RELEASE', target.releaseId],
    ['REPLACE_64_HEX_DIGEST', target.imageDigest.slice('sha256:'.length)],
    ['REPLACE_ROLLOUT_WRAPPER', orchestrator],
    ['REPLACE_FAILING_OPENRESTY_WRAPPER', resolved.faults.tokens.failingOpenRestyWrapper],
    ['REPLACE_DOCKER_FAILURE_BIN_PATH', resolved.faults.tokens.dockerFailureBinPath],
    ['REPLACE_RETAINED_ASSET', resolved.faults.tokens.retainedAsset],
    ['REPLACE_CORRUPT_ASSET', resolved.faults.tokens.corruptAsset],
    ['/REPLACE_LONG_REQUEST', resolved.faults.tokens.longRequestPath],
    ['REPLACE_LONG_REQUEST', resolved.faults.tokens.longRequestPath],
    ['{{RUN_ROOT}}', root],
    ['{{REPO_ROOT}}', resolved.repoRoot],
    ['{{ENV_FILE}}', resolved.envFile],
    ['{{ADMIN_HEADER_FILE}}', resolved.adminHeaderFile],
    ['{{SOURCE_MANIFEST}}', source.manifest],
    ['{{TARGET_MANIFEST}}', target.manifest],
    ['{{PUBLIC_URL}}', resolved.publicUrl]
  ])
  const plan = rebindFaultContainers(replaceStrings(template, replacements), source.slot, target.slot)
  if (plan.schema !== 'fsusblog.zero-downtime-fault-plan.v1') fail('materialized fault plan schema is invalid')
  if (!Array.isArray(plan.cases) || plan.cases.map(item => item.case).join('\n') !== FAULT_CASES.join('\n')) {
    fail('materialized fault plan does not contain the exact ordered fault matrix')
  }
  plan.rolloutId = safeId(plan.rolloutId, 'fault rolloutId')
  plan.target = { releaseId: target.releaseId, imageDigest: target.imageDigest }
  plan.sourceContainer = `fsus-app-${source.slot}`
  plan.targetContainer = `fsus-app-${target.slot}`
  plan.environment = {
    ...(plan.environment ?? {}),
    ASPNETCORE_ENVIRONMENT: 'Test',
    FSUSBLOG_ROLLOUT_REHEARSAL: '1',
    FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE: '1',
    FSUSBLOG_FAULT_ROLLOUT_ID: rolloutId,
    FSUSBLOG_FAULT_SOURCE_SLOT: source.slot,
    FSUSBLOG_FAULT_TARGET_SLOT: target.slot,
    FSUSBLOG_FAULT_SOURCE_MANIFEST: source.manifest,
    FSUSBLOG_FAULT_TARGET_MANIFEST: target.manifest
  }
  for (const definition of plan.cases) {
    object(definition, `fault case ${definition?.case ?? '<missing>'}`)
    const caseRoot = path.join(root, 'cases', definition.case)
    const caseRolloutId = childRolloutId(rolloutId, definition.case)
    definition.rolloutState = path.join(caseRoot, 'rollout-state.json')
    definition.slotState = path.join(caseRoot, 'slot-state.json')
    definition.publicUrl = resolved.publicUrl
    definition.setup = [{
      id: 'prepare-case',
      executable: 'bash',
      args: [
        orchestrator, '__fault-case-setup',
        '--resolved-plan', resolvedPlanFile,
        '--case-root', caseRoot,
        '--kind', kind,
        '--case', definition.case,
        '--rollout-id', caseRolloutId
      ],
      cwd: caseRoot,
      timeoutMs: 300_000
    }]
    definition.rollout = {
      ...(definition.rollout ?? {}),
      id: 'case-rollout',
      executable: 'bash',
      args: [
        orchestrator, '__fault-case-rollout',
        '--resolved-plan', resolvedPlanFile,
        '--case-root', caseRoot,
        '--kind', kind,
        '--case', definition.case,
        '--rollout-id', caseRolloutId
      ],
      cwd: caseRoot
    }
    definition.teardown = [{
      id: 'teardown-case',
      executable: 'bash',
      args: [
        orchestrator, '__fault-case-teardown',
        '--resolved-plan', resolvedPlanFile,
        '--case-root', caseRoot,
        '--kind', kind,
        '--case', definition.case,
        '--rollout-id', caseRolloutId
      ],
      cwd: caseRoot,
      timeoutMs: 300_000
    }]
    if (definition.case === 'source-stop-failure') {
      definition.rollout.environment = {
        ...(definition.rollout.environment ?? {}),
        PATH: `${resolved.faults.tokens.dockerFailureBinPath}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`
      }
    }
    validateNoSecretEnvironment(definition.rollout?.environment, `fault ${definition.case} rollout environment`)
  }
  const serialized = JSON.stringify(plan)
  if (/REPLACE_[A-Z0-9_]+|\{\{[A-Z0-9_]+\}\}/u.test(serialized)) {
    fail('materialized fault plan still contains unresolved placeholders')
  }
  return plan
}

export async function waitForRolloutStage(stateFile, stage, timeoutMs, pollMs = 50) {
  if (!ROLLOUT_STAGES.includes(stage)) fail(`unknown rollout stage: ${stage}`)
  const deadline = Date.now() + boundedInteger(timeoutMs, 1000, 1_800_000, 'timeoutMs')
  const intervalMs = boundedInteger(pollMs, 1, 1000, 'pollMs')
  while (Date.now() < deadline) {
    const state = readOptionalJson(path.resolve(stateFile))
    if (state?.schema === 'fsusblog.release-rollout-state.v1') {
      if (state.currentStage === stage) return state
      if (['completed', 'candidate_ready', 'rolled_back', 'aborted'].includes(state.status)) {
        fail(`rollout became terminal before stage ${stage}: ${state.status}`)
      }
      if (state.status === 'recovery_required') fail(`rollout requires recovery before stage ${stage}`)
      const expectedIndex = ROLLOUT_STAGES.indexOf(stage)
      if (state.completedStages?.includes(stage) || (state.completedStages?.length ?? 0) > expectedIndex) {
        fail(`rollout passed stage ${stage} before interruption could be injected`)
      }
    }
    await delay(intervalMs)
  }
  fail(`timed out waiting for rollout stage ${stage}`)
}

export function inspectOrphanedRollout(stateFile, expectedStage) {
  const state = readJson(path.resolve(stateFile), 'orphaned rollout state')
  if (state.schema !== 'fsusblog.release-rollout-state.v1') fail('orphaned rollout state schema is invalid')
  if (state.currentStage === null) {
    if (state.status !== 'running' && state.status !== 'planned') fail(`orphaned rollout status is ${state.status}`)
    return { action: 'resume-next-stage', stage: null, rolloutId: state.rolloutId }
  }
  if (state.currentStage !== expectedStage) {
    fail(`orphaned rollout stage changed: expected ${expectedStage}, got ${state.currentStage}`)
  }
  return { action: 'fail-running-stage', stage: state.currentStage, rolloutId: state.rolloutId }
}

export function buildWorkerTargetHealth(stateFile, ledgerFile) {
  const state = readJson(path.resolve(stateFile), 'worker rollout state')
  const ledgerPath = canonicalFile(ledgerFile, 'worker drill ledger')
  const ledger = readJson(ledgerPath, 'worker drill ledger')
  if (state.schema !== 'fsusblog.release-rollout-state.v1') fail('worker rollout state schema is invalid')
  if (ledger.schema !== 'fsusblog.release-worker-event-ledger.v1' || ledger.status !== 'pass') fail('worker drill ledger did not pass')
  if (ledger.rolloutId !== state.rolloutId) fail('worker drill ledger rolloutId mismatch')
  if (ledger.target?.releaseId !== state.target?.releaseId || ledger.target?.generation !== state.target?.runtimeGeneration) {
    fail('worker drill ledger target identity/generation mismatch')
  }
  if (ledger.drill?.targetReadiness?.status !== 'pass' || ledger.drill?.targetTakeover?.status !== 'pass') {
    fail('worker drill did not prove target readiness and takeover')
  }
  return {
    schema: 'fsusblog.release-worker-target-health.v1',
    status: 'healthy',
    rolloutId: state.rolloutId,
    qualificationId: ledger.drill.runId,
    releaseId: state.target.releaseId,
    generation: state.target.runtimeGeneration,
    slot: state.target.slot,
    sourceLedger: {
      path: ledgerPath,
      sha256: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(ledgerPath)).digest('hex')}`
    },
    readiness: ledger.drill.targetReadiness,
    takeover: ledger.drill.targetTakeover,
    observedAtUtc: new Date().toISOString()
  }
}

export function buildWorkerQualification(stateFile, ledgerFile, scenarioFile) {
  const state = readJson(path.resolve(stateFile), 'worker qualification rollout state')
  const ledgerPath = canonicalFile(ledgerFile, 'worker qualification ledger')
  const scenarioPath = canonicalFile(scenarioFile, 'worker qualification scenario')
  const ledger = readJson(ledgerPath, 'worker qualification ledger')
  const scenario = readJson(scenarioPath, 'worker qualification scenario')
  if (state.schema !== 'fsusblog.release-rollout-state.v1') fail('worker qualification rollout state schema is invalid')
  if (ledger.schema !== 'fsusblog.release-worker-event-ledger.v1' || ledger.status !== 'pass') fail('worker qualification ledger did not pass')
  if (ledger.rolloutId !== state.rolloutId) fail('worker qualification ledger rolloutId mismatch')
  if (scenario.schema !== 'fsusblog.release-worker-drill-plan.v1') fail('worker qualification scenario schema is invalid')
  if (scenario.coordination?.mode !== 'file-handshake') fail('worker qualification did not use file-handshake')
  if (ledger.drill?.coordination?.status !== 'pass') fail('worker qualification coordination did not pass')
  if (ledger.drill?.sourceTermination?.status !== 'pass' || ledger.drill?.sourceTermination?.forced !== true) {
    fail('worker qualification did not prove forced source-worker termination')
  }
  if (ledger.drill?.targetReadiness?.status !== 'pass' || ledger.drill?.targetTakeover?.status !== 'pass') {
    fail('worker qualification did not prove target readiness/takeover')
  }
  const target = state.target
  if (ledger.target?.releaseId !== target?.releaseId || ledger.target?.generation !== target?.runtimeGeneration) {
    fail('worker qualification target identity/generation mismatch')
  }
  const scenarioSha256 = hashFile(scenarioPath)
  const ledgerSha256 = hashFile(ledgerPath)
  const policyBinding = {
    targetReleaseId: target.releaseId,
    targetImageDigest: target.imageDigest,
    targetRuntimeGeneration: target.runtimeGeneration,
    scenarioSha256,
    sourceTerminationType: scenario.sourceTermination?.type,
    coordinationMode: scenario.coordination.mode
  }
  return {
    schema: 'fsusblog.release-worker-qualification-control.v1',
    status: 'pass',
    rolloutId: state.rolloutId,
    qualificationId: ledger.drill.runId,
    source: state.source,
    target,
    qualificationMode: 'forced-source-worker-termination',
    policyBinding,
    policyHash: `sha256:${crypto.createHash('sha256').update(JSON.stringify(policyBinding)).digest('hex')}`,
    ledger: { path: ledgerPath, sha256: ledgerSha256 },
    scenario: { path: scenarioPath, sha256: scenarioSha256 },
    coordination: ledger.drill.coordination,
    sourceTermination: ledger.drill.sourceTermination,
    targetReadiness: ledger.drill.targetReadiness,
    targetTakeover: ledger.drill.targetTakeover,
    observations: { blockers: [] },
    errors: [],
    observedAtUtc: new Date().toISOString()
  }
}

export function finalizeWorkerQualification(controlFile, reconciliationFile) {
  const controlPath = canonicalFile(controlFile, 'worker qualification control')
  const reconciliationPath = canonicalFile(reconciliationFile, 'worker qualification reconciliation')
  const control = readJson(controlPath, 'worker qualification control')
  const reconciliation = readJson(reconciliationPath, 'worker qualification reconciliation')
  if (control.schema !== 'fsusblog.release-worker-qualification-control.v1' || control.status !== 'pass') {
    fail('worker qualification control did not pass')
  }
  if (reconciliation.schema !== 'fsusblog.release-worker-reconciliation-evidence.v2'
    || reconciliation.mode !== 'qualification'
    || reconciliation.status !== 'pass') {
    fail('worker qualification reconciliation did not pass')
  }
  if (reconciliation.rolloutId !== control.rolloutId) fail('worker qualification reconciliation rolloutId mismatch')
  if (reconciliation.checks?.normalRolloutSeparationVerified !== true
    || reconciliation.qualification?.freshNormalRolloutRequired !== true
    || reconciliation.qualification?.normalRolloutReuseForbidden !== true
    || !reconciliation.inputs?.normalRolloutState?.sha256) {
    fail('worker qualification is not hash-bound to a distinct fresh normal rollout')
  }
  return {
    ...control,
    schema: 'fsusblog.release-worker-qualification-evidence.v1',
    control: { path: controlPath, sha256: hashFile(controlPath) },
    reconciliation: { path: reconciliationPath, sha256: hashFile(reconciliationPath) },
    sealedAtUtc: new Date().toISOString()
  }
}

export function authorizeWorkerQualification(stateFile, armedFile, outFile, runId) {
  const state = readJson(path.resolve(stateFile), 'qualification rollout state')
  const armed = readJson(path.resolve(armedFile), 'worker qualification armed signal')
  if (state.schema !== 'fsusblog.release-rollout-state.v1' || state.currentStage !== 'active-fence') {
    fail('source-worker termination may only be authorized during active-fence')
  }
  if (armed.schema !== 'fsusblog.release-worker-drill-signal.v1'
    || armed.stage !== 'armed'
    || armed.rolloutId !== state.rolloutId
    || armed.runId !== runId) fail('worker qualification armed signal identity mismatch')
  const observed = Date.parse(armed.observedAtUtc ?? '')
  if (!Number.isFinite(observed) || Math.abs(Date.now() - observed) > 15 * 60_000) fail('worker qualification armed signal is stale')
  const signal = {
    schema: 'fsusblog.release-worker-drill-signal.v1',
    rolloutId: state.rolloutId,
    runId,
    stage: 'terminate-source',
    observedAtUtc: new Date().toISOString()
  }
  writeJsonAtomic(outFile, signal)
  return signal
}

export function buildSigkillResumeEvidence(stateFile, stage, initialExitCode, orphanAction, resumeExitCode, holdReadyFile) {
  const state = readJson(path.resolve(stateFile), 'SIGKILL resumed rollout state')
  if (!HOST_INTERRUPTION_STAGES.includes(stage)) fail('SIGKILL stage is not an approved late interruption point')
  if (Number(initialExitCode) !== 137) fail('initial rollout did not exit 137 after SIGKILL')
  if (!['fail-running-stage', 'resume-next-stage'].includes(orphanAction)) fail('SIGKILL orphan action is invalid')
  if (Number(resumeExitCode) !== 0) fail('resumed rollout did not exit zero')
  if (state.schema !== 'fsusblog.release-rollout-state.v1' || state.status !== 'completed' || state.outcome !== 'succeeded') {
    fail('SIGKILL resumed rollout is not durably completed')
  }
  if (!Array.isArray(state.recoveries) || state.recoveries.length < 1 || state.recoveries.some(item => item.status !== 'ok')) {
    fail('SIGKILL resumed rollout lacks successful durable recovery')
  }
  const holdPath = canonicalFile(holdReadyFile, 'SIGKILL stage hold evidence')
  const hold = readJson(holdPath, 'SIGKILL stage hold evidence')
  if (hold.schema !== 'fsusblog.release-rollout-rehearsal-stage-hold.v1'
    || hold.status !== 'ready'
    || hold.rolloutId !== state.rolloutId
    || hold.stage !== stage
    || (hold.errors?.length ?? 0) !== 0) {
    fail('SIGKILL stage hold evidence is invalid or not identity-bound')
  }
  return {
    schema: 'fsusblog.zero-downtime-rehearsal-sigkill.v1',
    status: 'pass',
    signal: 'SIGKILL',
    stage,
    rolloutId: state.rolloutId,
    initialExit: { code: 137, signal: 'SIGKILL' },
    orphanAction,
    resumed: true,
    resumeExitCode: 0,
    recoveryCount: state.recoveries.length,
    finalEvidencePath: state.finalEvidencePath,
    stageHold: immutableJsonMetadata(holdPath, 'SIGKILL stage hold evidence'),
    errors: [],
    observedAtUtc: new Date().toISOString()
  }
}

export function buildSigkillMatrixEvidence(modeRoot, stages = HOST_INTERRUPTION_STAGES) {
  if (!Array.isArray(stages) || stages.join('\n') !== HOST_INTERRUPTION_STAGES.join('\n')) {
    fail(`SIGKILL matrix stages must be: ${HOST_INTERRUPTION_STAGES.join(', ')}`)
  }
  const root = path.resolve(modeRoot)
  const entries = stages.map(stage => {
    const stageRoot = path.join(root, 'interruptions', stage)
    const signalPath = canonicalFile(path.join(stageRoot, 'evidence', 'sigkill-resume.json'), `${stage} SIGKILL evidence`)
    const statePath = canonicalFile(path.join(stageRoot, 'states', 'deploy-rollout.json'), `${stage} rollout state`)
    const signal = readJson(signalPath, `${stage} SIGKILL evidence`)
    const state = readJson(statePath, `${stage} rollout state`)
    verifySignalEvidence(signalPath, stage)
    if (state.schema !== 'fsusblog.release-rollout-state.v1'
      || state.status !== 'completed'
      || state.outcome !== 'succeeded'
      || state.rolloutId !== signal.rolloutId
      || !Array.isArray(state.recoveries)
      || state.recoveries.length < 1
      || state.recoveries.some(item => item.status !== 'ok')) {
      fail(`${stage} resumed rollout state is incomplete or not bound to SIGKILL evidence`)
    }
    return {
      stage,
      rolloutId: state.rolloutId,
      signalEvidence: immutableJsonMetadata(signalPath, `${stage} SIGKILL evidence`),
      rolloutState: immutableJsonMetadata(statePath, `${stage} rollout state`)
    }
  })
  if (new Set(entries.map(item => item.rolloutId)).size !== entries.length) {
    fail('SIGKILL matrix must use a distinct rolloutId for every interruption stage')
  }
  const control = readJson(path.join(root, 'states', 'deploy-rollout.json'), 'fresh SIGKILL control rollout state')
  if (entries.some(item => item.rolloutId === control.rolloutId)) {
    fail('SIGKILL matrix rolloutIds must be distinct from the fresh control rolloutId')
  }
  return {
    schema: 'fsusblog.zero-downtime-rehearsal-sigkill-matrix.v1',
    status: 'pass',
    stages: [...HOST_INTERRUPTION_STAGES],
    entries,
    errors: [],
    observedAtUtc: new Date().toISOString()
  }
}

export function deriveRehearsalRolloutId(role, phase, releaseId, runId)
{
    if (!['normal', 'qualification'].includes(role)) {fail('rollout role must be normal or qualification')};
    const safePhase = safeId(phase, 'rollout phase');
    if (!isValidReleaseId(releaseId)) {fail('rollout releaseId is invalid')};
    const safeRun = safeId(runId, 'rehearsal runId');
    const binding = `${role}\0${safePhase}\0${releaseId}\0${safeRun}`;
    const suffix = crypto.createHash('sha256').update(binding).digest('hex').slice(0, 16);
  const fixed = `${role}-${safePhase}-`
  const tail = `-${suffix}`
  const available = 120 - fixed.length - tail.length
  const releasePart = String(releaseId).slice(0, Math.max(8, available)).replace(/[^0-9A-Za-z._-]/gu, '-')
  return safeId(`${fixed}${releasePart}${tail}`, 'derived rolloutId')
}

export function verifyMode(resolved, mode, modeRoot) {
  assertResolvedPlan(resolved)
  if (!MODES.has(mode)) fail(`unsupported rehearsal mode: ${mode}`)
  const root = path.resolve(modeRoot)
  ensureWithin(root, resolved.workRoot, 'mode root')
  const errors = []
  const checks = []
  const check = (name, callback) => {
    try {
      const detail = callback()
      checks.push({ name, status: 'pass', ...(detail === undefined ? {} : { detail }) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      checks.push({ name, status: 'fail', error: message })
      errors.push(`${name}: ${message}`)
    }
  }

  if (mode === 'post-switch-rollback') {
    check('fault-matrix', () => verifyFaultEvidence(path.join(root, 'evidence', 'fault-matrix.json'), true))
  } else {
    check('fault-matrix', () => verifyFaultEvidence(path.join(root, 'evidence', 'fault-matrix.json'), false))
  }
  check('deploy-rollout', () => verifyRollout(
    path.join(root, 'states', 'deploy-rollout.json'),
    path.join(root, 'rollouts', 'deploy'),
    {
      kind: 'deploy',
      sourceSlot: 'blue',
      sourceRelease: resolved.source.releaseId,
      targetSlot: 'green',
      targetRelease: resolved.target.releaseId,
      requireRecovery: false
    }))
  check('active-slot', () => verifyActiveSlot(path.join(root, 'states', 'slots.json'), mode === 'explicit-rollback' ? 'blue' : 'green'))
  if (mode === 'sigkill-resume') {
    check('sigkill-resume-matrix', () => verifySigkillMatrix(path.join(root, 'evidence', 'sigkill-resume.json'), root))
    for (const stage of resolved.hostInterruption.stages) {
      const stageRoot = path.join(root, 'interruptions', stage)
      check(`fault-matrix-${stage}`, () => verifyFaultEvidence(path.join(stageRoot, 'evidence', 'fault-matrix.json'), false))
      check(`deploy-rollout-${stage}`, () => verifyRollout(
        path.join(stageRoot, 'states', 'deploy-rollout.json'),
        path.join(stageRoot, 'rollouts', 'deploy'),
        {
          kind: 'deploy',
          sourceSlot: 'blue',
          sourceRelease: resolved.source.releaseId,
          targetSlot: 'green',
          targetRelease: resolved.target.releaseId,
          requireRecovery: true
        }))
    }
  }
  if (mode === 'explicit-rollback') {
    check('rollback-rollout', () => verifyRollout(
      path.join(root, 'states', 'rollback-rollout.json'),
      path.join(root, 'rollouts', 'rollback'),
      {
        kind: 'rollback',
        sourceSlot: 'green',
        sourceRelease: resolved.target.releaseId,
        targetSlot: 'blue',
        targetRelease: resolved.source.releaseId,
        requireRecovery: false
      }))
  }
  check('worker-qualification-deploy', () => verifyWorkerQualification(
    path.join(root, 'qualification', 'deploy', 'worker-qualification.json'),
    resolved.target.releaseId,
    resolved.target.imageDigest))
  check('migration-qualification-deploy', () => verifyMigrationQualification(
    path.join(root, 'migration-qualification', 'deploy', 'migration-qualification.json'),
    resolved.target.releaseId,
    resolved.target.imageDigest))
  if (mode === 'explicit-rollback') {
    check('worker-qualification-rollback', () => verifyWorkerQualification(
      path.join(root, 'qualification', 'rollback', 'worker-qualification.json'),
      resolved.source.releaseId,
      resolved.source.imageDigest))
    check('migration-qualification-rollback', () => verifyMigrationQualification(
      path.join(root, 'migration-qualification', 'rollback', 'migration-qualification.json'),
      resolved.source.releaseId,
      resolved.source.imageDigest))
  }

  return {
    schema: MODE_EVIDENCE_SCHEMA,
    status: errors.length === 0 ? 'pass' : 'fail',
    rehearsalId: resolved.rehearsalId,
    mode,
    nonProductionOnly: true,
    modeRoot: root,
    checks,
    errors,
    observedAtUtc: new Date().toISOString()
  }
}

function verifyMigrationQualification(file, targetReleaseId, targetImageDigest) {
  const reportPath = canonicalFile(file, 'migration qualification evidence')
  const report = readJson(reportPath, 'migration qualification evidence')
  if (report.schema !== 'fsusblog.release-migration-qualification-evidence.v1'
    || report.contractVersion !== 1
    || report.status !== 'pass'
    || report.target?.releaseId !== targetReleaseId
    || report.target?.imageDigest !== targetImageDigest
    || !Array.isArray(report.cases)
    || report.cases.map(item => item.id).join('\n') !== MIGRATION_QUALIFICATION_CASES.join('\n')
    || report.cases.some(item => item.status !== 'pass' || (item.errors?.length ?? 0) !== 0)
    || !Array.isArray(report.errors)
    || report.errors.length !== 0
    || !/^sha256:[0-9a-f]{64}$/u.test(String(report.evidenceSha256 ?? ''))) {
    fail('migration qualification evidence is incomplete or not target-bound')
  }
  return {
    rolloutId: report.rolloutId,
    runId: report.runId,
    targetReleaseId,
    evidenceSha256: hashFile(reportPath)
  }
}

function verifyRollout(stateFile, evidenceRoot, expected) {
  const state = readJson(stateFile, `${expected.kind} rollout state`)
  if (state.schema !== 'fsusblog.release-rollout-state.v1') fail('rollout state schema is invalid')
  if (state.status !== 'completed' || state.outcome !== 'succeeded') fail(`rollout is not completed: ${state.status}`)
  if (state.kind !== expected.kind) fail(`rollout kind is ${state.kind}`)
  if (state.source?.slot !== expected.sourceSlot || state.source?.releaseId !== expected.sourceRelease) fail('source identity mismatch')
  if (state.target?.slot !== expected.targetSlot || state.target?.releaseId !== expected.targetRelease) fail('target identity mismatch')
  if (state.completedStages?.join('\n') !== ROLLOUT_STAGES.join('\n')) fail('rollout stage set/order is incomplete')
  if (state.switchCommitted !== true || !Number.isSafeInteger(state.gatewayGeneration)) fail('gateway switch is not durably committed')
  if (!Array.isArray(state.recoveries) || state.recoveries.some(item => item.status !== 'ok')) fail('rollout contains unresolved recovery')
  if (expected.requireRecovery && state.recoveries.length < 1) fail('SIGKILL resume has no durable recovery record')
  const finalEvidencePath = state.finalEvidencePath
  if (typeof finalEvidencePath !== 'string') fail('final evidence path is missing')
  ensureWithin(finalEvidencePath, evidenceRoot, 'final rollout evidence')
  const evidence = readJson(finalEvidencePath, 'final rollout evidence')
  if (evidence.schema !== 'fsusblog.release-rollout-evidence.v1' || evidence.status !== 'pass') fail('final rollout evidence did not pass')
  if (evidence.rolloutId !== state.rolloutId || evidence.kind !== expected.kind) fail('final evidence identity mismatch')
  if (!Array.isArray(evidence.stages) || evidence.stages.map(item => item.stage).join('\n') !== ROLLOUT_STAGES.join('\n')) {
    fail('final evidence stages are incomplete')
  }
  for (const name of ['publicTraffic', 'notificationStream', 'assetCompatibility', 'workerReconciliation', 'resourceBudget', 'faultInjection']) {
    const artifact = evidence.artifacts?.[name]
    if (!artifact || artifact.status !== 'pass') fail(`${name} artifact did not pass`)
    assertImmutableArtifact(artifact, name)
  }
  const normalWorker = readJson(evidence.artifacts.workerReconciliation.path, 'normal worker reconciliation evidence')
  if (normalWorker.schema !== 'fsusblog.release-worker-reconciliation-evidence.v2'
    || normalWorker.mode !== 'normal'
    || normalWorker.status !== 'pass'
    || normalWorker.rolloutId !== state.rolloutId
    || normalWorker.kinds?.join('\n') !== NORMAL_WORKER_KINDS.join('\n')
    || normalWorker.forcedSourceRecoveryRequired !== false
    || Object.values(normalWorker.checks ?? {}).some(value => value !== true)) {
    fail('fresh normal worker v2 reconciliation is incomplete or not bound to rollout')
  }
  return { rolloutId: state.rolloutId, recoveryCount: state.recoveries.length, finalEvidencePath }
}

function verifyActiveSlot(file, expectedSlot) {
  const state = readJson(file, 'durable slot state')
  if (state.schema !== 'fsusblog.deployment-slots.v1') fail('slot state schema is invalid')
  if (state.status !== 'stable' || state.activeSlot !== expectedSlot) fail(`active slot is ${state.activeSlot ?? '<missing>'}`)
  const record = state.slots?.[expectedSlot]
  if (!record?.releaseId || !DIGEST.test(String(record.imageDigest ?? ''))) fail('active slot identity is incomplete')
  return { activeSlot: expectedSlot, releaseId: record.releaseId }
}

function verifyFaultEvidence(file, requirePostSwitchRollback) {
  const report = readJson(file, 'fault matrix evidence')
  if (report.schema !== 'fsusblog.zero-downtime-fault-matrix.v1' || report.status !== 'pass') fail('fault matrix did not pass')
  if (report.caseCount !== FAULT_CASES.length || report.cases?.map(item => item.case).join('\n') !== FAULT_CASES.join('\n')) {
    fail('fault matrix case set/order is incomplete')
  }
  if (report.cases.some(item => item.status !== 'pass' || item.automated !== true || item.actionStatus !== 'executed')) {
    fail('fault matrix contains an unexecuted or failed case')
  }
  if (requirePostSwitchRollback) {
    for (const name of ['active-fence-failure', 'public-probe-failure']) {
      const item = report.cases.find(candidate => candidate.case === name)
      if (item?.after?.rolloutState?.status !== 'rolled_back') fail(`${name} did not end rolled_back`)
      const recovery = item.after.rolloutState.recoveries?.at(-1)
      if (recovery?.action !== 'rollback-gateway-to-source' || recovery.status !== 'ok') {
        fail(`${name} lacks successful automatic rollback recovery`)
      }
    }
  }
  return { caseCount: report.caseCount }
}

function verifySignalEvidence(file, expectedStage) {
  const evidence = readJson(file, 'SIGKILL resume evidence')
  if (evidence.schema !== 'fsusblog.zero-downtime-rehearsal-sigkill.v1') fail('SIGKILL evidence schema is invalid')
  if (evidence.status !== 'pass' || (evidence.errors?.length ?? 0) !== 0) fail('SIGKILL evidence did not pass')
  if (evidence.signal !== 'SIGKILL' || evidence.stage !== expectedStage) fail('SIGKILL evidence signal/stage mismatch')
  if (evidence.initialExit?.signal !== 'SIGKILL' || evidence.initialExit?.code !== 137) fail('initial rollout was not killed with SIGKILL')
  if (evidence.resumeExitCode !== 0 || evidence.resumed !== true) fail('rollout did not successfully resume')
  if (!['fail-running-stage', 'resume-next-stage'].includes(evidence.orphanAction)) fail('orphan state was not durably classified')
  assertImmutableArtifact(evidence.stageHold, 'SIGKILL stage hold')
  const hold = readJson(evidence.stageHold.path, 'SIGKILL stage hold')
  if (hold.schema !== 'fsusblog.release-rollout-rehearsal-stage-hold.v1'
    || hold.status !== 'ready'
    || hold.rolloutId !== evidence.rolloutId
    || hold.stage !== expectedStage
    || (hold.errors?.length ?? 0) !== 0) {
    fail('SIGKILL stage hold is not identity-bound')
  }
  return { stage: evidence.stage, orphanAction: evidence.orphanAction }
}

function verifySigkillMatrix(file, root) {
  const matrix = readJson(file, 'SIGKILL interruption matrix')
  if (matrix.schema !== 'fsusblog.zero-downtime-rehearsal-sigkill-matrix.v1'
    || matrix.status !== 'pass'
    || (matrix.errors?.length ?? 0) !== 0
    || matrix.stages?.join('\n') !== HOST_INTERRUPTION_STAGES.join('\n')
    || matrix.entries?.map(item => item.stage).join('\n') !== HOST_INTERRUPTION_STAGES.join('\n')) {
    fail('SIGKILL interruption matrix is incomplete')
  }
  if (new Set(matrix.entries.map(item => item.rolloutId)).size !== HOST_INTERRUPTION_STAGES.length) {
    fail('SIGKILL interruption matrix reused a rolloutId')
  }
  const controlState = readJson(path.join(root, 'states', 'deploy-rollout.json'), 'fresh SIGKILL control rollout state')
  if (matrix.entries.some(item => item.rolloutId === controlState.rolloutId)) {
    fail('SIGKILL interruption matrix reused the fresh control rolloutId')
  }
  for (const entry of matrix.entries) {
    const stageRoot = path.join(root, 'interruptions', entry.stage)
    ensureWithin(entry.signalEvidence?.path, stageRoot, `${entry.stage} SIGKILL evidence`)
    ensureWithin(entry.rolloutState?.path, stageRoot, `${entry.stage} rollout state`)
    assertImmutableArtifact(entry.signalEvidence, `${entry.stage} SIGKILL evidence`)
    assertImmutableArtifact(entry.rolloutState, `${entry.stage} rollout state`)
    verifySignalEvidence(entry.signalEvidence.path, entry.stage)
    const signal = readJson(entry.signalEvidence.path, `${entry.stage} SIGKILL evidence`)
    ensureWithin(signal.stageHold?.path, stageRoot, `${entry.stage} stage hold`)
    const state = readJson(entry.rolloutState.path, `${entry.stage} rollout state`)
    if (state.rolloutId !== entry.rolloutId || state.status !== 'completed' || state.outcome !== 'succeeded') {
      fail(`${entry.stage} rollout state is not completed or identity-bound`)
    }
  }
  return { stages: matrix.stages, rolloutIds: matrix.entries.map(item => item.rolloutId) }
}

function verifyWorkerQualification(file, expectedRelease, expectedDigest) {
  const evidencePath = canonicalFile(file, 'worker qualification evidence')
  const evidence = readJson(evidencePath, 'worker qualification evidence')
  if (evidence.schema !== 'fsusblog.release-worker-qualification-evidence.v1' || evidence.status !== 'pass') {
    fail('worker qualification evidence did not pass')
  }
  if (evidence.target?.releaseId !== expectedRelease || evidence.target?.imageDigest !== expectedDigest) {
    fail('worker qualification target identity mismatch')
  }
  if (!DIGEST.test(String(evidence.policyHash ?? ''))) fail('worker qualification policy hash is invalid')
  if (!DIGEST.test(String(evidence.ledger?.sha256 ?? '')) || hashFile(evidence.ledger.path) !== evidence.ledger.sha256) {
    fail('worker qualification ledger hash mismatch')
  }
  if (!DIGEST.test(String(evidence.scenario?.sha256 ?? '')) || hashFile(evidence.scenario.path) !== evidence.scenario.sha256) {
    fail('worker qualification scenario hash mismatch')
  }
  if (!DIGEST.test(String(evidence.reconciliation?.sha256 ?? ''))
    || hashFile(evidence.reconciliation.path) !== evidence.reconciliation.sha256) {
    fail('worker qualification reconciliation hash mismatch')
  }
  const reconciliation = readJson(evidence.reconciliation.path, 'worker qualification reconciliation')
  if (reconciliation.schema !== 'fsusblog.release-worker-reconciliation-evidence.v2'
    || reconciliation.mode !== 'qualification'
    || reconciliation.checks?.normalRolloutSeparationVerified !== true
    || !DIGEST.test(String(reconciliation.inputs?.normalRolloutState?.sha256 ?? ''))) {
    fail('worker qualification lacks fresh normal rollout hash binding')
  }
  if (evidence.coordination?.status !== 'pass' || evidence.sourceTermination?.forced !== true || evidence.targetTakeover?.status !== 'pass') {
    fail('worker qualification lifecycle proof is incomplete')
  }
  return { policyHash: evidence.policyHash, ledgerSha256: evidence.ledger.sha256, path: evidencePath }
}

function assertImmutableArtifact(artifact, label) {
  if (!DIGEST.test(String(artifact.sha256 ?? ''))) fail(`${label} artifact hash is invalid`)
  const file = canonicalFile(artifact.path, `${label} artifact`)
  const bytes = fs.statSync(file).size
  const sha256 = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
  if (artifact.bytes !== bytes || artifact.sha256 !== sha256) fail(`${label} artifact changed after seal`)
}

function hashFile(file) {
  const resolved = canonicalFile(file, 'hashed evidence file')
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex')}`
}

function immutableJsonMetadata(file, label) {
  const resolved = canonicalFile(file, label)
  const buffer = fs.readFileSync(resolved)
  const value = readJson(resolved, label)
  return {
    path: resolved,
    bytes: buffer.length,
    sha256: `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`,
    schema: value.schema ?? null,
    status: value.status ?? null
  }
}

function resolveFaultTokens(raw, planFile, repoRoot, workRoot) {
  object(raw, 'faults.tokens')
  const failingOpenRestyWrapper = materialFile(planFile, raw.failingOpenRestyWrapper, 'faults.tokens.failingOpenRestyWrapper')
  const dockerFailureBinPath = canonicalDirectory(resolveFrom(planFile, raw.dockerFailureBinPath), 'faults.tokens.dockerFailureBinPath')
  const retainedAsset = materialFile(planFile, raw.retainedAsset, 'faults.tokens.retainedAsset')
  const corruptAsset = materialFile(planFile, raw.corruptAsset, 'faults.tokens.corruptAsset')
  for (const [label, file] of Object.entries({ failingOpenRestyWrapper, dockerFailureBinPath, retainedAsset, corruptAsset })) {
    if (!isWithin(file, repoRoot) && !isWithin(file, workRoot)) fail(`${label} must stay under repository or rehearsal workRoot`)
  }
  if ((fs.statSync(failingOpenRestyWrapper).mode & 0o111) === 0) fail('faults.tokens.failingOpenRestyWrapper must be executable')
  const dockerFailureWrapper = canonicalFile(path.join(dockerFailureBinPath, 'docker'), 'faults.tokens.dockerFailureBinPath/docker')
  if ((fs.statSync(dockerFailureWrapper).mode & 0o111) === 0) fail('fault docker failure wrapper must be executable')
  const longRequestPath = String(raw.longRequestPath ?? '')
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%?\/-]{1,500}$/u.test(longRequestPath)
    || longRequestPath.startsWith('//')
    || longRequestPath.includes('..')) {
    fail('faults.tokens.longRequestPath must be a safe absolute HTTP path')
  }
  return { failingOpenRestyWrapper, dockerFailureBinPath, retainedAsset, corruptAsset, longRequestPath }
}

function releaseManifest(file, label)
{
    const value = readJson(file, label);
    if (!isValidReleaseId(value.releaseId)) {fail(`${label} releaseId is invalid`)};
    if (!DIGEST.test(String(value.imageDigest ?? ''))) {fail(`${label} imageDigest is invalid`)};
    return { manifest: file, releaseId: value.releaseId, imageDigest: value.imageDigest };
}

function assertAssetScenario(file, oldReleaseId, newReleaseId, label) {
  const value = readJson(file, label)
  if (value.schema !== 'fsusblog.release-asset-compatibility-scenario.v1') fail(`${label} schema is invalid`)
  if (value.oldReleaseId !== oldReleaseId || value.newReleaseId !== newReleaseId) fail(`${label} release identities mismatch`)
  if (value.browser?.required !== true) fail(`${label} must require controlled browser evidence`)
}

function workerScenario(file, label) {
  const value = readJson(file, label)
  if (value.schema !== 'fsusblog.release-worker-drill-plan.v1') fail(`${label} schema is invalid`)
  if (value.coordination?.mode !== 'file-handshake') fail(`${label} must use file-handshake coordination`)
  if (value.sourceTermination?.type !== 'process-signal' || value.sourceTermination?.signal !== 'SIGKILL') {
    fail(`${label} must SIGKILL a bounded source worker process; killing the source application container is not allowed in a success rehearsal`)
  }
  const coordination = {}
  for (const name of ['armedFile', 'authorizeFile', 'terminatedFile']) {
    const candidate = String(value.coordination?.[name] ?? '')
    if (!candidate || path.isAbsolute(candidate) || candidate.split(/[\\/]/u).some(segment => segment === '..')) {
      fail(`${label} coordination.${name} must be a safe relative work-directory path`)
    }
    coordination[name] = candidate
  }
  if (new Set(Object.values(coordination)).size !== 3) fail(`${label} coordination paths must be distinct`)
  const allowedHttpOrigins = Array.isArray(value.security?.allowedHttpOrigins)
    ? value.security.allowedHttpOrigins.map((origin, index) => localUrl(origin, null, `${label}.security.allowedHttpOrigins[${index}]`))
    : fail(`${label}.security.allowedHttpOrigins must be an array`)
  return { scenario: file, coordination, allowedHttpOrigins }
}

function workerObserverServicePlan(file, label) {
  const value = readJson(file, label)
  if (value.schema !== 'fsusblog.release-worker-observer-service-plan.v1') fail(`${label} schema is invalid`)
  if (value.nonProductionOnly !== true || value.acknowledgement !== 'OBSERVE_ISOLATED_TEST_WORKERS_ONLY') {
    fail(`${label} non-production acknowledgement is invalid`)
  }
  if (/REPLACE_|<[^>]+>|\{\{[^}]+\}\}/u.test(JSON.stringify(value))) {
    fail(`${label} contains unresolved placeholders`)
  }
  const host = String(value.listen?.host ?? '')
  if (!['127.0.0.1', 'localhost'].includes(host)) fail(`${label}.listen.host must be explicit loopback`)
  const port = boundedInteger(value.listen?.port, 1, 65_535, `${label}.listen.port`)
  const baseUrl = localUrl(`http://${host}:${port}`, null, `${label}.listen`)
  return { file, baseUrl, host, port }
}

function normalWorkerScenario(file, label) {
  const value = readJson(file, label)
  if (value.schema !== 'fsusblog.release-worker-normal-observer-plan.v1') fail(`${label} schema is invalid`)
  const baseUrl = localUrl(value.baseUrl, null, `${label}.baseUrl`)
  const paths = {}
  for (const name of ['startPath', 'statusPath', 'finalizePath']) {
    const candidate = String(value[name] ?? '')
    if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]{1,500}$/u.test(candidate) || candidate.includes('..')) {
      fail(`${label}.${name} must be a safe absolute HTTP path`)
    }
    paths[name] = candidate
  }
  if (new Set(Object.values(paths)).size !== 3) fail(`${label} endpoint paths must be distinct`)
  const requiredKinds = value.requiredKinds
  const expectedKinds = [
    'scheduled-publish', 'article-mutation-outbox', 'audit-writer', 'visit-view-projection',
    'public-hot-aot', 'upload-cleanup', 'active-singleton-control', 'multi-consumer-safe-control'
  ]
  if (!Array.isArray(requiredKinds) || requiredKinds.join('\n') !== expectedKinds.join('\n')) {
    fail(`${label}.requiredKinds must contain the exact ordered normal 8-kind set`)
  }
  return {
    file,
    baseUrl,
    ...paths,
    requiredKinds,
    timeoutMs: boundedInteger(value.timeoutMs ?? 300_000, 10_000, 900_000, `${label}.timeoutMs`),
    pollMs: boundedInteger(value.pollMs ?? 250, 50, 10_000, `${label}.pollMs`)
  }
}

function assertTestEnvironment(file, publicUrl) {
  const content = fs.readFileSync(file, 'utf8')
  const entries = new Map()
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator > 0) entries.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  const environment = entries.get('ASPNETCORE_ENVIRONMENT') ?? entries.get('DOTNET_ENVIRONMENT')
  if (environment !== 'Test') fail('envFile must explicitly set ASPNETCORE_ENVIRONMENT or DOTNET_ENVIRONMENT to Test')
  const baseUrl = entries.get('SITE_BASEURL')
  if (baseUrl === undefined) fail('envFile must explicitly set SITE_BASEURL')
  localUrl(baseUrl, null, 'envFile SITE_BASEURL')
  if (new URL(baseUrl).origin !== new URL(publicUrl).origin) fail('envFile SITE_BASEURL must match rehearsal publicUrl origin')
  if (entries.get('EXTERNAL_DB_HOST') !== 'global-postgres') fail('envFile EXTERNAL_DB_HOST must be the isolated rehearsal Postgres alias')
  if (entries.get('EXTERNAL_REDIS_HOST') !== 'global-redis') fail('envFile EXTERNAL_REDIS_HOST must be the isolated rehearsal Redis alias')
  if (!/(?:rehears|test)/iu.test(entries.get('DB_NAME') ?? '')) fail('envFile DB_NAME must explicitly identify a rehearsal/test database')
  for (const name of ['FSUSBLOG_REHEARSAL_POSTGRES_IMAGE', 'FSUSBLOG_REHEARSAL_REDIS_IMAGE', 'FSUSBLOG_REHEARSAL_OPENRESTY_IMAGE']) {
    if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/u.test(entries.get(name) ?? '')) fail(`envFile ${name} must be an immutable repository digest`)
  }
  for (const name of ['FSUSBLOG_REHEARSAL_POSTGRES_VOLUME', 'FSUSBLOG_REHEARSAL_REDIS_VOLUME', 'FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME', 'FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME']) {
    const value = entries.get(name)
    if (value !== undefined && !/^fsusblog-zdt-[A-Za-z0-9_.-]{1,80}$/u.test(value)) fail(`envFile ${name} must use an isolated fsusblog-zdt-* volume`)
  }
}

function validateNoSecretEnvironment(value, label) {
  if (value === undefined) return
  object(value, label)
  for (const [name, content] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name)) fail(`${label} contains an unsafe variable name`)
    if (/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CONNECTION_STRING)$/u.test(name)) {
      fail(`${label} must pass secrets by private file, not environment value`)
    }
    if (typeof content !== 'string' || content.includes('\0') || content.includes('\n')) fail(`${label}.${name} is invalid`)
  }
}

function assertResolvedPlan(value) {
  object(value, 'resolved plan')
  if (value.schema !== RESOLVED_PLAN_SCHEMA || value.nonProductionOnly !== true || value.environment !== 'Test') {
    fail('resolved rehearsal plan is invalid')
  }
}

function replaceStrings(value, replacements) {
  if (typeof value === 'string') {
    let result = value
    for (const [needle, replacement] of replacements) result = result.split(needle).join(replacement)
    return result
  }
  if (Array.isArray(value)) return value.map(item => replaceStrings(item, replacements))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item, replacements)]))
  }
  return value
}

function rebindFaultContainers(value, sourceSlot, targetSlot) {
  if (typeof value === 'string') {
    const marker = '__FSUSBLOG_SOURCE_CONTAINER__'
    return value
      .replaceAll('fsus-app-blue', marker)
      .replaceAll('fsus-app-green', `fsus-app-${targetSlot}`)
      .replaceAll(marker, `fsus-app-${sourceSlot}`)
  }
  if (Array.isArray(value)) return value.map(item => rebindFaultContainers(item, sourceSlot, targetSlot))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebindFaultContainers(item, sourceSlot, targetSlot)]))
  }
  return value
}

function childRolloutId(parent, child) {
  const suffix = crypto.createHash('sha256').update(`${parent}\0${child}`).digest('hex').slice(0, 12)
  const tail = `-${child}-${suffix}`
  return safeId(`${parent.slice(0, 128 - tail.length)}${tail}`, 'fault case rolloutId')
}

function privateMaterialFile(planFile, value, label) {
  const file = materialFile(planFile, value, label)
  const mode = fs.statSync(file).mode & 0o777
  if (![0o400, 0o600].includes(mode)) fail(`${label} must have mode 0400 or 0600`)
  return file
}

function assertPrivateAdminHeader(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  const match = lines.length === 1 ? /^(Authorization|Cookie): (\S(?:.*\S)?)$/u.exec(lines[0]) : null
  if (!match || (match[1] === 'Authorization' && !match[2].startsWith('Bearer '))) {
    fail('adminHeaderFile must contain exactly one Authorization: Bearer or Cookie header')
  }
}

function materialFile(planFile, value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is required`)
  return canonicalFile(resolveFrom(planFile, value), label)
}

function resolveFrom(planFile, value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail('path value is missing or invalid')
  return path.resolve(path.dirname(planFile), value)
}

function canonicalFile(value, label) {
  const resolved = path.resolve(value)
  const stat = fs.statSync(resolved, { throwIfNoEntry: false })
  if (!stat?.isFile()) fail(`${label} is missing or not a regular file: ${resolved}`)
  if (fs.lstatSync(resolved).isSymbolicLink()) fail(`${label} must not be a symbolic link`)
  return fs.realpathSync(resolved)
}

function canonicalDirectory(value, label) {
  const resolved = path.resolve(value)
  const stat = fs.statSync(resolved, { throwIfNoEntry: false })
  if (!stat?.isDirectory()) fail(`${label} is missing or not a directory: ${resolved}`)
  if (fs.lstatSync(resolved).isSymbolicLink()) fail(`${label} must not be a symbolic link`)
  return fs.realpathSync(resolved)
}

function localUrl(value, requiredPathname, label) {
  let parsed
  try { parsed = new URL(String(value ?? '')) } catch { fail(`${label} is not an absolute URL`) }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    fail(`${label} must be an explicit loopback HTTP URL for local rehearsal`)
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) fail(`${label} must not contain credentials/query/fragment`)
  if (!parsed.port) fail(`${label} must include an explicit port`)
  if (requiredPathname !== null && parsed.pathname !== requiredPathname) fail(`${label} must end with ${requiredPathname}`)
  return parsed.href.replace(/\/$/u, requiredPathname === null ? '' : '/')
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { fail(`unable to read ${label}: ${message(error)}`) }
}

function readOptionalJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJsonAtomic(file, value) {
  const resolved = path.resolve(file)
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 })
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, resolved)
}

function ensureWithin(candidate, parent, label) {
  if (!isWithin(candidate, parent)) fail(`${label} escapes ${parent}`)
}

function assertNoSymlinkTraversal(candidate, parent, label) {
  ensureWithin(candidate, parent, label)
  let cursor = path.resolve(parent)
  const target = path.resolve(candidate)
  const parentStat = fs.lstatSync(cursor, { throwIfNoEntry: false })
  if (parentStat?.isSymbolicLink()) fail(`${label} parent must not be a symbolic link`)
  const relative = path.relative(cursor, path.resolve(candidate))
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false })
    if (stat === undefined) break
    if (stat.isSymbolicLink()) fail(`${label} must not traverse a symbolic link: ${cursor}`)
    if (cursor !== target && !stat.isDirectory()) fail(`${label} traverses a non-directory path: ${cursor}`)
  }
}

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function safeId(value, label) {
  const result = String(value ?? '')
  if (!SAFE_ID.test(result) || result.includes('..')) fail(`${label} is invalid`)
  return result
}

function boundedInteger(value, minimum, maximum, label) {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail(`${label} must be ${minimum}..${maximum}`)
  return result
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function fail(message) {
  throw new Error(message)
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function parseCli(argv) {
  const command = argv.shift()
  const options = {}
  while (argv.length > 0) {
    const name = argv.shift()
    const value = argv.shift()
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) fail(`invalid argument near ${name ?? '<end>'}`)
    if (Object.hasOwn(options, name.slice(2))) fail(`duplicate argument: ${name}`)
    options[name.slice(2)] = value
  }
  return { command, options }
}

async function main(argv) {
  const { command, options } = parseCli([...argv])
  if (command === 'run-current') {
    exactCurrentFields(options, ['plan', 'repo-root', 'mode', 'run-id'], 'current command options');
    const planFile = path.resolve(options.plan);
    const raw = JSON.parse(currentFileBytes(planFile).toString('utf8'));
    const resolved = await resolveCurrentRehearsalPlan(raw, { planFile, repoRoot: options['repo-root'] });
    const report = await runCurrentRehearsal(resolved, { mode: options.mode, runId: options['run-id'] });
    process.stdout.write(`${JSON.stringify({ schema: report.schema, scope: report.scope, status: report.status })}\n`);
    if (report.status !== 'pass') process.exitCode = 1;
    return;
  }
  fail('legacy rehearsal CLI is retired; use run-current with an explicit v2 operational plan');
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invoked) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`[zero-downtime-rehearsal-plan] fatal: ${message(error)}\n`)
    process.exitCode = 1
  })
}
