import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const productionBuildReceiptSchema = 'fsusblog.ci-production-build-receipt.v1';
export const productionBuildVerificationSchema = 'fsusblog.ci-production-build-verification.v1';
export const productionBuildMaterializationSchema = 'fsusblog.ci-production-build-materialization.v2';
export const productionBuildLifecycleSchema = 'fsusblog.ci-production-build-lifecycle.v1';
export const productionBuildConsumerMaterializationVerificationSchema =
    'fsusblog.ci-production-build-consumer-materialization-verification.v1';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function sha256Buffer(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function compareArtifactPaths(left, right)
{
    return left.localeCompare(right);
}

function contentDigest(value)
{
    const content = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== 'contentDigest')
    );
    return sha256Buffer(JSON.stringify(canonicalize(content)));
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

function chmodReadOnly(file)
{
    const mode = fs.statSync(file).mode & 0o777;
    fs.chmodSync(file, mode & ~0o222);
}

function normalizeRelative(value, label)
{
    const normalized = String(value ?? '').trim().replace(/^\.\//u, '').replaceAll('\\', '/');
    if (!normalized || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../'))
    {
        throw new Error(`${label} path is unsafe: ${normalized || '<empty>'}`);
    }
    return normalized;
}

function assertInside(root, relative, label)
{
    const absolute = path.resolve(root, normalizeRelative(relative, label));
    if (absolute === root || !absolute.startsWith(`${root}${path.sep}`))
    {
        throw new Error(`${label} path escapes its root: ${relative}`);
    }
    return absolute;
}

function assertNoSymlink(root, absolute, label)
{
    let current = absolute;
    while (current !== root)
    {
        if (fs.lstatSync(current).isSymbolicLink())
        {
            throw new Error(`${label} contains symlink: ${absolute}`);
        }
        current = path.dirname(current);
    }
}

function walkFiles(root, relativeRoot, label)
{
    const start = assertInside(root, relativeRoot, label);
    if (!fs.existsSync(start))
    {
        throw new Error(`${label} is missing: ${relativeRoot}`);
    }
    assertNoSymlink(root, start, label);
    const files = [];
    const visit = absolute =>
    {
        for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)))
        {
            const child = path.join(absolute, entry.name);
            const relative = path.relative(root, child).replaceAll(path.sep, '/');
            if (entry.isSymbolicLink())
            {
                throw new Error(`${label} contains symlink: ${relative}`);
            }
            if (entry.isDirectory())
            {
                visit(child);
            }
            else if (entry.isFile())
            {
                files.push(relative);
            }
            else
            {
                throw new Error(`${label} contains unsupported entry: ${relative}`);
            }
        }
    };
    const stat = fs.statSync(start);
    if (stat.isFile())
    {
        files.push(normalizeRelative(relativeRoot, label));
    }
    else if (stat.isDirectory())
    {
        visit(start);
    }
    else
    {
        throw new Error(`${label} is not a file or directory: ${relativeRoot}`);
    }
    if (files.length === 0)
    {
        throw new Error(`${label} contains no files: ${relativeRoot}`);
    }
    return files;
}

function walkRootFiles(root, label)
{
    const files = [];
    const visit = absolute =>
    {
        for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)))
        {
            const child = path.join(absolute, entry.name);
            const relative = path.relative(root, child).replaceAll(path.sep, '/');
            if (entry.isSymbolicLink())
            {
                throw new Error(`${label} contains symlink: ${relative}`);
            }
            if (entry.isDirectory())
            {
                visit(child);
            }
            else if (entry.isFile())
            {
                files.push(relative);
            }
            else
            {
                throw new Error(`${label} contains unsupported entry: ${relative}`);
            }
        }
    };
    visit(root);
    return files;
}

function fileRecord(root, relative)
{
    const absolute = assertInside(root, relative, 'artifact');
    assertNoSymlink(root, absolute, 'artifact');
    const bytes = fs.readFileSync(absolute);
    const stat = fs.statSync(absolute);
    return { path: relative, size: stat.size, sha256: sha256Buffer(bytes) };
}

function digestInput(root, declaration)
{
    const relativeRoot = normalizeRelative(declaration, 'input');
    const files = walkFiles(root, relativeRoot, 'input');
    const entries = files.map(relative => fileRecord(root, relative));
    return {
        path: relativeRoot,
        fileCount: entries.length,
        size: entries.reduce((sum, entry) => sum + entry.size, 0),
        sha256: sha256Buffer(JSON.stringify(entries))
    };
}

function validateSourceState(sourceState)
{
    const commit = String(sourceState?.commit ?? '').trim();
    const worktreeFingerprint = String(sourceState?.worktreeFingerprint ?? '').trim();
    if (!/^[a-f0-9]{40}$/u.test(commit))
    {
        throw new Error('production build receipt requires a full lowercase commit SHA');
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(worktreeFingerprint) && !/^[a-f0-9]{64}$/u.test(worktreeFingerprint))
    {
        throw new Error('production build receipt requires a SHA-256 worktree fingerprint');
    }
    return { commit, worktreeFingerprint };
}

