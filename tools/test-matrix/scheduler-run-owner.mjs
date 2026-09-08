import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { RunEvidenceObjectStore } from './content-addressed-evidence-store.mjs';

const { collectProcessGroupOrJobIdentity, collectProcessIdentity, currentProcessIdentity, processGroupOrJobIdentityMatches } = await import(new URL("../test/process-identity.mjs", import.meta.url));

const schedulerCurrentProcessIdentity = currentProcessIdentity();
const schedulerAdmissionIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const schedulerAdmissionNamespacePattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const schedulerAdmissionTargetPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u;

export const schedulerRunOwnerSchema = 'fsusblog.scheduler-run-owner.v1';
export const schedulerTierAdmissionSchema = 'fsusblog.scheduler-tier-admission.v2';
export const schedulerRunOwnerObservationSchema = 'fsusblog.scheduler-run-owner-observation.v1';
export const schedulerRunOwnerCasSchema = 'fsusblog.scheduler-run-owner-cas.v1';
export const schedulerRunOwnerStates = Object.freeze([
    'starting',
    'running',
    'finalizing',
    'complete',
    'failed',
    'cancelled'
]);
export const schedulerRunOwnerActiveStates = Object.freeze(['starting', 'running', 'finalizing']);
export const schedulerRunOwnerTerminalStates = Object.freeze(['complete', 'failed', 'cancelled']);
export const schedulerRunOwnerUnverifiableGraceMs = 30_000;
export const schedulerRunOwnerFields = Object.freeze([
    'schema',
    'runId',
    'candidateIdentityDigest',
    'budgetPolicyDigest',
    'targetTierId',
    'ownerToken',
    'pid',
    'processStartIdentity',
    'executableDigest',
    'commandDigest',
    'processGroupOrJobIdentity',
    'createdAt',
    'heartbeatAt',
    'state',
    'contentDigest'
]);

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}

function digest(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function contentDigest(value)
{
    return digest(JSON.stringify(canonicalize(value)));
}

function ownerPayload(owner)
{
    const payload = { ...(owner ?? {}) };
    delete payload.contentDigest;
    return payload;
}

function sealOwner(owner)
{
    const payload = ownerPayload(owner);
    return { ...payload, contentDigest: contentDigest(payload) };
}

export function sealSchedulerRunOwner(owner)
{
    return sealOwner(owner);
}

function validDigest(value)
{
    return /^sha256:[a-f0-9]{64}$/u.test(String(value ?? ''));
}

function validTimestamp(value)
{
    return Number.isFinite(Date.parse(value));
}

export function schedulerCandidateIdentityDigest({
    runId,
    targetTierId,
    namespace,
    sourceState,
    budgetPolicyDigest = null
})
{
    const normalizedNamespace = String(namespace ?? '').trim();
    if (!String(runId ?? '').trim() || !String(targetTierId ?? '').trim() || !normalizedNamespace)
    {
        throw new Error('scheduler candidate identity requires run, target tier, and namespace');
    }
    const commit = String(sourceState?.commit ?? '').trim();
    const worktreeFingerprint = String(sourceState?.worktreeFingerprint ?? '').trim();
    if (!commit || !worktreeFingerprint)
    {
        throw new Error('scheduler candidate identity requires source commit and worktree fingerprint');
    }
    if (budgetPolicyDigest !== null && !validDigest(budgetPolicyDigest))
    {
        throw new Error('scheduler candidate identity budget policy digest is invalid');
    }
    return contentDigest({
        schema: 'fsusblog.scheduler-candidate-identity.v1',
        runId,
        targetTierId,
        namespace: normalizedNamespace,
        sourceState: { commit, worktreeFingerprint },
        budgetPolicyDigest
    });
}

function normalizeSchedulerAdmissionIdentity(
    value,
    label,
    pattern = schedulerAdmissionIdentityPattern
)
{
    const normalized = String(value ?? '').trim();
    if (!pattern.test(normalized)
        || normalized === '.' || normalized === '..')
    {
        throw new Error(`scheduler tier admission ${label} is invalid`);
    }
    return normalized;
}

function schedulerTierAdmissionPath(runsRoot, admission)
{
    return path.join(
        path.resolve(runsRoot),
        admission.runId,
        'scheduler-admissions',
        `${admission.schedulerOwnerToken}-${admission.admissionSequence}-${admission.currentTierId}.json`
    );
}

export function createSchedulerTierAdmission({
    runId,
    targetTierId,
    currentTierId,
    namespace,
    mode,
    sourceState,
    schedulerCandidateIdentityDigest: candidateIdentityDigest,
    schedulerOwnerToken,
    budgetPolicyDigest = null,
    schedulerCheckpointRevision,
    admissionSequence,
    activeTierIds = [],
    releaseFinalSpawnCountBeforeAdmission,
    inputIdentity,
    outputDeclarations,
    dependencyAdmissions
})
{
    const normalized = {
        runId: normalizeSchedulerAdmissionIdentity(runId, 'runId'),
        targetTierId: normalizeSchedulerAdmissionIdentity(
            targetTierId,
            'targetTierId',
            schedulerAdmissionTargetPattern
        ),
        currentTierId: normalizeSchedulerAdmissionIdentity(currentTierId, 'currentTierId'),
        namespace: normalizeSchedulerAdmissionIdentity(
            namespace,
            'namespace',
            schedulerAdmissionNamespacePattern
        ),
        schedulerOwnerToken: normalizeSchedulerAdmissionIdentity(
            schedulerOwnerToken,
            'schedulerOwnerToken'
        )
    };
    if (!['fresh', 'resume'].includes(mode)
        || !Number.isInteger(schedulerCheckpointRevision) || schedulerCheckpointRevision < 1
        || !Number.isInteger(admissionSequence) || admissionSequence < 1
        || !Number.isInteger(releaseFinalSpawnCountBeforeAdmission)
        || releaseFinalSpawnCountBeforeAdmission < 0)
    {
        throw new Error('scheduler tier admission identity or count is invalid');
    }
    const normalizedSourceState = {
        commit: String(sourceState?.commit ?? '').trim(),
        worktreeFingerprint: String(sourceState?.worktreeFingerprint ?? '').trim()
    };
    const inputFields = ['schema', 'executionKey', 'commandDigest', 'cacheInputsDigest', 'inputsDigest', 'runtime'];
    if (!inputIdentity || JSON.stringify(Object.keys(inputIdentity).sort()) !== JSON.stringify(inputFields.sort())
        || inputIdentity.schema !== 'fsusblog.scheduler-tier-input-identity.v1'
        || typeof inputIdentity.executionKey !== 'string' || !inputIdentity.executionKey
        || !['commandDigest', 'cacheInputsDigest', 'inputsDigest'].every((field) => /^[a-f0-9]{64}$/u.test(inputIdentity[field]))
        || JSON.stringify(Object.keys(inputIdentity.runtime ?? {}).sort()) !== JSON.stringify(['arch', 'environmentDigest', 'nodeVersion', 'platform'])
        || !/^[a-f0-9]{64}$/u.test(inputIdentity.runtime.environmentDigest)
        || !['arch', 'nodeVersion', 'platform'].every((field) => typeof inputIdentity.runtime[field] === 'string' && inputIdentity.runtime[field])
        || !Array.isArray(outputDeclarations)
        || outputDeclarations.some((entry) => !entry || Object.keys(entry).sort().join(',') !== 'declaration,path'
            || typeof entry.declaration !== 'string' || !entry.declaration
            || typeof entry.path !== 'string' || !entry.path
            || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/u).includes('..'))
        || new Set(outputDeclarations.map((entry) => entry.declaration)).size !== outputDeclarations.length
        || !dependencyAdmissions || typeof dependencyAdmissions !== 'object' || Array.isArray(dependencyAdmissions))
        throw new Error('scheduler tier admission input/output plan is invalid or missing');
    const dependencyReferenceKeys = ['schema', 'ref', 'fileDigest', 'contentDigest', 'currentTierId', 'admissionSequence'].sort();
    for (const [id, reference] of Object.entries(dependencyAdmissions))
    {
        if (!reference || JSON.stringify(Object.keys(reference).sort()) !== JSON.stringify(dependencyReferenceKeys)
            || reference.schema !== schedulerTierAdmissionSchema || reference.currentTierId !== id
            || !validDigest(reference.fileDigest) || !validDigest(reference.contentDigest)
            || typeof reference.ref !== 'string' || !reference.ref || path.isAbsolute(reference.ref)
            || reference.ref.split(/[\\/]/u).includes('..')
            || !Number.isSafeInteger(reference.admissionSequence)
            || reference.admissionSequence < 1 || reference.admissionSequence >= admissionSequence)
            throw new Error('scheduler tier admission dependency reference is invalid');
    }
    const expectedCandidate = schedulerCandidateIdentityDigest({
        runId: normalized.runId,
        targetTierId: normalized.targetTierId,
        namespace: normalized.namespace,
        sourceState: normalizedSourceState,
        budgetPolicyDigest
    });
    if (candidateIdentityDigest !== expectedCandidate)
    {
        throw new Error('scheduler tier admission candidate identity is invalid');
    }
    if (!Array.isArray(activeTierIds))
    {
        throw new Error('scheduler tier admission active tier ids must be sorted and unique');
    }
    const normalizedActive = activeTierIds.map((value) => (
        normalizeSchedulerAdmissionIdentity(value, 'active tier id')
    ));
    if (new Set(normalizedActive).size !== normalizedActive.length
        || JSON.stringify([...normalizedActive].sort()) !== JSON.stringify(normalizedActive))
    {
        throw new Error('scheduler tier admission active tier ids must be sorted and unique');
    }
    if (normalizedActive.includes('release-final')
        && releaseFinalSpawnCountBeforeAdmission === 0)
    {
        throw new Error('scheduler tier admission release-final activity contradicts the spawn count');
    }
    return sealOwner({
        schema: schedulerTierAdmissionSchema,
        runId: normalized.runId,
        targetTierId: normalized.targetTierId,
        currentTierId: normalized.currentTierId,
        namespace: normalized.namespace,
        mode,
        sourceState: normalizedSourceState,
        schedulerCandidateIdentityDigest: candidateIdentityDigest,
        schedulerOwnerToken: normalized.schedulerOwnerToken,
        budgetPolicyDigest,
        schedulerCheckpointRevision,
        admissionSequence,
        activeTierIds: normalizedActive,
        releaseFinalSpawnCountBeforeAdmission,
        inputIdentity: structuredClone(inputIdentity),
        outputDeclarations: structuredClone(outputDeclarations),
        dependencyAdmissions: structuredClone(dependencyAdmissions),
        status: 'admitted'
    });
}

