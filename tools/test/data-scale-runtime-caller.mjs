import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const { currentProcessIdentity, processIdentityStatus } = await import(new URL('./process-identity.mjs', import.meta.url));
const { schedulerTierAdmissionActivity } = await import(new URL('../test-matrix/scheduler-run-owner.mjs', import.meta.url));
const { productionDiskDemandDigest } = await import(new URL('../test-matrix/production-disk-demand.mjs', import.meta.url));

const schema = 'fsusblog.data-scale-runtime-caller.v1';
const operations = Object.freeze(['provision', 'teardown', 'baseline-container-controls']);
const maximumBytes = 1024 ** 2;
const environmentKeys = Object.freeze([
    'FSUSBLOG_RELEASE_RELIABILITY_RUN_ID', 'FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID',
    'FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID', 'FSUSBLOG_RELEASE_RUNTIME_IMAGE',
    'FSUSBLOG_TEST_FIXTURE_CONFIG', 'FSUSBLOG_PRODUCTION_BUILD_ROOT', 'FSUSBLOG_BACKEND_SERVER_DLL',
    'FSUSBLOG_TEST_EXECUTION_SERVICE_CATALOG', 'FSUSBLOG_DATA_SCALE_RUNTIME_PLAN_PATH',
    'FSUSBLOG_DATA_SCALE_RUNTIME_RECEIPT_PATH'
]);