function normalizedWorktreeFingerprint(value)
{
    const fingerprint = String(value ?? '').trim().replace(/^sha256:/u, '');
    return /^[a-f0-9]{64}$/u.test(fingerprint) ? fingerprint : null;
}

function normalizeProducer(producer = {})
{
    const runId = String(producer.runId ?? '').trim();
    const runAttempt = Number(producer.runAttempt);
    const job = String(producer.job ?? '').trim();
    if (!runId || !Number.isInteger(runAttempt) || runAttempt < 1 || !job)
    {
        throw new Error('production build receipt requires producer runId, positive runAttempt, and job');
    }
    return {
        workflow: String(producer.workflow ?? '').trim() || null,
        runId,
        runAttempt,
        job
    };
}

function normalizeToolchain(toolchain)
{
    if (!toolchain || typeof toolchain !== 'object' || Array.isArray(toolchain))
    {
        throw new Error('production build receipt requires toolchain versions');
    }
    const normalized = Object.fromEntries(Object.entries(toolchain)
        .map(([key, value]) => [String(key).trim(), String(value ?? '').trim()])
        .filter(([key, value]) => key && value)
        .sort(([left], [right]) => left.localeCompare(right)));
    for (const required of ['node', 'npm', 'dotnet', 'vite', 'vitest', 'playwright', 'emsdk'])
    {
        if (!normalized[required])
        {
            throw new Error(`production build receipt toolchain is missing ${required}`);
        }
    }
    return normalized;
}

export function createProductionBuildReceipt({
    root = defaultRoot,
    artifactRoot,
    receiptFile = 'receipt.json',
    sourceState,
    producer,
    toolchain,
    inputPaths = [],
    domains = [],
    build = {},
    now = () => new Date()
})
{
    const repositoryRoot = path.resolve(root);
    const payloadRoot = path.resolve(artifactRoot);
    if (!fs.existsSync(payloadRoot) || !fs.statSync(payloadRoot).isDirectory())
    {
        throw new Error(`production artifact root is missing: ${payloadRoot}`);
    }
    const normalizedDomains = domains.map(domain =>
    {
        const name = String(domain?.name ?? '').trim();
        const artifactPath = normalizeRelative(domain?.path, `domain ${name || '<empty>'}`);
        if (!/^[a-z][a-z0-9-]*$/u.test(name))
        {
            throw new Error(`invalid production artifact domain: ${name || '<empty>'}`);
        }
        return {
            name,
            path: artifactPath,
            consumerMode: domain.consumerMode === 'copy-before-write' ? 'copy-before-write' : 'read-only',
            files: walkFiles(payloadRoot, artifactPath, `domain ${name}`)
        };
    });
    if (normalizedDomains.length === 0 || new Set(normalizedDomains.map(domain => domain.name)).size !== normalizedDomains.length)
    {
        throw new Error('production build receipt requires unique artifact domains');
    }
    const claimedFiles = normalizedDomains.flatMap(domain => domain.files);
    if (new Set(claimedFiles).size !== claimedFiles.length)
    {
        throw new Error('artifact files cannot be owned by multiple domains');
    }
    const files = [...new Set(claimedFiles)].sort().map(relative => fileRecord(payloadRoot, relative));
    const normalizedReceiptFile = normalizeRelative(receiptFile, 'receipt');
    if (claimedFiles.includes(normalizedReceiptFile))
    {
        throw new Error('receipt cannot be part of its artifact payload');
    }
    const createdAt = now().toISOString();
    const receipt = {
        schema: productionBuildReceiptSchema,
        status: 'complete',
        sourceState: validateSourceState(sourceState),
        producer: normalizeProducer(producer),
        toolchain: normalizeToolchain(toolchain),
        inputDigests: [...new Set(inputPaths.map(value => normalizeRelative(value, 'input')))].sort()
            .map(value => digestInput(repositoryRoot, value)),
        build: {
            profile: String(build.profile ?? '').trim() || 'production-release-fresh',
            command: String(build.command ?? '').trim() || null,
            startedAt: build.startedAt ?? null,
            finishedAt: build.finishedAt ?? createdAt,
            durationMs: Number.isFinite(Number(build.durationMs)) ? Number(build.durationMs) : null
        },
        domains: normalizedDomains.map(domain => ({
            name: domain.name,
            path: domain.path,
            consumerMode: domain.consumerMode,
            fileCount: domain.files.length
        })),
        artifacts: files,
        metrics: {
            artifactCount: files.length,
            artifactBytes: files.reduce((sum, file) => sum + file.size, 0)
        },
        digestTable: {
            authority: 'receipt.artifacts',
            traversalCount: 1,
            entryCount: files.length
        },
        seal: {
            mode: 'read-only-files',
            atomicReceipt: true,
            sealedAt: createdAt
        },
        createdAt,
        contentDigest: null
    };
    receipt.contentDigest = contentDigest(receipt);
    const receiptPath = path.join(payloadRoot, normalizedReceiptFile);
    if (fs.existsSync(receiptPath))
    {
        throw new Error(`production build receipt is already sealed: ${normalizedReceiptFile}`);
    }
    for (const file of files)
    {
        chmodReadOnly(assertInside(payloadRoot, file.path, 'artifact'));
    }
    writeJsonAtomic(receiptPath, receipt);
    chmodReadOnly(receiptPath);
    return receipt;
}