export function writeSchedulerTierAdmission({ runsRoot, admission })
{
    const recreated = createSchedulerTierAdmission(admission);
    if (recreated.contentDigest !== admission.contentDigest)
    {
        throw new Error('scheduler tier admission content digest mismatch');
    }
    const resolvedRunsRoot = path.resolve(runsRoot);
    fs.mkdirSync(resolvedRunsRoot, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(resolvedRunsRoot).isDirectory()
        || fs.lstatSync(resolvedRunsRoot).isSymbolicLink()
        || fs.realpathSync(resolvedRunsRoot) !== resolvedRunsRoot)
    {
        throw new Error('scheduler runs root must be a canonical directory');
    }
    const runDirectory = path.join(resolvedRunsRoot, admission.runId);
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const directory = path.join(runDirectory, 'scheduler-admissions');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [candidate, label] of [
        [runDirectory, 'run directory'],
        [directory, 'admission directory']
    ])
    {
        const stat = fs.lstatSync(candidate);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(candidate) !== candidate)
        {
            throw new Error(`scheduler tier ${label} must be canonical`);
        }
    }
    const file = schedulerTierAdmissionPath(resolvedRunsRoot, admission);
    const bytes = `${JSON.stringify(admission, null, 2)}\n`;
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try
    {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
    return {
        file,
        fileDigest: digest(bytes),
        contentDigest: admission.contentDigest,
        schema: schedulerTierAdmissionSchema,
        currentTierId: admission.currentTierId,
        admissionSequence: admission.admissionSequence
    };
}

export function schedulerTierAdmissionSequence({ runsRoot, runId })
{
    const normalizedRunId = normalizeSchedulerAdmissionIdentity(runId, 'runId');
    const directory = path.join(path.resolve(runsRoot), normalizedRunId, 'scheduler-admissions');
    if (!fs.existsSync(directory))
    {
        return 0;
    }
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
        || fs.realpathSync(directory) !== directory)
    {
        throw new Error('scheduler tier admission directory must be canonical');
    }
    let sequence = 0;
    for (const entry of fs.readdirSync(directory).sort())
    {
        if (!entry.endsWith('.json'))
        {
            throw new Error(`scheduler tier admission directory contains unknown entry ${entry}`);
        }
        const file = path.join(directory, entry);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file)
        {
            throw new Error(`scheduler tier admission entry is not canonical: ${entry}`);
        }
        const admission = JSON.parse(fs.readFileSync(file, 'utf8'));
        const recreated = createSchedulerTierAdmission(admission);
        if (recreated.contentDigest !== admission.contentDigest
            || admission.runId !== normalizedRunId
            || path.basename(schedulerTierAdmissionPath(runsRoot, admission)) !== entry)
        {
            throw new Error(`scheduler tier admission entry is invalid: ${entry}`);
        }
        sequence = Math.max(sequence, admission.admissionSequence);
    }
    return sequence;
}