function byteDigest(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function documentDigest(document)
{
    const { contentDigest, ...unsigned } = document;
    void contentDigest;
    return productionDiskDemandDigest(unsigned);
}

function normalizedSourceFingerprint(value)
{
    if (typeof value !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(value))
    {
        throw new Error('DataScale caller source fingerprint must identify exact SHA-256 bytes');
    }
    return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function ownPrivate(file, kind, mode)
{
    const absolute = path.resolve(file);
    const metadata = fs.lstatSync(absolute);
    if (metadata.isSymbolicLink() || fs.realpathSync(absolute) !== absolute
    || (kind === 'directory' ? !metadata.isDirectory() : kind === 'socket' ? !metadata.isSocket() : !metadata.isFile())
    || (metadata.mode & 0o777) !== mode
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (kind === 'file' && metadata.nlink !== 1))
    {
        throw new Error('DataScale caller private path ownership/type/mode mismatch');
    }
    return absolute;
}

function immutableAdmission(journal)
{
    const { admission, admissionReference: reference } = journal;
    if (admission?.currentTierId !== 'release-reliability-fresh')
    {
        throw new Error('DataScale caller requires release-reliability-fresh tier admission');
    }
    const expected = path.join(journal.runsRoot, admission.runId, 'scheduler-admissions',
        `${admission.schedulerOwnerToken}-${admission.admissionSequence}-${admission.currentTierId}.json`);
    const configured = reference?.ref ? path.resolve(journal.repositoryRoot, reference.ref) : path.resolve(reference?.file ?? '');
    if (configured !== expected || fs.lstatSync(configured).isSymbolicLink()
    || !fs.lstatSync(configured).isFile() || fs.realpathSync(configured) !== configured)
    {
        throw new Error('DataScale caller immutable admission path mismatch');
    }
    const bytes = fs.readFileSync(configured);
    if (bytes.length > maximumBytes || byteDigest(bytes) !== reference.fileDigest
    || productionDiskDemandDigest(JSON.parse(bytes)) !== productionDiskDemandDigest(admission))
    {
        throw new Error('DataScale caller immutable admission bytes/content mismatch');
    }
    const activity = schedulerTierAdmissionActivity({ runsRoot: journal.runsRoot, admission, reference });
    if (activity.status !== 'active')
    {
        throw new Error(`DataScale caller scheduler admission is ${activity.status}: ${activity.reason}`);
    }
    if (processIdentityStatus(journal.parentProcessIdentity).status !== 'live'
    || activity.owner.pid !== journal.parentProcessIdentity.pid
    || activity.owner.processStartIdentity !== journal.parentProcessIdentity.processStartIdentity
    || activity.owner.executableDigest !== journal.parentProcessIdentity.executableDigest
    || activity.owner.commandDigest !== journal.parentProcessIdentity.commandDigest)
    {
        throw new Error('DataScale caller parent process authority mismatch');
    }
    return activity;
}

function readJournal(file, repositoryRoot)
{
    const absolute = ownPrivate(file, 'file', 0o600);
    const directory = ownPrivate(path.dirname(absolute), 'directory', 0o700);
    const bytes = fs.readFileSync(absolute);
    if (bytes.length > maximumBytes) throw new Error('DataScale caller journal exceeds its bound');
    const journal = JSON.parse(bytes);
    if (journal.schema !== schema || documentDigest(journal) !== journal.contentDigest
    || journal.repositoryRoot !== fs.realpathSync(repositoryRoot)
    || JSON.stringify(journal.operations) !== JSON.stringify(operations)
    || path.dirname(journal.socketPath) !== directory || path.dirname(journal.tokenFile) !== directory)
    {
        throw new Error('DataScale caller journal binding mismatch');
    }
    ownPrivate(journal.socketPath, 'socket', 0o600);
    ownPrivate(journal.tokenFile, 'file', 0o600);
    immutableAdmission(journal);
    return journal;
}

function attemptIdentity(identity, environment, journal)
{
    const attemptId = environment.FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID;
    if (identity?.schema !== 'fsusblog.release-reliability-run-identity.v1' || identity.status !== 'complete'
    || identity.contentDigest !== documentDigest(identity)
    || identity.runId !== journal.admission.runId
    || identity.sourceState?.commit !== journal.admission.sourceState.commit
    || normalizedSourceFingerprint(identity.sourceState?.worktreeFingerprint)
        !== normalizedSourceFingerprint(journal.admission.sourceState.worktreeFingerprint)
    || environment.FSUSBLOG_RELEASE_RELIABILITY_RUN_ID !== identity.runId
    || environment.FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID !== identity.invocationId
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(identity.invocationId ?? '')
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(attemptId ?? ''))
    {
        throw new Error('DataScale caller run/source/invocation/attempt identity mismatch');
    }
    return { runId: identity.runId, invocationId: identity.invocationId, attemptId,
        identityDigest: identity.contentDigest, sourceCommit: identity.sourceState.commit,
        worktreeFingerprint: normalizedSourceFingerprint(identity.sourceState.worktreeFingerprint) };
}

function exactFields(value, fields)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function validateBaselineContainerControls(controls, journal)
{
    const roleNames = ['postgres', 'redis', 'backend'];
    const grantFields = ['cpuUnits', 'memoryHighBytes', 'memoryMaxBytes', 'pidsMax'];
    if (!exactFields(controls, ['runId', 'namespace', 'sourceState', 'roles'])
    || controls.runId !== journal.admission.runId || controls.namespace !== journal.admission.namespace
    || !exactFields(controls.sourceState, ['commit', 'worktreeFingerprint'])
    || controls.sourceState.commit !== journal.admission.sourceState.commit
    || controls.sourceState.worktreeFingerprint !== journal.admission.sourceState.worktreeFingerprint
    || !exactFields(controls.roles, roleNames))
    {
        throw new Error('DataScale baseline container controls original scheduler binding mismatch');
    }
    for (const role of roleNames)
    {
        const grant = controls.roles[role];
        if (!exactFields(grant, grantFields) || !Number.isFinite(grant.cpuUnits) || grant.cpuUnits <= 0
        || !Number.isSafeInteger(grant.memoryHighBytes) || grant.memoryHighBytes < 16 * 1024 ** 2
        || grant.memoryHighBytes % 4096 !== 0 || !Number.isSafeInteger(grant.memoryMaxBytes)
        || grant.memoryMaxBytes < grant.memoryHighBytes || grant.memoryMaxBytes % 4096 !== 0
        || !Number.isSafeInteger(grant.pidsMax) || grant.pidsMax < 1)
        {
            throw new Error('DataScale baseline container controls must have bounded role CPU/memory/PID limits');
        }
    }
    return controls;
}

function transportEnvironment(environment)
{
    return Object.fromEntries(environmentKeys.filter((key) => environment[key] !== undefined).map((key) =>
    {
        if (typeof environment[key] !== 'string' || environment[key].length > 32768)
        {
            throw new Error('DataScale caller environment value is invalid');
        }
        return [key, environment[key]];
    }));
}

function observeFile(root, relative)
{
    if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('DataScale caller receipt path must be relative');
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`)
    || !/^\.tmp\/release-reliability\/[A-Za-z0-9][A-Za-z0-9_.-]*\/data-scale-owner\/data-scale-[a-f0-9]{20}\.(?:plan|runtime|teardown)\.json$/u.test(relative)
    || fs.lstatSync(absolute).isSymbolicLink() || !fs.lstatSync(absolute).isFile()
    || fs.realpathSync(absolute) !== absolute)
    {
        throw new Error('DataScale caller receipt path must belong to the current runtime owner');
    }
    const bytes = fs.readFileSync(absolute);
    if (bytes.length > maximumBytes) throw new Error('DataScale caller receipt exceeds its bound');
    return { path: relative, bytesDigest: byteDigest(bytes), document: JSON.parse(bytes) };
}

function inspectProduced(root, produced, operation, attempt, preparedPlan = produced.plan)
{
    const receipt = observeFile(root, produced.receiptPath);
    if (receipt.document.contentDigest !== documentDigest(receipt.document)
    || receipt.document.schema !== (operation === 'provision' ? 'fsusblog.data-scale-runtime.v2' : 'fsusblog.data-scale-teardown.v2')
    || productionDiskDemandDigest(receipt.document) !== productionDiskDemandDigest(produced.receipt)
    || receipt.document.parentSchedulerRunId !== attempt.runId
    || receipt.document.invocationId !== attempt.invocationId || receipt.document.attemptId !== attempt.attemptId
    || receipt.document.sourceCommit !== attempt.sourceCommit
    || receipt.document.dataScaleRunId !== preparedPlan?.dataScaleRunId
    || receipt.path !== `.tmp/release-reliability/${attempt.invocationId}/data-scale-owner/${preparedPlan.dataScaleRunId}.${operation === 'provision' ? 'runtime' : 'teardown'}.json`
    || (operation === 'teardown' && receipt.document.runtimePlanDigest !== preparedPlan.contentDigest))
    {
        throw new Error('DataScale caller produced receipt identity/digest mismatch');
    }
    const result = { receiptPath: receipt.path, receiptBytesDigest: receipt.bytesDigest };
    if (operation === 'provision')
    {
        const plan = observeFile(root, produced.planPath);
        if (plan.document.contentDigest !== documentDigest(plan.document)
        || plan.document.parentSchedulerRunId !== attempt.runId
        || plan.document.invocationId !== attempt.invocationId || plan.document.attemptId !== attempt.attemptId
        || plan.document.contentDigest !== produced.plan.contentDigest
        || plan.document.sourceCommit !== attempt.sourceCommit
        || normalizedSourceFingerprint(plan.document.worktreeFingerprint) !== attempt.worktreeFingerprint
        || plan.path !== `.tmp/release-reliability/${attempt.invocationId}/data-scale-owner/${preparedPlan.dataScaleRunId}.plan.json`)
        {
            throw new Error('DataScale caller produced plan identity/digest mismatch');
        }
        result.planPath = plan.path;
        result.planBytesDigest = plan.bytesDigest;
    }
    return result;
}

export async function startDataScaleRuntimeCaller({
    root, runsRoot, admission, admissionReference, runtimeAdmission,
    environment = {}, provision, teardown, baselineContainerControls
})
{
    if (typeof provision !== 'function' || typeof teardown !== 'function' || !runtimeAdmission)
    {
        throw new Error('DataScale caller requires parent-owned provision/teardown and live runtime admission capabilities');
    }
    const repositoryRoot = fs.realpathSync(root);
    const authority = { repositoryRoot, runsRoot: fs.realpathSync(runsRoot), admission,
        admissionReference, parentProcessIdentity: currentProcessIdentity() };
    immutableAdmission(authority);
    // Keep the private control endpoint below Linux's sockaddr_un path bound,
    // including when TMPDIR is the task's longer dev-cache directory.
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dsc-'));
    fs.chmodSync(directory, 0o700);
    const socketPath = path.join(directory, 'c.sock');
    if (Buffer.byteLength(socketPath) > 107)
    {
        fs.rmSync(directory, { recursive: true });
        throw new Error('DataScale caller requires a task-owned TMPDIR with a Unix socket path of at most 107 bytes');
    }
    const journalFile = path.join(directory, 'journal.json');
    const tokenFile = path.join(directory, 'token');
    const token = randomBytes(32).toString('hex');
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' });
    const payload = { schema, ...authority, socketPath, tokenFile, tokenDigest: byteDigest(token),
        operations, createdAt: new Date().toISOString() };
    const journal = { ...payload, contentDigest: documentDigest(payload) };
    let attempt = null;
    let queue = Promise.resolve();
    let disposed = false;
    let closing = false;

    async function perform(operation, identity, requestedEnvironment)
    {
        immutableAdmission(journal);
        const binding = attemptIdentity(identity, requestedEnvironment, journal);
        if (attempt && productionDiskDemandDigest(attempt.binding) !== productionDiskDemandDigest(binding))
        {
            throw new Error('DataScale caller refuses a different invocation or attempt');
        }
        if (operation === 'provision')
        {
            if (attempt?.status === 'provisioned') return inspectProduced(repositoryRoot, attempt.produced, operation, binding);
            if (attempt) throw new Error('DataScale caller attempt requires teardown before another provision');
            attempt = { binding, identity: structuredClone(identity), environment: { ...environment, ...requestedEnvironment },
                status: 'provisioning', plan: null, planPath: null, runtimeReceipt: null };
            try
            {
                const produced = await provision({ identity: attempt.identity, environment: attempt.environment, runtimeAdmission,
                    onPlan({ plan, planPath })
                    {
                        if (plan?.parentSchedulerRunId !== binding.runId || plan.invocationId !== binding.invocationId
                        || plan.attemptId !== binding.attemptId || plan.sourceCommit !== admission.sourceState.commit
                        || normalizedSourceFingerprint(plan.worktreeFingerprint)
                            !== normalizedSourceFingerprint(admission.sourceState.worktreeFingerprint)
                        || plan.contentDigest !== documentDigest(plan))
                        {
                            throw new Error('DataScale caller prepared owner plan binding mismatch');
                        }
                        attempt.plan = structuredClone(plan);
                        attempt.planPath = planPath;
                    }
                });
                if (!attempt.plan) throw new Error('DataScale caller requires the owner onPlan custody hook');
                if (produced.plan?.contentDigest !== attempt.plan.contentDigest)
                {
                    throw new Error('DataScale caller owner plan drift after preparation');
                }
                // Retain the actual result before verification so a malformed
                // transport artifact cannot discard cleanup custody.
                attempt.runtimeReceipt = produced.receipt;
                attempt.produced = produced;
                const result = inspectProduced(repositoryRoot, produced, operation, binding);
                attempt.status = 'provisioned';
                return result;
            }
            catch (error)
            {
                if (error.dataScaleCleanup && attempt.plan)
                {
                    inspectProduced(repositoryRoot, error.dataScaleCleanup, 'teardown', binding, attempt.plan);
                    if (error.dataScaleCleanup.receipt.status === 'complete')
                    {
                        attempt.teardown = error.dataScaleCleanup;
                        attempt.status = 'released';
                        throw error;
                    }
                }
                attempt.status = 'provision-failed';
                throw error;
            }
        }
        if (!attempt?.plan) throw new Error('DataScale caller has no prepared owner plan for teardown');
        if (attempt.status === 'released') return inspectProduced(repositoryRoot, attempt.teardown, operation, binding, attempt.plan);
        const produced = await teardown({ plan: attempt.plan, runtimeReceipt: attempt.runtimeReceipt,
            identity: attempt.identity, environment: attempt.environment, runtimeAdmission });
        const result = inspectProduced(repositoryRoot, produced, operation, binding, attempt.plan);
        if (produced.receipt.status === 'complete')
        {
            attempt.status = 'released';
            attempt.teardown = produced;
        }
        else
        {
            attempt.status = 'cleanup-pending';
        }
        return result;
    }

    function handle(request)
    {
        const task = queue.then(async () =>
        {
            if (disposed || closing || request.schema !== schema
            || Object.keys(request).some((key) => !['schema', 'token', 'journalDigest', 'operation', 'identity', 'environment'].includes(key))
            || !operations.includes(request.operation) || request.journalDigest !== journal.contentDigest
            || !/^[a-f0-9]{64}$/u.test(request.token ?? '')
            || !timingSafeEqual(Buffer.from(token), Buffer.from(request.token)))
            {
                throw new Error('DataScale caller authenticated request or closed operation roster mismatch');
            }
            if (readJournal(journalFile, repositoryRoot).contentDigest !== journal.contentDigest)
            {
                throw new Error('DataScale caller immutable transport journal drift');
            }
            const requested = transportEnvironment(request.environment ?? {});
            if (Object.keys(request.environment ?? {}).some((key) => !environmentKeys.includes(key)))
            {
                throw new Error('DataScale caller request contains an unapproved environment key');
            }
            if (request.operation === 'baseline-container-controls')
            {
                // Bootstrap has not emitted a release identity yet. This is a
                // closed read of observed controls, never serialized authority.
                if (request.identity !== null || Object.keys(requested).length !== 0
                || typeof baselineContainerControls !== 'function')
                {
                    throw new Error('DataScale baseline controls require the parent live baseline reservation callback');
                }
                return validateBaselineContainerControls(await baselineContainerControls(), journal);
            }
            return perform(request.operation, request.identity, requested);
        });
        queue = task.catch(() => {});
        return task;
    }

    const server = net.createServer((socket) =>
    {
        let bytes = 0;
        let buffer = '';
        let submitted = false;
        socket.setEncoding('utf8');
        socket.setTimeout(10000);
        socket.on('timeout', () => { if (!submitted) socket.destroy(); });
        socket.on('error', () => socket.destroy());
        socket.on('data', (chunk) =>
        {
            bytes += Buffer.byteLength(chunk);
            if (submitted || bytes > maximumBytes) return socket.destroy();
            buffer += chunk;
            const newline = buffer.indexOf('\n');
            if (newline < 0) return;
            submitted = true;
            socket.setTimeout(0);
            let request;
            try { request = JSON.parse(buffer.slice(0, newline)); }
            catch { socket.end(`${JSON.stringify({ ok: false, error: 'DataScale caller request JSON is invalid' })}\n`); return; }
            handle(request).then((result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
                (error) => socket.end(`${JSON.stringify({ ok: false, error: String(error.message).slice(0, 16384) })}\n`));
        });
    });
    try
    {
        await new Promise((resolve, reject) =>
        {
            server.once('error', reject);
            server.listen(socketPath, resolve);
        });
        fs.chmodSync(socketPath, 0o600);
        fs.writeFileSync(journalFile, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    }
    catch (error)
    {
        server.close();
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
    }
    return {
        environment: { FSUSBLOG_DATA_SCALE_CALLER_JOURNAL: journalFile },
        async dispose()
        {
            if (disposed) return;
            if (closing) throw new Error('DataScale caller disposal is already in progress');
            closing = true;
            try
            {
                await queue;
                if (attempt?.plan && attempt.status !== 'released')
                {
                    await perform('teardown', attempt.identity, attempt.environment);
                    if (attempt.status !== 'released') throw new Error('DataScale caller cleanup remains pending; custody is retained');
                }
                disposed = true;
                await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
                fs.rmSync(directory, { recursive: true, force: true });
            }
            catch (error)
            {
                closing = false;
                throw error;
            }
        }
    };
}

async function requestDataScaleCaller({ operation, repositoryRoot, identity, environment, timeoutMs = 300000 })
{
    if (!operations.includes(operation)) throw new Error('DataScale caller operation is outside the closed roster');
    const configured = environment?.FSUSBLOG_DATA_SCALE_CALLER_JOURNAL;
    if (!configured) throw new Error('DataScale caller journal is required; live scheduler capabilities cannot be serialized');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1000)
    {
        throw new Error('DataScale caller timeout is invalid');
    }
    const journal = readJournal(configured, repositoryRoot);
    const requested = operation === 'baseline-container-controls' ? {} : transportEnvironment(environment);
    if (operation !== 'baseline-container-controls') attemptIdentity(identity, requested, journal);
    const token = fs.readFileSync(journal.tokenFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/u.test(token) || byteDigest(token) !== journal.tokenDigest)
    {
        throw new Error('DataScale caller authentication token binding mismatch');
    }
    const request = { schema, token, journalDigest: journal.contentDigest, operation, identity, environment: requested };
    if (Buffer.byteLength(JSON.stringify(request)) > maximumBytes) throw new Error('DataScale caller request exceeds its bound');
    const result = await new Promise((resolve, reject) =>
    {
        const socket = net.connect(journal.socketPath);
        let buffer = '';
        const timer = setTimeout(() => socket.destroy(new Error('DataScale caller request timed out')), timeoutMs);
        socket.setEncoding('utf8');
        socket.once('error', reject);
        socket.once('close', () => { clearTimeout(timer); if (!buffer.includes('\n')) reject(new Error('DataScale caller closed without a response')); });
        socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on('data', (chunk) =>
        {
            buffer += chunk;
            if (Buffer.byteLength(buffer) > maximumBytes) return socket.destroy(new Error('DataScale caller response exceeds its bound'));
            const newline = buffer.indexOf('\n');
            if (newline < 0) return;
            clearTimeout(timer);
            socket.end();
            try
            {
                const response = JSON.parse(buffer.slice(0, newline));
                if (!response.ok) throw new Error(response.error ?? 'DataScale caller operation failed');
                resolve(response.result);
            }
            catch (error) { reject(error); }
        });
    });
    immutableAdmission(journal);
    return { result, journal, requested };
}

export async function delegateDataScaleRuntimeOperation(options)
{
    if (!['provision', 'teardown'].includes(options.operation))
    {
        throw new Error('DataScale caller runtime operation is outside the closed roster');
    }
    const { result, journal, requested } = await requestDataScaleCaller(options);
    const operation = options.operation;
    const binding = attemptIdentity(options.identity, requested, journal);
    const receipt = observeFile(journal.repositoryRoot, result.receiptPath);
    if (receipt.bytesDigest !== result.receiptBytesDigest
    || receipt.document.contentDigest !== documentDigest(receipt.document)
    || receipt.document.parentSchedulerRunId !== binding.runId
    || receipt.document.invocationId !== binding.invocationId || receipt.document.attemptId !== binding.attemptId)
    {
        throw new Error('DataScale caller returned receipt observation mismatch');
    }
    if (operation === 'provision')
    {
        const plan = observeFile(journal.repositoryRoot, result.planPath);
        if (plan.bytesDigest !== result.planBytesDigest) throw new Error('DataScale caller returned plan observation mismatch');
    }
    return result;
}

export async function readDataScaleBaselineContainerControls({ repositoryRoot, environment, timeoutMs = 300000 })
{
    const { result, journal } = await requestDataScaleCaller({ operation: 'baseline-container-controls',
        repositoryRoot, environment, timeoutMs, identity: null });
    return validateBaselineContainerControls(result, journal);
}