function readReceipt(artifactRoot, receiptFile)
{
    const root = path.resolve(artifactRoot);
    const relative = normalizeRelative(receiptFile, 'receipt');
    const absolute = assertInside(root, relative, 'receipt');
    if (!fs.existsSync(absolute))
    {
        throw new Error(`production build receipt is missing: ${relative}`);
    }
    assertNoSymlink(root, absolute, 'receipt');
    return { root, relative, absolute, receipt: JSON.parse(fs.readFileSync(absolute, 'utf8')) };
}

export function verifyProductionBuildReceipt({
    artifactRoot,
    receiptFile = 'receipt.json',
    expectedSourceState,
    expectedProducer = {},
    expectedToolchain = null,
    expectedInputRoot = null,
    expectedReceiptDigest = null,
    transferStartedAtMs = null,
    repairReadOnlySeal = true,
    now = () => new Date()
})
{
    const startedAtMs = Date.now();
    const { root, relative, absolute: receiptPath, receipt } = readReceipt(artifactRoot, receiptFile);
    const errors = [];
    let restoredSealFiles = 0;
    try
    {
        if ((fs.statSync(receiptPath).mode & 0o222) !== 0)
        {
            if (repairReadOnlySeal)
            {
                chmodReadOnly(receiptPath);
                restoredSealFiles += 1;
            }
            else
            {
                errors.push('receipt read-only seal is missing');
            }
        }
    }
    catch (error)
    {
        errors.push(`receipt read-only seal could not be restored: ${error.message}`);
    }
    if (receipt.schema !== productionBuildReceiptSchema)
    {
        errors.push(`receipt schema mismatch: ${receipt.schema}`);
    }
    if (receipt.status !== 'complete')
    {
        errors.push(`receipt is not complete: ${receipt.status}`);
    }
    if (receipt.contentDigest !== contentDigest(receipt))
    {
        errors.push('receipt content digest mismatch');
    }
    if (receipt.digestTable?.authority !== 'receipt.artifacts'
    || Number(receipt.digestTable?.traversalCount) !== 1
    || Number(receipt.digestTable?.entryCount) !== receipt.artifacts?.length)
    {
        errors.push('receipt digest table authority is invalid');
    }
    if (receipt.seal?.mode !== 'read-only-files' || receipt.seal?.atomicReceipt !== true)
    {
        errors.push('receipt immutable seal is invalid');
    }
    if (expectedReceiptDigest && receipt.contentDigest !== expectedReceiptDigest)
    {
        errors.push('receipt digest does not match producer output');
    }
    try
    {
        validateSourceState(receipt.sourceState);
    }
    catch (error)
    {
        errors.push(error.message);
    }
    try
    {
        normalizeProducer(receipt.producer);
    }
    catch (error)
    {
        errors.push(error.message);
    }
    try
    {
        normalizeToolchain(receipt.toolchain);
    }
    catch (error)
    {
        errors.push(error.message);
    }
    if (expectedSourceState)
    {
        if (receipt.sourceState?.commit !== expectedSourceState.commit)
        {
            errors.push('receipt commit SHA mismatch');
        }
        if (normalizedWorktreeFingerprint(receipt.sourceState?.worktreeFingerprint)
            !== normalizedWorktreeFingerprint(expectedSourceState.worktreeFingerprint))
        {
            errors.push('receipt worktree fingerprint mismatch');
        }
    }
    for (const [key, value] of Object.entries(expectedProducer))
    {
        if (value !== undefined && value !== null && String(receipt.producer?.[key]) !== String(value))
        {
            errors.push(`receipt producer ${key} mismatch`);
        }
    }
    for (const [key, value] of Object.entries(expectedToolchain ?? {}))
    {
        if (String(receipt.toolchain?.[key]) !== String(value))
        {
            errors.push(`receipt toolchain ${key} mismatch`);
        }
    }
    const inputDigests = Array.isArray(receipt.inputDigests) ? receipt.inputDigests : [];
    if (inputDigests.length === 0)
    {
        errors.push('receipt input digests are missing');
    }
    const inputPaths = new Set();
    for (const record of inputDigests)
    {
        try
        {
            const inputPath = normalizeRelative(record?.path, 'input');
            if (inputPaths.has(inputPath))
            {
                errors.push(`duplicate input digest path: ${inputPath}`);
            }
            inputPaths.add(inputPath);
            if (!Number.isInteger(Number(record.fileCount)) || Number(record.fileCount) < 1
        || !Number.isInteger(Number(record.size)) || Number(record.size) < 0
        || !/^sha256:[a-f0-9]{64}$/u.test(String(record.sha256 ?? '')))
            {
                errors.push(`input digest record is invalid: ${inputPath}`);
                continue;
            }
            if (expectedInputRoot)
            {
                const actual = digestInput(path.resolve(expectedInputRoot), inputPath);
                if (actual.fileCount !== Number(record.fileCount)
          || actual.size !== Number(record.size)
          || actual.sha256 !== record.sha256)
                {
                    errors.push(`receipt input digest mismatch: ${inputPath}`);
                }
            }
        }
        catch (error)
        {
            errors.push(error.message);
        }
    }
    const domains = Array.isArray(receipt.domains) ? receipt.domains : [];
    const artifacts = Array.isArray(receipt.artifacts) ? receipt.artifacts : [];
    const artifactPaths = new Set();
    for (const record of artifacts)
    {
        let absolute;
        try
        {
            const artifactPath = normalizeRelative(record?.path, 'artifact');
            if (artifactPaths.has(artifactPath))
            {
                errors.push(`duplicate artifact path: ${artifactPath}`);
            }
            artifactPaths.add(artifactPath);
            absolute = assertInside(root, artifactPath, 'artifact');
            if (!fs.existsSync(absolute))
            {
                errors.push(`artifact is missing: ${artifactPath}`);
                continue;
            }
            assertNoSymlink(root, absolute, 'artifact');
            if (!fs.statSync(absolute).isFile())
            {
                errors.push(`artifact is not a file: ${artifactPath}`);
                continue;
            }
            const bytes = fs.readFileSync(absolute);
            if (bytes.byteLength !== Number(record.size))
            {
                errors.push(`artifact size mismatch: ${artifactPath}`);
            }
            if (sha256Buffer(bytes) !== record.sha256)
            {
                errors.push(`artifact digest mismatch: ${artifactPath}`);
            }
            if ((fs.statSync(absolute).mode & 0o222) !== 0)
            {
                if (repairReadOnlySeal)
                {
                    chmodReadOnly(absolute);
                    restoredSealFiles += 1;
                }
                else
                {
                    errors.push(`artifact read-only seal is missing: ${artifactPath}`);
                }
            }
        }
        catch (error)
        {
            errors.push(error.message);
        }
    }
    for (const domain of domains)
    {
        try
        {
            const domainPath = normalizeRelative(domain?.path, `domain ${domain?.name ?? '<empty>'}`);
            const actualFiles = walkFiles(root, domainPath, `domain ${domain?.name ?? '<empty>'}`)
                .sort(compareArtifactPaths);
            const expectedFiles = artifacts
                .filter(record => record.path === domainPath || record.path.startsWith(`${domainPath}/`))
                .map(record => record.path)
                .sort(compareArtifactPaths);
            if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles))
            {
                errors.push(`artifact domain contains unreceipted files: ${domain?.name}`);
            }
            if (actualFiles.length !== Number(domain.fileCount))
            {
                errors.push(`artifact domain file count mismatch: ${domain?.name}`);
            }
        }
        catch (error)
        {
            errors.push(error.message);
        }
    }
    try
    {
        const actualPayloadFiles = walkRootFiles(root, 'artifact root')
            .filter(value => value !== relative)
            .sort(compareArtifactPaths);
        const expectedPayloadFiles = [...artifactPaths].sort(compareArtifactPaths);
        if (JSON.stringify(actualPayloadFiles) !== JSON.stringify(expectedPayloadFiles))
        {
            errors.push('artifact root contains files not covered by the receipt');
        }
    }
    catch (error)
    {
        errors.push(error.message);
    }
    const evidence = {
        schema: productionBuildVerificationSchema,
        status: errors.length === 0 ? 'success' : 'failure',
        receipt: relative,
        receiptContentDigest: receipt.contentDigest ?? null,
        sourceState: receipt.sourceState ?? null,
        producer: receipt.producer ?? null,
        toolchain: receipt.toolchain ?? null,
        expectedToolchain: expectedToolchain ?? null,
        inputCount: inputDigests.length,
        inputsVerifiedAgainstCheckout: Boolean(expectedInputRoot),
        artifactCount: artifacts.length,
        artifactBytes: artifacts.reduce((sum, record) => sum + Number(record.size || 0), 0),
        digestAuthority: receipt.digestTable?.authority ?? 'receipt.artifacts',
        digestTraversalCount: 1,
        restoredSealFiles,
        transferDurationMs: Number.isFinite(Number(transferStartedAtMs)) ? Math.max(0, Date.now() - Number(transferStartedAtMs)) : null,
        verifiedAt: now().toISOString(),
        durationMs: Date.now() - startedAtMs,
        errors
    };
    if (errors.length > 0)
    {
        const error = new Error(`production build artifact verification failed:\n- ${errors.join('\n- ')}`);
        error.evidence = evidence;
        throw error;
    }
    return { receipt, evidence };
}