export function readSchedulerProducerTerminalFailure({
    runsRoot,
    runId,
    targetTierId,
    namespace,
    sourceState,
    producerTierId,
    activity = schedulerRunLockActivity
})
{
    const normalizedRunId = String(runId ?? '').trim();
    const normalizedProducerTierId = String(producerTierId ?? '').trim();
    if (!normalizedRunId || path.basename(normalizedRunId) !== normalizedRunId)
    {
        throw new Error('scheduler checkpoint authority requires a safe run id');
    }
    if (!normalizedProducerTierId)
    {
        throw new Error('scheduler checkpoint authority requires a producer tier id');
    }
    const normalizedRunsRoot = path.resolve(String(runsRoot ?? ''));
    const runDirectory = path.join(normalizedRunsRoot, normalizedRunId);
    const checkpointFile = path.join(runDirectory, 'checkpoint.json');
    if (!fs.existsSync(checkpointFile))
    {
        return null;
    }
    const runDirectoryStat = fs.lstatSync(runDirectory);
    const checkpointStat = fs.lstatSync(checkpointFile);
    if (!runDirectoryStat.isDirectory() || runDirectoryStat.isSymbolicLink()
    || !checkpointStat.isFile() || checkpointStat.isSymbolicLink())
    {
        throw new Error(`scheduler checkpoint authority path is invalid for ${normalizedRunId}`);
    }
    let checkpoint;
    try
    {
        checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
    }
    catch (error)
    {
        throw new Error(
            `scheduler checkpoint authority is unreadable for ${normalizedRunId}: ${
        error instanceof Error ? error.message : String(error)
            }`,
            { cause: error }
        );
    }
    const normalizedNamespace = String(namespace ?? '').trim();
    const expectedSourceState = {
        commit: String(sourceState?.commit ?? '').trim(),
        worktreeFingerprint: String(sourceState?.worktreeFingerprint ?? '').trim()
    };
    if (checkpoint?.schema !== 'fsusblog.test-matrix.checkpoint.v1'
    || checkpoint.authoritative !== true
    || checkpoint.mode !== 'fresh'
    || checkpoint.runId !== normalizedRunId
    || checkpoint.targetTierId !== targetTierId
    || checkpoint.namespace !== normalizedNamespace
    || checkpoint.sourceState?.commit !== expectedSourceState.commit
    || checkpoint.sourceState?.worktreeFingerprint !== expectedSourceState.worktreeFingerprint)
    {
        throw new Error(`scheduler checkpoint authority identity mismatch for ${normalizedRunId}`);
    }
    const candidateIdentityDigest = schedulerCandidateIdentityDigest({
        runId: normalizedRunId,
        targetTierId,
        namespace: normalizedNamespace,
        sourceState: expectedSourceState,
        budgetPolicyDigest: checkpoint.budgetPolicyDigest ?? null
    });
    if (checkpoint.schedulerCandidateIdentityDigest !== candidateIdentityDigest)
    {
        throw new Error(`scheduler checkpoint candidate identity is invalid for ${normalizedRunId}`);
    }
    const ownerActivity = activity({
        runsRoot: normalizedRunsRoot,
        runId: normalizedRunId,
        candidateIdentityDigest,
        targetTierId
    });
    if (ownerActivity?.status !== 'active')
    {
        throw new Error(
            `scheduler checkpoint owner authority is ${
                ownerActivity?.status ?? 'unverifiable'
            } for ${normalizedRunId}: ${ownerActivity?.reason ?? 'missing reason'}`
        );
    }
    const tier = checkpoint.tiers?.[normalizedProducerTierId];
    if (!tier || !['failure', 'blocked', 'cancelled'].includes(tier.status))
    {
        return null;
    }
    return {
        status: tier.status,
        reason: tier.reason ?? 'no reason recorded',
        checkpointRevision: checkpoint.revision,
        candidateIdentityDigest
    };
}

export function schedulerProcessGroupOrJobIdentityIsComplete(identity)
{
    if (
        !identity ||
    identity.schema !== 'fsusblog.process-group-or-job-identity.v1' ||
    !['linux', 'darwin', 'win32'].includes(identity.platform)
    )
    {
        return false;
    }
    if (identity.kind === 'process-group')
    {
        return (
            ['linux', 'darwin'].includes(identity.platform) &&
      Number.isInteger(identity.groupId) &&
      identity.groupId > 0 &&
      Number.isInteger(identity.leaderPid) &&
      identity.leaderPid > 0 &&
      typeof identity.leaderProcessStartIdentity === 'string' &&
      identity.leaderProcessStartIdentity.length > 0
        );
    }
    return (
        identity.platform === 'win32' &&
    identity.kind === 'windows-job-object' &&
    typeof identity.authorityId === 'string' &&
    identity.authorityId.length > 0 &&
    typeof identity.jobName === 'string' &&
    identity.jobName.length > 0 &&
    typeof identity.supervisorProcessStartIdentity === 'string' &&
    identity.supervisorProcessStartIdentity.length > 0 &&
    typeof identity.ownerProcessStartIdentity === 'string' &&
    identity.ownerProcessStartIdentity.length > 0
    );
}

function windowsJobIdentityFromEnvironment(identity, env)
{
    const authorityId = String(env.FSUSBLOG_SCHEDULER_JOB_AUTHORITY_ID ?? '').trim();
    const jobName = String(env.FSUSBLOG_SCHEDULER_JOB_NAME ?? '').trim();
    const supervisorProcessStartIdentity = String(
        env.FSUSBLOG_SCHEDULER_JOB_SUPERVISOR_START_IDENTITY ?? ''
    ).trim();
    if (!authorityId || !jobName || !supervisorProcessStartIdentity)
    {
        return {
            status: 'unverifiable',
            reason: 'Windows scheduler requires an explicit Job Object authority'
        };
    }
    return {
        status: 'verified',
        value: {
            schema: 'fsusblog.process-group-or-job-identity.v1',
            platform: 'win32',
            kind: 'windows-job-object',
            authorityId,
            jobName,
            supervisorProcessStartIdentity,
            ownerProcessStartIdentity: identity.processStartIdentity
        }
    };
}