function readCanonicalRegularJson(file, label)
{
    const supplied = String(file ?? '').trim();
    const absolute = path.resolve(supplied);
    if (!supplied || supplied !== absolute)
    {
        throw new Error(`${label} path must be absolute and canonical`);
    }
    let stat;
    try
    {
        stat = fs.lstatSync(absolute);
    }
    catch
    {
        throw new Error(`${label} is missing: ${absolute}`);
    }
    if (stat.isSymbolicLink() || !stat.isFile())
    {
        throw new Error(`${label} must be a regular non-symlink file: ${absolute}`);
    }
    if (fs.realpathSync(absolute) !== absolute)
    {
        throw new Error(`${label} path is not canonical: ${absolute}`);
    }
    try
    {
        return { absolute, document: JSON.parse(fs.readFileSync(absolute, 'utf8')) };
    }
    catch (error)
    {
        throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
    }
}

function canonicalRelative(value, label)
{
    const relative = normalizeRelative(value, label);
    if (path.posix.normalize(relative) !== relative)
    {
        throw new Error(`${label} path is not canonical: ${relative}`);
    }
    return relative;
}

function canonicalValueEquals(left, right)
{
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export function verifyProductionBuildConsumerMaterialization({
    artifactRoot,
    receiptFile = 'receipt.json',
    evidenceFile,
    destinationRoot,
    runId,
    consumerId,
    mappings = [],
    requiredCandidateFiles = [],
    verification = {},
    now = () => new Date()
})
{
    const startedAtMs = Date.now();
    const sourceRoot = path.resolve(artifactRoot);
    const targetRoot = path.resolve(destinationRoot);
    if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()
        || fs.realpathSync(targetRoot) !== targetRoot)
    {
        throw new Error('consumer materialization destination root must be an existing canonical directory');
    }
    const verified = verifyProductionBuildReceipt({
        ...verification,
        artifactRoot: sourceRoot,
        receiptFile,
        repairReadOnlySeal: false,
        now
    });
    const receipt = verified.receipt;
    const { absolute: materializationEvidenceFile, document: materializationEvidence } =
        readCanonicalRegularJson(evidenceFile, 'consumer materialization evidence');
    if (materializationEvidence.schema !== productionBuildMaterializationSchema
        || materializationEvidence.status !== 'success')
    {
        throw new Error('consumer materialization evidence schema/status is invalid');
    }
    if (materializationEvidence.receiptContentDigest !== receipt.contentDigest
        || materializationEvidence.digestAuthority !== receipt.digestTable?.authority
        || Number(materializationEvidence.digestTraversalCount) !== Number(receipt.digestTable?.traversalCount))
    {
        throw new Error('consumer materialization evidence digest binding is invalid');
    }
    if (!canonicalValueEquals(materializationEvidence.sourceState, receipt.sourceState)
        || !canonicalValueEquals(materializationEvidence.producer, receipt.producer))
    {
        throw new Error('consumer materialization evidence source binding is invalid');
    }
    if (!Array.isArray(materializationEvidence.errors) || materializationEvidence.errors.length !== 0)
    {
        throw new Error('consumer materialization evidence contains verification errors');
    }

    const leaseFile = consumerLeaseFile({ artifactRoot: sourceRoot, runId, consumerId });
    const { document: lease } = readCanonicalRegularJson(leaseFile, 'consumer lease');
    const expectedLeaseIdentity = {
        schema: productionBuildLifecycleSchema,
        artifactRoot: sourceRoot,
        runId,
        consumerId,
        status: 'active'
    };
    if (!Object.entries(expectedLeaseIdentity).every(([key, value]) => lease?.[key] === value))
    {
        throw new Error('consumer lease is inactive or has the wrong artifactRoot/runId/consumerId');
    }
    const evidenceLease = materializationEvidence.consumerLease;
    if (!Object.entries(expectedLeaseIdentity).every(([key, value]) => evidenceLease?.[key] === value)
        || evidenceLease.startedAtMs !== lease.startedAtMs
        || !Number.isFinite(Number(evidenceLease.refreshedAtMs))
        || Number(evidenceLease.refreshedAtMs) > Number(lease.refreshedAtMs))
    {
        throw new Error('consumer materialization evidence lease binding is invalid');
    }

    const receiptDomains = new Map(receipt.domains.map(domain => [domain.name, domain]));
    const receiptArtifacts = new Map(receipt.artifacts.map(artifact => [artifact.path, artifact]));
    const domainEvidence = materializationEvidence.materialization?.domains;
    if (!Array.isArray(domainEvidence) || !Array.isArray(materializationEvidence.materialized))
    {
        throw new Error('consumer materialization evidence domain inventory is missing');
    }
    if (!Array.isArray(mappings) || mappings.length === 0
        || !Array.isArray(requiredCandidateFiles) || requiredCandidateFiles.length === 0)
    {
        throw new Error('consumer materialization verification requires mappings and candidate files');
    }
    const verifiedMappings = new Map();
    for (const mapping of mappings)
    {
        const name = String(mapping?.name ?? '').trim();
        const destination = canonicalRelative(mapping?.destination, `domain ${name || '<empty>'} destination`);
        const identity = `${name}\0${destination}`;
        if (verifiedMappings.has(identity))
        {
            throw new Error(`duplicate required read-only domain mapping: ${name}=${destination}`);
        }
        const domain = receiptDomains.get(name);
        if (!domain || domain.consumerMode !== 'read-only')
        {
            throw new Error(`required production artifact domain is not read-only: ${name}`);
        }
        const records = receipt.artifacts.filter(item => item.path === domain.path || item.path.startsWith(`${domain.path}/`));
        const expectedDomainEvidence = {
            name,
            destination,
            method: 'reference',
            bytes: records.reduce((sum, record) => sum + Number(record.size), 0),
            fallbackReason: null
        };
        const matchingEvidence = domainEvidence.filter(item => item?.name === name && item?.destination === destination);
        if (matchingEvidence.length !== 1 || !canonicalValueEquals(matchingEvidence[0], expectedDomainEvidence))
        {
            throw new Error(`read-only domain mapping evidence is not exact: ${name}=${destination}`);
        }
        const domainTarget = assertInside(targetRoot, destination, `domain ${name} destination`);
        let targetStat;
        try
        {
            targetStat = fs.lstatSync(domainTarget);
        }
        catch
        {
            throw new Error(`read-only domain destination is missing: ${destination}`);
        }
        if (!targetStat.isSymbolicLink())
        {
            throw new Error(`read-only domain destination is not a symlink or junction: ${destination}`);
        }
        const artifactDomain = assertInside(sourceRoot, domain.path, `domain ${name}`);
        if (fs.realpathSync(domainTarget) !== fs.realpathSync(artifactDomain))
        {
            throw new Error(`read-only domain destination target mismatch: ${destination}`);
        }
        verifiedMappings.set(identity, { name, destination, domain });
    }

    const candidates = [];
    for (const required of requiredCandidateFiles)
    {
        const name = String(required?.domain ?? '').trim();
        const artifact = canonicalRelative(required?.artifact, `candidate ${name || '<empty>'} artifact`);
        const candidate = canonicalRelative(required?.candidate, `candidate ${name || '<empty>'} destination`);
        const matchingMappings = [...verifiedMappings.values()].filter(mapping => mapping.name === name
            && path.posix.join(mapping.destination, artifact) === candidate);
        if (matchingMappings.length !== 1)
        {
            throw new Error(`required candidate lexical mapping is not exact: ${candidate}`);
        }
        const mapping = matchingMappings[0];
        const receiptPath = path.posix.join(mapping.domain.path, artifact);
        const record = receiptArtifacts.get(receiptPath);
        if (!record)
        {
            throw new Error(`required candidate is not an exact receipt artifact: ${receiptPath}`);
        }
        const candidatePath = assertInside(targetRoot, candidate, 'required candidate');
        let candidateStat;
        try
        {
            candidateStat = fs.lstatSync(candidatePath);
        }
        catch
        {
            throw new Error(`required candidate is missing: ${candidate}`);
        }
        if (candidateStat.isSymbolicLink() || !candidateStat.isFile())
        {
            throw new Error(`required candidate is not a regular non-symlink file: ${candidate}`);
        }
        const artifactPath = assertInside(sourceRoot, receiptPath, 'required receipt artifact');
        const physicalPath = fs.realpathSync(candidatePath);
        if (physicalPath !== fs.realpathSync(artifactPath))
        {
            throw new Error(`required candidate physical artifact mismatch: ${candidate}`);
        }
        if (materializationEvidence.materialized.filter(value => value === candidate).length !== 1)
        {
            throw new Error(`required candidate materialization evidence is not exact: ${candidate}`);
        }
        candidates.push({
            domain: name,
            artifact,
            candidate,
            receiptPath,
            lexicalPath: candidatePath,
            physicalPath,
            size: record.size,
            sha256: record.sha256
        });
    }

    const evidence = {
        schema: productionBuildConsumerMaterializationVerificationSchema,
        status: 'success',
        artifactRoot: sourceRoot,
        destinationRoot: targetRoot,
        evidenceFile: materializationEvidenceFile,
        leaseFile,
        runId,
        consumerId,
        receiptContentDigest: receipt.contentDigest,
        sourceState: receipt.sourceState,
        mappings: [...verifiedMappings.values()].map(({ name, destination }) => ({ name, destination })),
        candidates,
        verifiedAt: now().toISOString(),
        durationMs: Date.now() - startedAtMs
    };
    return { receipt, evidence, lease, materializationEvidence, candidates };
}