export function collectSchedulerProcessGroupOrJobIdentity(
    identity,
    { platform = process.platform, env = process.env } = {}
)
{
    return platform === 'win32'
        ? windowsJobIdentityFromEnvironment(identity, env)
        : collectProcessGroupOrJobIdentity(identity.pid, { platform });
}

const schedulerCurrentProcessGroupOrJobIdentity = collectSchedulerProcessGroupOrJobIdentity(
    schedulerCurrentProcessIdentity
);

export function createSchedulerRunOwner({
    runId,
    candidateIdentityDigest,
    budgetPolicyDigest = null,
    targetTierId,
    ownerToken = randomUUID(),
    identity = schedulerCurrentProcessIdentity,
    processGroupOrJobIdentity = null,
    collectGroupOrJobIdentity = collectSchedulerProcessGroupOrJobIdentity,
    state = 'starting',
    now = new Date()
})
{
    if (budgetPolicyDigest !== null && !validDigest(budgetPolicyDigest))
    {
        throw new Error('scheduler run owner budget policy digest is invalid');
    }
    const groupOrJob = processGroupOrJobIdentity
        ? { status: 'verified', value: processGroupOrJobIdentity }
        : identity === schedulerCurrentProcessIdentity
      ? schedulerCurrentProcessGroupOrJobIdentity
      : collectGroupOrJobIdentity(identity);
    if (groupOrJob.status !== 'verified' || !schedulerProcessGroupOrJobIdentityIsComplete(groupOrJob.value))
    {
        throw new Error(
            `scheduler process group or Job Object identity is unverifiable: ${groupOrJob.reason ?? 'incomplete authority'}`
        );
    }
    const timestamp = now.toISOString();
    return sealOwner({
        schema: schedulerRunOwnerSchema,
        runId,
        candidateIdentityDigest,
        budgetPolicyDigest,
        targetTierId,
        ownerToken,
        pid: identity.pid,
        processStartIdentity: identity.processStartIdentity,
        executableDigest: identity.executableDigest,
        commandDigest: identity.commandDigest,
        processGroupOrJobIdentity: groupOrJob.value,
        createdAt: timestamp,
        heartbeatAt: timestamp,
        state
    });
}

export function schedulerRunOwnerIsComplete(owner, nowMs = Date.now())
{
    const createdAt = Date.parse(owner?.createdAt);
    const heartbeatAt = Date.parse(owner?.heartbeatAt);
    return Boolean(
        owner &&
    Object.keys(owner).length === schedulerRunOwnerFields.length &&
    schedulerRunOwnerFields.every((field) => Object.hasOwn(owner, field)) &&
    owner.schema === schedulerRunOwnerSchema &&
    typeof owner.runId === 'string' &&
    owner.runId.length > 0 &&
    validDigest(owner.candidateIdentityDigest) &&
    (owner.budgetPolicyDigest === null || validDigest(owner.budgetPolicyDigest)) &&
    typeof owner.targetTierId === 'string' &&
    owner.targetTierId.length > 0 &&
    typeof owner.ownerToken === 'string' &&
    owner.ownerToken.length > 0 &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.processStartIdentity === 'string' &&
    owner.processStartIdentity.length > 0 &&
    validDigest(owner.executableDigest) &&
    validDigest(owner.commandDigest) &&
    schedulerProcessGroupOrJobIdentityIsComplete(owner.processGroupOrJobIdentity) &&
    schedulerRunOwnerStates.includes(owner.state) &&
    Number.isFinite(createdAt) &&
    Number.isFinite(heartbeatAt) &&
    createdAt <= heartbeatAt &&
    heartbeatAt <= nowMs &&
    validDigest(owner.contentDigest) &&
    owner.contentDigest === contentDigest(ownerPayload(owner))
    );
}

export function schedulerRunOwnerIdentityMatches(expected, actual)
{
    return Boolean(
        expected &&
    actual &&
    expected.schema === actual.schema &&
    expected.runId === actual.runId &&
    expected.candidateIdentityDigest === actual.candidateIdentityDigest &&
    expected.budgetPolicyDigest === actual.budgetPolicyDigest &&
    expected.targetTierId === actual.targetTierId &&
    expected.ownerToken === actual.ownerToken &&
    expected.pid === actual.pid &&
    expected.processStartIdentity === actual.processStartIdentity &&
    expected.executableDigest === actual.executableDigest &&
    expected.commandDigest === actual.commandDigest &&
    processGroupOrJobIdentityMatches(
        expected.processGroupOrJobIdentity,
        actual.processGroupOrJobIdentity
    )
    );
}

export function schedulerRunOwnerExactMatches(expected, actual)
{
    return schedulerRunOwnerIdentityMatches(expected, actual) && expected.contentDigest === actual.contentDigest;
}

export function schedulerOwnerProcessIdentityStatus(
    owner,
    { collectIdentity = collectProcessIdentity } = {}
)
{
    const actual = collectIdentity(Number(owner?.pid));
    if (actual.status === 'unverifiable' && ['ENOENT', 'ESRCH'].includes(actual.code))
    {
        return { status: 'dead', actual };
    }
    if (actual.status !== 'verified')
    {
        return { status: 'unverifiable', actual };
    }
    return (
    actual.pid === owner.pid &&
    actual.processStartIdentity === owner.processStartIdentity &&
    actual.executableDigest === owner.executableDigest &&
    actual.commandDigest === owner.commandDigest
    )
        ? { status: 'live', actual }
        : { status: 'mismatch', actual };
}

function schedulerOwnerGroupOrJobStatus(
    owner,
    { collectGroupOrJobIdentity = collectSchedulerProcessGroupOrJobIdentity } = {}
)
{
    if (owner.processGroupOrJobIdentity.kind === 'windows-job-object')
    {
        const observed = collectGroupOrJobIdentity(
            {
                pid: owner.pid,
                processStartIdentity: owner.processStartIdentity
            },
            { platform: 'win32' }
        );
        if (observed.status !== 'verified')
        {
            return observed;
        }
        return processGroupOrJobIdentityMatches(owner.processGroupOrJobIdentity, observed.value)
            ? { status: 'verified', value: observed.value }
            : { status: 'mismatch', value: observed.value };
    }
    const observed = collectGroupOrJobIdentity({ pid: owner.pid });
    if (observed.status !== 'verified')
    {
        return observed;
    }
    return processGroupOrJobIdentityMatches(owner.processGroupOrJobIdentity, observed.value)
        ? { status: 'verified', value: observed.value }
        : { status: 'mismatch', value: observed.value };
}

export function verifySchedulerProcessAuthority(
    owner,
    {
        processStatus = schedulerOwnerProcessIdentityStatus,
        groupOrJobStatus = schedulerOwnerGroupOrJobStatus
    } = {}
)
{
    if (
        !Number.isInteger(owner?.pid) ||
    owner.pid <= 0 ||
    typeof owner.processStartIdentity !== 'string' ||
    !owner.processStartIdentity ||
    !validDigest(owner.executableDigest) ||
    !validDigest(owner.commandDigest) ||
    !schedulerProcessGroupOrJobIdentityIsComplete(owner.processGroupOrJobIdentity)
    )
    {
        return { status: 'unverifiable', reason: 'owner-process-authority-incomplete', owner };
    }
    let observedProcess;
    try
    {
        observedProcess = processStatus(owner);
    }
    catch (error)
    {
        return {
            status: 'unverifiable',
            reason: `owner-process-check-failed:${error instanceof Error ? error.message : String(error)}`,
            owner
        };
    }
    if (['dead', 'mismatch'].includes(observedProcess.status))
    {
        return { status: 'inactive', reason: `owner-${observedProcess.status}`, owner };
    }
    if (observedProcess.status !== 'live')
    {
        return {
            status: 'unverifiable',
            reason: `owner-process-unverifiable:${observedProcess.actual?.reason ?? 'identity unavailable'}`,
            owner
        };
    }
    let observedGroupOrJob;
    try
    {
        observedGroupOrJob = groupOrJobStatus(owner);
    }
    catch (error)
    {
        return {
            status: 'unverifiable',
            reason: `owner-group-or-job-check-failed:${error instanceof Error ? error.message : String(error)}`,
            owner
        };
    }
    if (observedGroupOrJob.status === 'mismatch')
    {
        return { status: 'inactive', reason: 'owner-group-or-job-mismatch', owner };
    }
    if (observedGroupOrJob.status !== 'verified')
    {
        return {
            status: 'unverifiable',
            reason: `owner-group-or-job-unverifiable:${observedGroupOrJob.reason ?? 'identity unavailable'}`,
            owner
        };
    }
    return { status: 'active', reason: null, owner };
}

export function verifySchedulerRunOwner(
    owner,
    {
        runId = owner?.runId,
        candidateIdentityDigest = null,
        targetTierId = null,
        nowMs = Date.now(),
        processStatus = schedulerOwnerProcessIdentityStatus,
        groupOrJobStatus = schedulerOwnerGroupOrJobStatus
    } = {}
)
{
    if (!schedulerRunOwnerIsComplete(owner, nowMs))
    {
        return { status: 'unverifiable', reason: 'owner-schema-or-content-digest-invalid', owner };
    }
    if (owner.runId !== runId)
    {
        return { status: 'unverifiable', reason: 'owner-run-mismatch', owner };
    }
    if (schedulerRunOwnerTerminalStates.includes(owner.state))
    {
        return { status: 'inactive', reason: `owner-terminal-${owner.state}`, owner };
    }
    if (candidateIdentityDigest && owner.candidateIdentityDigest !== candidateIdentityDigest)
    {
        return { status: 'unverifiable', reason: 'owner-candidate-mismatch', owner };
    }
    if (targetTierId && owner.targetTierId !== targetTierId)
    {
        return { status: 'unverifiable', reason: 'owner-target-tier-mismatch', owner };
    }
    return verifySchedulerProcessAuthority(owner, { processStatus, groupOrJobStatus });
}

function atomicWriteJson(file, document)
{
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
}

function ownerSnapshotDigest(ownerFile)
{
    try
    {
        return digest(fs.readFileSync(ownerFile));
    }
    catch (error)
    {
        if (error?.code === 'ENOENT')
        {
            return digest('missing-owner');
        }
        throw error;
    }
}

function observationPayload(ownerSnapshotDigest, observedAt)
{
    return {
        schema: schedulerRunOwnerObservationSchema,
        ownerSnapshotDigest,
        observedAt,
        graceMs: schedulerRunOwnerUnverifiableGraceMs
    };
}

function validObservation(observation, snapshotDigest, nowMs)
{
    const payload = observationPayload(
        observation?.ownerSnapshotDigest,
        observation?.observedAt
    );
    return Boolean(
        observation &&
    observation.schema === schedulerRunOwnerObservationSchema &&
    observation.ownerSnapshotDigest === snapshotDigest &&
    observation.graceMs === schedulerRunOwnerUnverifiableGraceMs &&
    validTimestamp(observation.observedAt) &&
    Date.parse(observation.observedAt) <= nowMs &&
    observation.contentDigest === contentDigest(payload)
    );
}

function observeUnverifiableOwner(lockPath, ownerFile, nowMs)
{
    const snapshotDigest = ownerSnapshotDigest(ownerFile);
    const observationFile = path.join(
        lockPath,
        `owner-observation-${snapshotDigest.slice('sha256:'.length)}.json`
    );
    let observation = null;
    try
    {
        observation = JSON.parse(fs.readFileSync(observationFile, 'utf8'));
    }
    catch
    {
        // A concurrent observer may replace the optional snapshot.
    }
    if (!validObservation(observation, snapshotDigest, nowMs))
    {
        const payload = observationPayload(snapshotDigest, new Date(nowMs).toISOString());
        const next = { ...payload, contentDigest: contentDigest(payload) };
        try
        {
            fs.writeFileSync(observationFile, `${JSON.stringify(next, null, 2)}\n`, {
                mode: 0o600,
                flag: 'wx'
            });
            observation = next;
        }
        catch (error)
        {
            if (error?.code !== 'EEXIST')
            {
                throw error;
            }
            try
            {
                observation = JSON.parse(fs.readFileSync(observationFile, 'utf8'));
            }
            catch
            {
                observation = null;
            }
            if (!validObservation(observation, snapshotDigest, nowMs))
            {
                return {
                    expired: true,
                    reason: 'owner-observation-invalid'
                };
            }
        }
    }
    return {
        expired: nowMs - Date.parse(observation.observedAt) > schedulerRunOwnerUnverifiableGraceMs,
        reason: 'owner-unverifiable'
    };
}