function safeDestination(root, relative)
{
    const absolute = assertInside(root, relative, 'materialization destination');
    const parent = path.dirname(absolute);
    fs.mkdirSync(parent, { recursive: true });
    const realParent = fs.realpathSync(parent);
    const allowedRoots = [fs.realpathSync(root)];
    const temporaryRoot = path.join(root, '.tmp');
    if (fs.existsSync(temporaryRoot))
    {
        allowedRoots.push(fs.realpathSync(temporaryRoot));
    }
    if (!allowedRoots.some(allowed => realParent === allowed || realParent.startsWith(`${allowed}${path.sep}`)))
    {
        throw new Error(`materialization destination escapes approved roots: ${relative}`);
    }
    return absolute;
}

function cowUnavailable(error)
{
    return new Set(['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOSYS']).has(error?.code);
}

export function materializeProductionBuildDomains({
    artifactRoot,
    receiptFile = 'receipt.json',
    destinationRoot,
    mappings,
    verification = {},
    cloneFile = (source, destination) => fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE_FORCE)
})
{
    const startedAtMs = Date.now();
    const { receipt, evidence } = verifyProductionBuildReceipt({ artifactRoot, receiptFile, ...verification });
    const sourceRoot = path.resolve(artifactRoot);
    const targetRoot = path.resolve(destinationRoot);
    const byName = new Map(receipt.domains.map(domain => [domain.name, domain]));
    const materialized = [];
    const domainEvidence = [];
    let referencedBytes = 0;
    let reflinkedBytes = 0;
    let copiedBytes = 0;
    for (const mapping of mappings)
    {
        const domain = byName.get(mapping.name);
        if (!domain)
        {
            throw new Error(`unknown production artifact domain: ${mapping.name}`);
        }
        const destination = normalizeRelative(mapping.destination, `domain ${mapping.name} destination`);
        const records = receipt.artifacts.filter(item => item.path === domain.path || item.path.startsWith(`${domain.path}/`));
        const bytes = records.reduce((sum, record) => sum + Number(record.size), 0);
        const writable = mapping.writable === true || domain.consumerMode === 'copy-before-write';
        const domainTarget = safeDestination(targetRoot, destination);
        if (!writable)
        {
            if (fs.existsSync(domainTarget))
            {
                throw new Error(`read-only materialization destination already exists: ${destination}`);
            }
            fs.symlinkSync(assertInside(sourceRoot, domain.path, `domain ${mapping.name}`), domainTarget, 'junction');
            referencedBytes += bytes;
            domainEvidence.push({
                name: mapping.name,
                destination,
                method: 'reference',
                bytes,
                fallbackReason: null
            });
            for (const record of records)
            {
                const suffix = record.path === domain.path ? path.basename(record.path) : record.path.slice(domain.path.length + 1);
                materialized.push(path.posix.join(destination, suffix));
            }
            continue;
        }
        if (fs.existsSync(domainTarget))
        {
            throw new Error(`writable materialization destination already exists: ${destination}`);
        }
        let method = 'reflink';
        let fallbackReason = null;
        const attempts = [];
        try
        {
            for (const record of records)
            {
                const suffix = record.path === domain.path ? path.basename(record.path) : record.path.slice(domain.path.length + 1);
                const target = safeDestination(targetRoot, path.posix.join(destination, suffix));
                fs.mkdirSync(path.dirname(target), { recursive: true });
                cloneFile(assertInside(sourceRoot, record.path, 'artifact'), target);
                fs.chmodSync(target, fs.statSync(target).mode | 0o200);
            }
            reflinkedBytes += bytes;
            attempts.push({ method: 'reflink', status: 'success' });
        }
        catch (error)
        {
            fs.rmSync(domainTarget, { recursive: true, force: true });
            if (!cowUnavailable(error))
            {
                throw error;
            }
            method = 'copy-fallback';
            fallbackReason = `${error?.code ?? 'ERROR'}: ${error?.message ?? String(error)}`;
            attempts.push({ method: 'reflink', status: 'unsupported', reason: fallbackReason });
            attempts.push({
                method: 'overlay',
                status: 'unsupported',
                reason: 'no pre-authorized overlay mount provider was supplied'
            });
            attempts.push({
                method: 'hardlink-writable-layer',
                status: 'unsupported',
                reason: 'no copy-up writable layer provider was supplied; unsafe bare hardlinks are forbidden'
            });
            for (const record of records)
            {
                const suffix = record.path === domain.path ? path.basename(record.path) : record.path.slice(domain.path.length + 1);
                const target = safeDestination(targetRoot, path.posix.join(destination, suffix));
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(assertInside(sourceRoot, record.path, 'artifact'), target);
                fs.chmodSync(target, fs.statSync(target).mode | 0o200);
            }
            copiedBytes += bytes;
            attempts.push({ method: 'copy-fallback', status: 'success' });
        }
        domainEvidence.push({
            name: mapping.name,
            destination,
            method,
            bytes,
            fallbackReason,
            attempts
        });
        for (const record of records)
        {
            const suffix = record.path === domain.path ? path.basename(record.path) : record.path.slice(domain.path.length + 1);
            materialized.push(path.posix.join(destination, suffix));
        }
    }
    return {
        receipt,
        copied: materialized.sort(),
        evidence: {
            ...evidence,
            schema: productionBuildMaterializationSchema,
            digestAuthority: receipt.digestTable?.authority ?? 'receipt.artifacts',
            digestTraversalCount: evidence.digestTraversalCount,
            referencedBytes,
            reflinkedBytes,
            copiedBytes,
            materializationDurationMs: Date.now() - startedAtMs,
            materialization: { domains: domainEvidence }
        }
    };
}