export function schedulerRunLockActivity({
    runsRoot,
    runId,
    candidateIdentityDigest = null,
    targetTierId = null,
    nowMs = Date.now(),
    processStatus = schedulerOwnerProcessIdentityStatus,
    groupOrJobStatus = schedulerOwnerGroupOrJobStatus
})
{
    const lockPath = path.join(path.resolve(runsRoot), '.locks', `${runId}.lock`);
    const ownerFile = path.join(lockPath, 'owner.json');
    if (!fs.existsSync(lockPath))
    {
        return { status: 'inactive', reason: 'lock-missing', owner: null };
    }
    let owner;
    try
    {
        owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    }
    catch (error)
    {
        const observation = observeUnverifiableOwner(lockPath, ownerFile, nowMs);
        return {
            status: 'unverifiable',
            reason: `${observation.expired ? 'grace-expired' : 'within-grace'}:owner-read-failed:${
        error instanceof Error ? error.message : String(error)
            }`,
            owner: null
        };
    }
    const verification = verifySchedulerRunOwner(owner, {
        runId,
        candidateIdentityDigest,
        targetTierId,
        nowMs,
        processStatus,
        groupOrJobStatus
    });
    if (verification.status !== 'unverifiable')
    {
        return verification;
    }
    const observation = observeUnverifiableOwner(lockPath, ownerFile, nowMs);
    return {
        ...verification,
        reason: `${observation.expired ? 'grace-expired' : 'within-grace'}:${verification.reason}`
    };
}

export function verifyPersistedSchedulerTierAdmission({ runsRoot, admission, reference })
{
    let recreated;
    try
    {
        recreated = createSchedulerTierAdmission(admission);
    }
    catch (error)
    {
        return {
            status: 'invalid',
            reason: error instanceof Error ? error.message : String(error),
            owner: null
        };
    }
    const referenceKeys = [
        'schema',
        'ref',
        'fileDigest',
        'contentDigest',
        'currentTierId',
        'admissionSequence'
    ];
    if (recreated.contentDigest !== admission.contentDigest
        || !reference || typeof reference !== 'object' || Array.isArray(reference)
        || JSON.stringify(Object.keys(reference).sort()) !== JSON.stringify(referenceKeys.sort())
        || reference.schema !== schedulerTierAdmissionSchema
        || reference.contentDigest !== admission.contentDigest
        || reference.currentTierId !== admission.currentTierId
        || reference.admissionSequence !== admission.admissionSequence
        || !validDigest(reference.fileDigest))
    {
        return {
            status: 'invalid',
            reason: 'tier admission reference or content mismatch',
            owner: null
        };
    }
    const expectedFile = schedulerTierAdmissionPath(runsRoot, admission);
    const expectedName = path.basename(expectedFile);
    if (path.basename(String(reference.ref ?? '')) !== expectedName)
    {
        return { status: 'invalid', reason: 'tier admission reference path mismatch', owner: null };
    }
    let persisted;
    try
    {
        const stat = fs.lstatSync(expectedFile);
        if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(expectedFile) !== expectedFile)
        {
            throw new Error('admission is not a canonical regular file');
        }
        const bytes = fs.readFileSync(expectedFile);
        if (digest(bytes) !== reference.fileDigest)
        {
            throw new Error('admission file digest mismatch');
        }
        persisted = JSON.parse(bytes.toString('utf8'));
        if (JSON.stringify(canonicalize(persisted)) !== JSON.stringify(canonicalize(admission)))
        {
            throw new Error('admission file content mismatch');
        }
    }
    catch (error)
    {
        return {
            status: 'invalid',
            reason: `scheduler tier admission file is invalid: ${error instanceof Error ? error.message : String(error)}`,
            owner: null
        };
    }
    const storeRoot = path.join(path.resolve(runsRoot), admission.runId, 'evidence-store');
    if (!fs.existsSync(storeRoot))
    {
        return {
            status: 'invalid',
            reason: 'scheduler evidence store is missing',
            owner: null
        };
    }
    try
    {
        const store = new RunEvidenceObjectStore({
            root: storeRoot,
            runId: admission.runId,
            sourceState: admission.sourceState,
            readOnly: true
        });
        const event = store.readJournal().findLast((entry) => (
            entry.eventType === 'tier-admitted'
            && entry.tier === admission.currentTierId
            && entry.step === 'scheduler'
        ));
        if (!event || event.status !== 'running')
        {
            return {
                status: 'invalid',
                reason: 'scheduler tier admission journal event is missing or not running',
                owner: null
            };
        }
        const patch = store.readObject(event.payloadDigest).value;
        const operations = patch?.operations ?? [];
        const operation = operations.find((entry) => (
            entry.kind === 'set'
            && JSON.stringify(entry.path)
                === JSON.stringify(['schedulerAdmissions', admission.currentTierId])
        ));
        const wholeReferenceMatches = operation
            && JSON.stringify(canonicalize(operation.value))
                === JSON.stringify(canonicalize(reference));
        const updatedReferenceFields = ['ref', 'fileDigest', 'contentDigest', 'admissionSequence'];
        const nestedOperations = operations.filter((entry) => (
            Array.isArray(entry.path)
            && entry.path[0] === 'schedulerAdmissions'
            && entry.path[1] === admission.currentTierId
        ));
        const fieldUpdatesMatch = nestedOperations.length === updatedReferenceFields.length
            && updatedReferenceFields.every((field) => nestedOperations.some((entry) => (
                entry.kind === 'set'
                && JSON.stringify(entry.path)
                    === JSON.stringify(['schedulerAdmissions', admission.currentTierId, field])
                && JSON.stringify(canonicalize(entry.value))
                    === JSON.stringify(canonicalize(reference[field]))
            )));
        if (!wholeReferenceMatches && !fieldUpdatesMatch)
        {
            return {
                status: 'invalid',
                reason: 'scheduler tier admission journal binding mismatch',
                owner: null
            };
        }
    }
    catch (error)
    {
        return {
            status: 'invalid',
            reason: `scheduler tier admission journal is invalid: ${error instanceof Error ? error.message : String(error)}`,
            owner: null
        };
    }
    return { status: 'verified', reason: 'tier-admission-exact', owner: null };
}

export function schedulerTierAdmissionActivity({ runsRoot, admission, reference })
{
    const verification = verifyPersistedSchedulerTierAdmission({ runsRoot, admission, reference });
    if (verification.status !== 'verified') return verification;
    try
    {
        const store = new RunEvidenceObjectStore({
            root: path.join(path.resolve(runsRoot), admission.runId, 'evidence-store'),
            runId: admission.runId, sourceState: admission.sourceState, readOnly: true
        });
        const events = store.readJournal();
        const admitted = events.findLast((entry) => entry.eventType === 'tier-admitted'
            && entry.tier === admission.currentTierId);
        if (!admitted || events.some((entry) => entry.sequence > admitted.sequence
            && ((entry.tier === admission.currentTierId
                && ['tier-completed', 'tier-failed', 'tier-cancelled', 'tier-reused'].includes(entry.eventType))
                || ['run-completed', 'run-failed', 'run-interrupted', 'run-timed-out'].includes(entry.eventType))))
            return { status: 'invalid', reason: 'scheduler tier is no longer running', owner: null };
    }
    catch (error)
    {
        return { status: 'invalid', reason: `scheduler running state is unverifiable: ${error.message}`, owner: null };
    }
    const lock = schedulerRunLockActivity({
        runsRoot,
        runId: admission.runId,
        candidateIdentityDigest: admission.schedulerCandidateIdentityDigest,
        targetTierId: admission.targetTierId
    });
    if (lock.status !== 'active')
    {
        return lock;
    }
    if (lock.owner?.ownerToken !== admission.schedulerOwnerToken)
    {
        return {
            status: 'invalid',
            reason: 'scheduler tier admission owner token mismatch',
            owner: lock.owner
        };
    }
    return { status: 'active', reason: 'tier-admission-exact', owner: lock.owner };
}

export function schedulerRunLockIsActive(options)
{
    const activity = schedulerRunLockActivity(options);
    if (activity.status === 'unverifiable')
    {
        throw new Error(`scheduler lock owner-unverifiable: ${activity.reason}`);
    }
    return activity.status === 'active';
}

function acquireCasMarker(lockPath, owner, operation)
{
    const markerFile = path.join(lockPath, 'owner-cas.json');
    const payload = {
        schema: schedulerRunOwnerCasSchema,
        operation,
        ownerToken: owner.ownerToken,
        processStartIdentity: owner.processStartIdentity,
        ownerContentDigest: owner.contentDigest
    };
    try
    {
        fs.writeFileSync(markerFile, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: 'wx' });
        return markerFile;
    }
    catch (error)
    {
        if (['EEXIST', 'ENOENT'].includes(error?.code))
        {
            return null;
        }
        throw error;
    }
}

function removeCasMarker(markerFile)
{
    if (!markerFile)
    {
        return;
    }
    try
    {
        fs.rmSync(markerFile, { force: true });
    }
    catch
    {
        // Marker removal is best-effort after terminal ownership is recorded.
    }
}

function readOwner(ownerFile)
{
    try
    {
        return JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    }
    catch
    {
        return null;
    }
}

export function heartbeatSchedulerRunOwner({
    lockPath,
    expectedOwner,
    heartbeatAt = new Date().toISOString(),
    state = 'running',
    processStatus = schedulerOwnerProcessIdentityStatus,
    groupOrJobStatus = schedulerOwnerGroupOrJobStatus
})
{
    if (!schedulerRunOwnerActiveStates.includes(state))
    {
        return false;
    }
    const ownerFile = path.join(lockPath, 'owner.json');
    const markerFile = acquireCasMarker(lockPath, expectedOwner, 'heartbeat');
    if (!markerFile)
    {
        return false;
    }
    try
    {
        const current = readOwner(ownerFile);
        const heartbeatAtMs = Date.parse(heartbeatAt);
        if (
            !schedulerRunOwnerExactMatches(expectedOwner, current) ||
      !schedulerRunOwnerActiveStates.includes(current.state) ||
      schedulerRunOwnerActiveStates.indexOf(state) < schedulerRunOwnerActiveStates.indexOf(current.state) ||
      !Number.isFinite(heartbeatAtMs) ||
      heartbeatAtMs < Date.parse(current.heartbeatAt) ||
      heartbeatAtMs < Date.parse(current.createdAt) ||
      heartbeatAtMs > Date.now()
        )
        {
            return false;
        }
        const activity = verifySchedulerRunOwner(current, {
            runId: current.runId,
            processStatus,
            groupOrJobStatus
        });
        if (activity.status !== 'active')
        {
            return false;
        }
        const next = sealOwner({ ...current, heartbeatAt, state });
        atomicWriteJson(ownerFile, next);
        Object.assign(expectedOwner, next);
        return true;
    }
    finally
    {
        removeCasMarker(markerFile);
    }
}

export function finalizeSchedulerRunOwner({
    lockPath,
    expectedOwner,
    state,
    finalizedAt = new Date().toISOString(),
    processStatus = schedulerOwnerProcessIdentityStatus,
    groupOrJobStatus = schedulerOwnerGroupOrJobStatus
})
{
    if (!schedulerRunOwnerTerminalStates.includes(state))
    {
        throw new Error(`scheduler run owner terminal state is invalid: ${state}`);
    }
    const ownerFile = path.join(lockPath, 'owner.json');
    const markerFile = acquireCasMarker(lockPath, expectedOwner, 'finalize');
    if (!markerFile)
    {
        return false;
    }
    let tombstone = null;
    try
    {
        const current = readOwner(ownerFile);
        if (
            !schedulerRunOwnerExactMatches(expectedOwner, current) ||
      !schedulerRunOwnerActiveStates.includes(current.state) ||
      !validTimestamp(finalizedAt) ||
      Date.parse(finalizedAt) < Date.parse(current.heartbeatAt) ||
      Date.parse(finalizedAt) > Date.now()
        )
        {
            return false;
        }
        const activity = verifySchedulerRunOwner(current, {
            runId: current.runId,
            candidateIdentityDigest: current.candidateIdentityDigest,
            targetTierId: current.targetTierId,
            processStatus,
            groupOrJobStatus
        });
        if (activity.status !== 'active')
        {
            return false;
        }
        const terminal = sealOwner({ ...current, heartbeatAt: finalizedAt, state });
        atomicWriteJson(ownerFile, terminal);
        Object.assign(expectedOwner, terminal);
        archiveTerminalOwner(lockPath, terminal);
        tombstone = `${lockPath}.terminal-${terminal.ownerToken}-${randomUUID()}`;
        fs.renameSync(lockPath, tombstone);
    }
    finally
    {
        if (!tombstone)
        {
            removeCasMarker(markerFile);
        }
    }
    fs.rmSync(tombstone, { recursive: true, force: true });
    return true;
}

function archiveTerminalOwner(lockPath, owner)
{
    const locksRoot = path.dirname(lockPath);
    const archiveDirectory = path.join(locksRoot, '.terminal', owner.runId);
    const archiveFile = path.join(archiveDirectory, `${owner.ownerToken}.json`);
    fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(archiveFile))
    {
        const archived = readOwner(archiveFile);
        if (!schedulerRunOwnerExactMatches(owner, archived))
        {
            throw new Error('scheduler terminal owner archive identity mismatch');
        }
        return archiveFile;
    }
    atomicWriteJson(archiveFile, owner);
    return archiveFile;
}