function lifecycleRoot(artifactRoot)
{
    return `${path.resolve(artifactRoot)}.state`;
}

function consumerLeaseFile({ artifactRoot, runId, consumerId })
{
    const normalizedRunId = String(runId ?? '').trim();
    const normalizedConsumerId = String(consumerId ?? '').trim();
    if (!normalizedRunId || !normalizedConsumerId)
    {
        throw new Error('consumer lease requires runId and consumerId');
    }
    const identity = `${normalizedRunId}--${normalizedConsumerId}`;
    if (!/^[A-Za-z0-9._-]+--[A-Za-z0-9._-]+$/u.test(identity))
    {
        throw new Error('consumer lease requires safe runId and consumerId');
    }
    return path.join(lifecycleRoot(artifactRoot), 'consumers', `${identity}.json`);
}

export function registerProductionBuildConsumer({
    artifactRoot,
    runId,
    consumerId,
    nowMs = Date.now()
})
{
    const file = consumerLeaseFile({ artifactRoot, runId, consumerId });
    const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const lease = {
        schema: productionBuildLifecycleSchema,
        artifactRoot: path.resolve(artifactRoot),
        runId,
        consumerId,
        status: 'active',
        startedAtMs: previous?.startedAtMs ?? nowMs,
        refreshedAtMs: nowMs,
        releaseReason: null
    };
    writeJsonAtomic(file, lease);
    return lease;
}