export function reclaimSchedulerRunLock(
    lockPath,
    expectedOwner,
    {
        beforeDelete = null,
        processStatus = schedulerOwnerProcessIdentityStatus,
        groupOrJobStatus = schedulerOwnerGroupOrJobStatus
    } = {}
)
{
    if (!schedulerRunOwnerIsComplete(expectedOwner))
    {
        throw new Error('test matrix run owner-unverifiable: owner metadata is incomplete or tampered');
    }
    const activity = verifySchedulerRunOwner(expectedOwner, {
        runId: expectedOwner.runId,
        processStatus,
        groupOrJobStatus
    });
    if (activity.status === 'active')
    {
        return false;
    }
    if (activity.status === 'unverifiable')
    {
        throw new Error(`test matrix run owner-unverifiable: ${activity.reason}`);
    }
    const ownerFile = path.join(lockPath, 'owner.json');
    const markerFile = acquireCasMarker(lockPath, expectedOwner, 'reclaim');
    if (!markerFile)
    {
        return false;
    }
    let tombstone = null;
    try
    {
        beforeDelete?.({ lockPath, ownerFile, expectedOwner });
        const confirmedOwner = readOwner(ownerFile);
        if (!schedulerRunOwnerExactMatches(expectedOwner, confirmedOwner))
        {
            return false;
        }
        let terminalOwner = confirmedOwner;
        if (!schedulerRunOwnerTerminalStates.includes(terminalOwner.state))
        {
            terminalOwner = sealOwner({
                ...terminalOwner,
                heartbeatAt: new Date().toISOString(),
                state: 'failed'
            });
            atomicWriteJson(ownerFile, terminalOwner);
        }
        archiveTerminalOwner(lockPath, terminalOwner);
        tombstone = `${lockPath}.reclaimed-${expectedOwner.ownerToken}-${randomUUID()}`;
        fs.renameSync(lockPath, tombstone);
    }
    catch (error)
    {
        if (error?.code === 'ENOENT')
        {
            return false;
        }
        throw error;
    }
    finally
    {
        if (!tombstone)
        {
            removeCasMarker(markerFile);
        }
    }
    fs.rmSync(tombstone, { recursive: true, force: true });
    return true;
}

export function acquireSchedulerRunLock({
    runsRoot,
    runId,
    candidateIdentityDigest,
    budgetPolicyDigest = null,
    targetTierId,
    identity = schedulerCurrentProcessIdentity,
    processGroupOrJobIdentity = null,
    collectGroupOrJobIdentity = collectSchedulerProcessGroupOrJobIdentity,
    heartbeatEveryMs = 5_000,
    beforeStaleLockDelete = null
})
{
    const lockDirectory = path.join(path.resolve(runsRoot), '.locks');
    const lockPath = path.join(lockDirectory, `${runId}.lock`);
    const ownerFile = path.join(lockPath, 'owner.json');
    fs.mkdirSync(lockDirectory, { recursive: true });
    for (let attempt = 0; attempt < 3; attempt += 1)
    {
        let createdLock = false;
        try
        {
            fs.mkdirSync(lockPath, { mode: 0o700 });
            createdLock = true;
            const owner = createSchedulerRunOwner({
                runId,
                candidateIdentityDigest,
                budgetPolicyDigest,
                targetTierId,
                identity,
                processGroupOrJobIdentity,
                collectGroupOrJobIdentity
            });
            atomicWriteJson(ownerFile, owner);
            const selfProcessStatus = (expected) => (
        expected.pid === identity.pid &&
        expected.processStartIdentity === identity.processStartIdentity &&
        expected.executableDigest === identity.executableDigest &&
        expected.commandDigest === identity.commandDigest
            )
                ? { status: 'live', actual: identity }
                : { status: 'mismatch', actual: identity };
            const selfGroupOrJobStatus = (expected) => (
        processGroupOrJobIdentityMatches(
          expected.processGroupOrJobIdentity,
          owner.processGroupOrJobIdentity
        )
            )
                ? { status: 'verified', value: owner.processGroupOrJobIdentity }
                : { status: 'mismatch', value: owner.processGroupOrJobIdentity };
            let stopped = false;
            let heartbeatState = 'starting';
            const heartbeat = () =>
            {
                if (stopped)
                {
                    return;
                }
                heartbeatSchedulerRunOwner({
                    lockPath,
                    expectedOwner: owner,
                    state: heartbeatState,
                    processStatus: selfProcessStatus,
                    groupOrJobStatus: selfGroupOrJobStatus
                });
            };
            const heartbeatTimer = setInterval(heartbeat, Math.max(1, heartbeatEveryMs));
            heartbeatTimer.unref();
            return {
                lockPath,
                owner,
                markRunning()
                {
                    const changed = heartbeatSchedulerRunOwner({
                        lockPath,
                        expectedOwner: owner,
                        state: 'running',
                        processStatus: selfProcessStatus,
                        groupOrJobStatus: selfGroupOrJobStatus
                    });
                    if (changed)
                    {
                        heartbeatState = 'running';
                    }
                    return changed;
                },
                markFinalizing()
                {
                    const changed = heartbeatSchedulerRunOwner({
                        lockPath,
                        expectedOwner: owner,
                        state: 'finalizing',
                        processStatus: selfProcessStatus,
                        groupOrJobStatus: selfGroupOrJobStatus
                    });
                    if (changed)
                    {
                        heartbeatState = 'finalizing';
                    }
                    return changed;
                },
                finalize(state)
                {
                    stopped = true;
                    clearInterval(heartbeatTimer);
                    return finalizeSchedulerRunOwner({
                        lockPath,
                        expectedOwner: owner,
                        state,
                        processStatus: selfProcessStatus,
                        groupOrJobStatus: selfGroupOrJobStatus
                    });
                }
            };
        }
        catch (error)
        {
            if (createdLock)
            {
                fs.rmSync(lockPath, { recursive: true, force: true });
            }
            if (error?.code !== 'EEXIST')
            {
                throw error;
            }
            const existing = readOwner(ownerFile);
            if (!schedulerRunOwnerIsComplete(existing))
            {
                const activity = schedulerRunLockActivity({
                    runsRoot,
                    runId,
                    candidateIdentityDigest,
                    targetTierId
                });
                throw new Error(`test matrix run ${runId} owner-unverifiable: ${activity.reason}`, {
                    cause: error
                });
            }
            const activity = verifySchedulerRunOwner(existing, {
                runId,
                candidateIdentityDigest,
                targetTierId
            });
            if (activity.status === 'active')
            {
                throw new Error(`test matrix run ${runId} is already active`, {
                    cause: error
                });
            }
            if (activity.status === 'unverifiable')
            {
                throw new Error(`test matrix run ${runId} owner-unverifiable: ${activity.reason}`, {
                    cause: error
                });
            }
            reclaimSchedulerRunLock(lockPath, existing, {
                beforeDelete: beforeStaleLockDelete
            });
        }
    }
    throw new Error(`unable to acquire test matrix run lock for ${runId}`);
}