export function releaseProductionBuildConsumer({
    artifactRoot,
    runId,
    consumerId,
    reason = 'completed',
    nowMs = Date.now()
})
{
    const file = consumerLeaseFile({ artifactRoot, runId, consumerId });
    if (!fs.existsSync(file))
    {
        throw new Error('cannot release a missing production build consumer lease');
    }
    const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
    const released = {
        ...lease,
        status: 'released',
        refreshedAtMs: nowMs,
        releasedAtMs: nowMs,
        releaseReason: reason
    };
    writeJsonAtomic(file, released);
    return released;
}

function activeConsumerLeases(artifactRoot)
{
    const root = path.join(lifecycleRoot(artifactRoot), 'consumers');
    if (!fs.existsSync(root))
    {
        return [];
    }
    return fs.readdirSync(root)
        .filter(name => name.endsWith('.json'))
        .map(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')))
        .filter(lease => lease.status === 'active');
}

export function collectProductionBuildArtifactStore({
    storeRoot,
    nowMs = Date.now(),
    staleAfterMs
})
{
    if (!Number.isFinite(Number(staleAfterMs)) || Number(staleAfterMs) < 0)
    {
        throw new Error('artifact collection requires non-negative staleAfterMs');
    }
    const root = path.resolve(storeRoot);
    const removed = [];
    const protectedArtifacts = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)))
    {
        if (!entry.isDirectory() || entry.name.endsWith('.state'))
        {
            continue;
        }
        const artifactRoot = path.join(root, entry.name);
        const receiptPath = path.join(artifactRoot, 'receipt.json');
        if (!fs.existsSync(receiptPath))
        {
            continue;
        }
        let receipt;
        try
        {
            receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        }
        catch
        {
            continue;
        }
        if (receipt.schema !== productionBuildReceiptSchema || receipt.status !== 'complete')
        {
            continue;
        }
        if (activeConsumerLeases(artifactRoot).length > 0)
        {
            protectedArtifacts.push(entry.name);
            continue;
        }
        const stat = fs.statSync(artifactRoot);
        if (nowMs - stat.mtimeMs < Number(staleAfterMs))
        {
            continue;
        }
        fs.rmSync(artifactRoot, { recursive: true, force: true });
        fs.rmSync(lifecycleRoot(artifactRoot), { recursive: true, force: true });
        removed.push(entry.name);
    }
    return { removed, protected: protectedArtifacts };
}

function commandVersion(command, args = ['--version'])
{
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.status !== 0)
    {
        return 'unavailable';
    }
    return String(result.stdout || result.stderr).trim().split(/\r?\n/u)[0];
}

export function collectProductionToolchain({ root = defaultRoot, env = process.env } = {})
{
    const packageFile = path.join(root, 'src/frontend/package.json');
    const frontendPackage = fs.existsSync(packageFile) ? JSON.parse(fs.readFileSync(packageFile, 'utf8')) : {};
    const versions = { ...frontendPackage.devDependencies, ...frontendPackage.dependencies };
    return {
        node: process.version,
        npm: commandVersion(process.platform === 'win32' ? 'npm.cmd' : 'npm'),
        dotnet: commandVersion('dotnet'),
        vite: String(versions.vite ?? 'unavailable'),
        vitest: String(versions.vitest ?? 'unavailable'),
        playwright: String(versions['@playwright/test'] ?? versions.playwright ?? 'unavailable'),
        emsdk: String(env.EMSDK_VERSION ?? commandVersion('emcc'))
    };
}
