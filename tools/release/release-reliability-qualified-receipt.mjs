import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { requireCleanAttemptConsumerAdmission } from './browser-release-clean-attempt-consumers.mjs';

export const releaseReliabilityAuthorityId = 'release-reliability-fresh';
export const releaseReliabilityQualifiedReceiptSchema =
    'fsusblog.release-reliability-qualified-receipt.v3';
export const releaseReliabilityScenarioIds = [
    'release-data-scale-m',
    'release-load-burst',
    'release-load-peak',
    'release-memory-leak-budget',
    'release-mutation-critical-slice',
    'release-open-handle-budget',
    'release-soak-min'
];

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const producerCommand = './tools/test.sh ci-tier release-reliability-fresh';
const projectionKeys = [
    'authorityId',
    'buildIdentity',
    'contentDigest',
    'receiptPath',
    'scenarioIds',
    'sourceIdentity',
    'verificationStatus'
].sort();

function compareText(left, right)
{
    return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedFingerprint(value)
{
    const normalized = String(value ?? '').replace(/^sha256:/u, '');
    return /^[a-f0-9]{64}$/u.test(normalized) ? `sha256:${normalized}` : null;
}

function isRecord(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!isRecord(value))
    {
        return value;
    }
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
}

function semanticDigest(document)
{
    const content = { ...document };
    delete content.contentDigest;
    return `sha256:${createHash('sha256')
        .update(JSON.stringify(canonicalize(content)))
        .digest('hex')}`;
}

function fileDigest(file)
{
    return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function canonicalRepositoryRoot(repositoryRoot)
{
    const requestedRoot = path.resolve(repositoryRoot);
    if (!fs.existsSync(requestedRoot))
    {
        throw new Error(`release reliability repository root is missing: ${requestedRoot}`);
    }
    const root = fs.realpathSync(requestedRoot);
    const metadata = fs.lstatSync(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || fs.realpathSync(root) !== root)
    {
        throw new Error('release reliability repository root must be one real canonical directory');
    }
    return root;
}

function safeRelativePath(repositoryRoot, value, label)
{
    const relative = String(value ?? '').trim().replaceAll('\\', '/');
    const normalized = relative.replace(/^\.\//u, '');
    const segments = normalized.split('/');
    if (!normalized || path.posix.isAbsolute(normalized)
        || path.posix.normalize(normalized) !== normalized
        || segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    {
        throw new Error(`${label} path is unsafe: ${normalized || '<missing>'}`);
    }
    const absolute = path.resolve(repositoryRoot, normalized);
    const prefix = `${repositoryRoot}${path.sep}`;
    if (!absolute.startsWith(prefix))
    {
        throw new Error(`${label} path escapes the repository: ${normalized}`);
    }
    return { absolute, relative: normalized };
}

function readCanonicalJson(repositoryRoot, value, label)
{
    const resolved = safeRelativePath(repositoryRoot, value, label);
    if (!fs.existsSync(resolved.absolute))
    {
        throw new Error(`${label} is missing: ${resolved.relative}`);
    }
    const metadata = fs.lstatSync(resolved.absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()
        || fs.realpathSync(resolved.absolute) !== resolved.absolute)
    {
        throw new Error(`${label} must be one real canonical file: ${resolved.relative}`);
    }
    try
    {
        return {
            ...resolved,
            document: JSON.parse(fs.readFileSync(resolved.absolute, 'utf8'))
        };
    }
    catch (error)
    {
        throw new Error(`${label} is not valid JSON: ${resolved.relative}`, { cause: error });
    }
}

function qualifiedReceiptFiles(repositoryRoot)
{
    const receiptRoot = path.join(repositoryRoot, '.tmp/release-reliability');
    if (!fs.existsSync(receiptRoot))
    {
        return [];
    }
    const rootMetadata = fs.lstatSync(receiptRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
        || fs.realpathSync(receiptRoot) !== receiptRoot)
    {
        throw new Error('.tmp/release-reliability must be one real canonical directory');
    }
    const files = [];
    for (const entry of fs.readdirSync(receiptRoot, { withFileTypes: true })
        .sort((left, right) => compareText(left.name, right.name)))
    {
        if (entry.isSymbolicLink())
        {
            throw new Error(
                `release reliability authority root contains a symlink entry: `
                + `.tmp/release-reliability/${entry.name}`
            );
        }
        if (!entry.isDirectory())
        {
            continue;
        }
        const relative = `.tmp/release-reliability/${entry.name}/qualified-receipt.json`;
        const file = path.join(repositoryRoot, relative);
        if (!fs.existsSync(file))
        {
            continue;
        }
        const metadata = fs.lstatSync(file);
        if (!metadata.isFile() || metadata.isSymbolicLink() || fs.realpathSync(file) !== file)
        {
            throw new Error(`qualified receipt must be one real canonical file: ${relative}`);
        }
        files.push({ absolute: file, relative });
    }
    return files;
}

export function runIndependentReleaseReliabilityVerifier({
    repositoryRoot,
    receiptPath
})
{
    const verifier = path.join(
        repositoryRoot,
        'tools/test/verify-release-reliability-receipt.mjs'
    );
    const result = spawnSync(process.execPath, [
        verifier,
        '--root',
        repositoryRoot,
        '--receipt',
        receiptPath
    ], {
        cwd: repositoryRoot,
        encoding: 'utf8'
    });
    if (result.error)
    {
        throw new Error(
            `independent release reliability verifier could not start: ${result.error.message}`
        );
    }
    if (result.status !== 0)
    {
        const detail = String(result.stderr ?? '').trim()
            || String(result.stdout ?? '').trim()
            || `exit ${result.status ?? 'unknown'}`;
        throw new Error(
            `independent release reliability verifier rejected ${receiptPath}: ${detail}; `
            + `reproduce with: node tools/test/verify-release-reliability-receipt.mjs `
            + `--receipt ${receiptPath}; produce with: ${producerCommand}`
        );
    }
}

function requiredBinding(value, label)
{
    if (!isRecord(value) || typeof value.path !== 'string'
        || !digestPattern.test(String(value.fileDigest ?? '')))
    {
        throw new Error(`${label} path/fileDigest binding is missing`);
    }
    return structuredClone(value);
}

function safeProjectedPath(value)
{
    const original = String(value ?? '').trim();
    const relative = original.replaceAll('\\', '/');
    const segments = relative.split('/');
    return original === relative
        && relative.length > 0
        && !path.posix.isAbsolute(relative)
        && path.posix.normalize(relative) === relative
        && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function validateProjectedFileBinding(value, label, { requireContentDigest = false } = {})
{
    const errors = [];
    if (!isRecord(value) || !safeProjectedPath(value.path)
        || !digestPattern.test(String(value.fileDigest ?? '')))
    {
        errors.push(`${label} path/fileDigest binding is invalid`);
    }
    if (requireContentDigest
        && !digestPattern.test(String(value?.contentDigest ?? '')))
    {
        errors.push(`${label} contentDigest binding is invalid`);
    }
    return errors;
}

export function projectQualifiedReceipt(repositoryRoot, selected)
{
    const qualifiedFile = readCanonicalJson(
        repositoryRoot,
        selected.relative,
        'release reliability qualified receipt'
    );
    const receipt = qualifiedFile.document;
    if (receipt?.schema !== releaseReliabilityQualifiedReceiptSchema
        || receipt.status !== 'qualified'
        || receipt.failure !== null
        || receipt.contentDigest !== semanticDigest(receipt))
    {
        throw new Error(
            'release reliability qualified receipt schema/status/failure/contentDigest is invalid'
        );
    }
    const expectedReceiptPath =
        `.tmp/release-reliability/${receipt.invocationId}/qualified-receipt.json`;
    if (qualifiedFile.relative !== expectedReceiptPath)
    {
        throw new Error(
            `release reliability qualified receipt path mismatch: expected ${expectedReceiptPath}`
        );
    }
    const candidateFile = readCanonicalJson(
        repositoryRoot,
        receipt.candidate?.path,
        'release reliability candidate receipt'
    );
    const candidate = candidateFile.document;
    if (candidate?.schema !== 'fsusblog.release-reliability-candidate-receipt.v1'
        || candidate.status !== 'candidate'
        || candidate.invocationId !== receipt.invocationId
        || candidate.runId !== receipt.runId
        || candidate.contentDigest !== semanticDigest(candidate)
        || candidate.contentDigest !== receipt.candidate?.contentDigest
        || fileDigest(candidateFile.absolute) !== receipt.candidate?.fileDigest)
    {
        throw new Error('verified release reliability candidate envelope is invalid');
    }
    const identityFile = readCanonicalJson(
        repositoryRoot,
        candidate.identity?.path,
        'release reliability run identity'
    );
    const identity = identityFile.document;
    if (identity?.schema !== 'fsusblog.release-reliability-run-identity.v1'
        || identity.status !== 'complete'
        || identity.invocationId !== receipt.invocationId
        || identity.runId !== receipt.runId
        || identity.contentDigest !== semanticDigest(identity)
        || identity.contentDigest !== candidate.identity?.contentDigest)
    {
        throw new Error('verified release reliability run identity envelope is invalid');
    }
    const attestationFile = readCanonicalJson(
        repositoryRoot,
        receipt.attestation?.path,
        'release reliability verified attestation'
    );
    if (attestationFile.document?.schema
            !== 'fsusblog.release-reliability-verified-attestation.v1'
        || attestationFile.document.status !== 'verified'
        || attestationFile.document.contentDigest
            !== semanticDigest(attestationFile.document)
        || attestationFile.document.contentDigest
            !== receipt.attestation?.contentDigest
        || fileDigest(attestationFile.absolute) !== receipt.attestation?.fileDigest)
    {
        throw new Error('release reliability verified attestation envelope is invalid');
    }
    const scenarioIds = Array.isArray(candidate.scenarios)
        ? candidate.scenarios.map((scenario) => scenario?.scenarioId)
        : [];
    if (JSON.stringify(scenarioIds) !== JSON.stringify(releaseReliabilityScenarioIds))
    {
        throw new Error(
            'verified release reliability candidate must reference the exact seven canonical scenario IDs'
        );
    }
    for (const scenario of candidate.scenarios)
    {
        if (typeof scenario.resultPath !== 'string'
            || typeof scenario.evidencePath !== 'string'
            || !digestPattern.test(String(scenario.resultContentDigest ?? ''))
            || !digestPattern.test(String(scenario.evidenceDigest ?? '')))
        {
            throw new Error(
                `verified release reliability scenario reference is incomplete: `
                + `${scenario.scenarioId ?? '<missing>'}`
            );
        }
    }
    const sourceIdentity = {
        invocationId: receipt.invocationId,
        runId: receipt.runId,
        commit: identity.sourceState?.commit,
        worktreeFingerprint: normalizedFingerprint(
            identity.sourceState?.worktreeFingerprint
        ),
        dirtyPathCount: identity.sourceState?.dirtyPathCount,
        hashedPathCount: identity.sourceState?.hashedPathCount
    };
    if (!/^[a-f0-9]{40}$/u.test(String(sourceIdentity.commit ?? ''))
        || sourceIdentity.worktreeFingerprint === null)
    {
        throw new Error('verified release reliability source commit/worktree identity is incomplete');
    }
    const build = requiredBinding(identity.build, 'release reliability build receipt');
    if (!digestPattern.test(String(build.contentDigest ?? '')))
    {
        throw new Error('release reliability build receipt contentDigest is missing');
    }
    const fixture = isRecord(identity.fixture)
        ? structuredClone(identity.fixture)
        : null;
    const machine = isRecord(identity.machine)
        ? structuredClone(identity.machine)
        : null;
    const policy = isRecord(identity.policy)
        ? structuredClone(identity.policy)
        : null;
    if (!fixture || !machine || !policy)
    {
        throw new Error('release reliability fixture/machine/policy identity is missing');
    }
    for (const [field, label] of [
        ['config', 'fixture config'],
        ['schema', 'fixture schema'],
        ['seed', 'fixture seed'],
        ['auditRetentionPolicy', 'fixture audit retention policy'],
        ['topology', 'runtime topology']
    ])
    {
        requiredBinding(fixture[field], `release reliability ${label}`);
    }
    for (const [field, label] of [
        ['catalog', 'scenario catalog'],
        ['threshold', 'threshold policy'],
        ['mutationSubset', 'mutation subset policy'],
        ['releaseResource', 'release resource policy']
    ])
    {
        requiredBinding(policy[field], `release reliability ${label}`);
    }
    if (!isRecord(receipt.buildIdentity)
        || !digestPattern.test(String(receipt.buildIdentity.imageDigest ?? ''))
        || receipt.buildIdentity.revision !== sourceIdentity.commit)
    {
        throw new Error('release reliability terminal image identity is incomplete or mismatched');
    }
    return {
        authorityId: releaseReliabilityAuthorityId,
        receiptPath: qualifiedFile.relative,
        contentDigest: receipt.contentDigest,
        sourceIdentity,
        buildIdentity: {
            terminalReceiptFileDigest: fileDigest(qualifiedFile.absolute),
            candidate: structuredClone(receipt.candidate),
            attestation: structuredClone(receipt.attestation),
            identity: {
                path: identityFile.relative,
                fileDigest: fileDigest(identityFile.absolute),
                contentDigest: identity.contentDigest
            },
            build,
            image: structuredClone(receipt.buildIdentity),
            imageAuthority: structuredClone(identity.build.image),
            fixture,
            machine,
            topology: structuredClone(identity.fixture.topology),
            policy,
            tools: structuredClone(identity.tools),
            evidence: structuredClone(candidate.scenarios)
        },
        scenarioIds,
        verificationStatus: 'verified'
    };
}

export function validateReleaseReliabilityQualifiedBinding(binding, {
    expectedCommit = null,
    expectedWorktreeFingerprint = null,
    expectedBuildReceiptContentDigest = null,
    expectedImageDigest = null
} = {})
{
    const errors = [];
    if (!isRecord(binding))
    {
        return ['release reliability qualified binding must be an object'];
    }
    if (JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify(projectionKeys))
    {
        errors.push('release reliability qualified binding must contain exactly seven audit fields');
    }
    if (binding.authorityId !== releaseReliabilityAuthorityId)
    {
        errors.push(`release reliability authorityId must be ${releaseReliabilityAuthorityId}`);
    }
    if (!/^\.tmp\/release-reliability\/[A-Za-z0-9][A-Za-z0-9_.-]*\/qualified-receipt\.json$/u
        .test(String(binding.receiptPath ?? '')))
    {
        errors.push('release reliability receiptPath is not canonical');
    }
    if (!digestPattern.test(String(binding.contentDigest ?? '')))
    {
        errors.push('release reliability contentDigest is invalid');
    }
    if (binding.verificationStatus !== 'verified')
    {
        errors.push('release reliability verificationStatus must be verified');
    }
    if (JSON.stringify(binding.scenarioIds) !== JSON.stringify(releaseReliabilityScenarioIds))
    {
        errors.push('release reliability scenarioIds must be the exact seven canonical IDs');
    }
    const source = binding.sourceIdentity;
    if (!isRecord(source) || !/^[a-f0-9]{40}$/u.test(String(source.commit ?? ''))
        || normalizedFingerprint(source.worktreeFingerprint) === null
        || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(
            String(source.invocationId ?? '')
        )
        || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(String(source.runId ?? ''))
        || !Number.isInteger(source.dirtyPathCount) || source.dirtyPathCount < 0
        || !Number.isInteger(source.hashedPathCount) || source.hashedPathCount < 0)
    {
        errors.push('release reliability sourceIdentity is invalid');
    }
    const invocationRoot =
        `.tmp/release-reliability/${source?.invocationId ?? '<missing>'}`;
    if (binding.receiptPath !== `${invocationRoot}/qualified-receipt.json`)
    {
        errors.push('release reliability receipt/source invocation binding is invalid');
    }
    const identity = binding.buildIdentity;
    if (!isRecord(identity))
    {
        errors.push('release reliability buildIdentity is required');
        return errors;
    }
    if (!digestPattern.test(String(identity.terminalReceiptFileDigest ?? '')))
    {
        errors.push('release reliability terminal receipt file digest is invalid');
    }
    errors.push(...validateProjectedFileBinding(
        identity.candidate,
        'release reliability candidate',
        { requireContentDigest: true }
    ));
    errors.push(...validateProjectedFileBinding(
        identity.attestation,
        'release reliability attestation',
        { requireContentDigest: true }
    ));
    errors.push(...validateProjectedFileBinding(
        identity.identity,
        'release reliability run identity',
        { requireContentDigest: true }
    ));
    if (identity.candidate?.path !== `${invocationRoot}/candidate-receipt.json`
        || identity.attestation?.path
            !== `${invocationRoot}/verified-attestation.json`
        || identity.identity?.path !== `${invocationRoot}/identity.json`)
    {
        errors.push('release reliability terminal reference paths are mismatched');
    }
    errors.push(...validateProjectedFileBinding(
        identity.build,
        'release reliability production build',
        { requireContentDigest: true }
    ));
    if (identity.build?.imageDigest !== identity.image?.imageDigest)
    {
        errors.push('release reliability production build binding is invalid');
    }
    if (!digestPattern.test(String(identity.image?.imageDigest ?? ''))
        || identity.image?.revision !== source?.commit)
    {
        errors.push('release reliability image binding is invalid');
    }
    if (!isRecord(identity.imageAuthority)
        || identity.imageAuthority.imageDigest !== identity.image?.imageDigest
        || identity.imageAuthority.revision !== source?.commit)
    {
        errors.push('release reliability inspected image authority is invalid');
    }
    if (!isRecord(identity.fixture) || !isRecord(identity.machine)
        || !isRecord(identity.topology) || !isRecord(identity.policy))
    {
        errors.push('release reliability fixture/machine/topology/policy binding is incomplete');
    }
    for (const field of [
        'config',
        'schema',
        'seed',
        'auditRetentionPolicy',
        'topology'
    ])
    {
        errors.push(...validateProjectedFileBinding(
            identity.fixture?.[field],
            `release reliability fixture.${field}`
        ));
    }
    errors.push(...validateProjectedFileBinding(
        identity.machine?.schedulerPolicy,
        'release reliability machine scheduler policy'
    ));
    for (const field of ['catalog', 'threshold', 'mutationSubset', 'releaseResource'])
    {
        errors.push(...validateProjectedFileBinding(
            identity.policy?.[field],
            `release reliability policy.${field}`
        ));
    }
    if (!digestPattern.test(String(
        identity.policy?.childEnvironment?.contentDigest ?? ''
    )))
    {
        errors.push('release reliability child environment policy digest is invalid');
    }
    if (!digestPattern.test(String(identity.topology?.fileDigest ?? ''))
        || !digestPattern.test(String(identity.topology?.content?.contentDigest ?? ''))
        || JSON.stringify(identity.topology)
            !== JSON.stringify(identity.fixture?.topology))
    {
        errors.push('release reliability topology binding is invalid');
    }
    if (!Array.isArray(identity.tools) || identity.tools.length === 0)
    {
        errors.push('release reliability tool identity binding is incomplete');
    }
    const evidence = identity.evidence;
    if (!Array.isArray(evidence)
        || JSON.stringify(evidence.map((entry) => entry?.scenarioId))
            !== JSON.stringify(releaseReliabilityScenarioIds)
        || evidence.some((entry) => (
            !safeProjectedPath(entry?.resultPath)
            || !safeProjectedPath(entry?.evidencePath)
            || !digestPattern.test(String(entry?.resultContentDigest ?? ''))
            || !digestPattern.test(String(entry?.evidenceDigest ?? ''))
        )))
    {
        errors.push('release reliability exact-seven evidence digest binding is invalid');
    }
    if (expectedCommit && source?.commit !== expectedCommit)
    {
        errors.push(
            `release reliability source commit mismatch: expected ${expectedCommit}, `
            + `got ${source?.commit ?? 'missing'}`
        );
    }
    if (expectedWorktreeFingerprint
        && normalizedFingerprint(source?.worktreeFingerprint)
            !== normalizedFingerprint(expectedWorktreeFingerprint))
    {
        errors.push('release reliability worktree fingerprint mismatch');
    }
    if (expectedBuildReceiptContentDigest
        && identity.build?.contentDigest !== expectedBuildReceiptContentDigest)
    {
        errors.push('release reliability production build receipt contentDigest mismatch');
    }
    if (expectedImageDigest && identity.image?.imageDigest !== expectedImageDigest)
    {
        errors.push(
            `release reliability image digest mismatch: expected ${expectedImageDigest}, `
            + `got ${identity.image?.imageDigest ?? 'missing'}`
        );
    }
    return errors;
}

export function locateReleaseReliabilityQualifiedReceipt({
    repositoryRoot,
    expectedCommit = null,
    expectedWorktreeFingerprint = null,
    expectedBuildReceiptContentDigest = null,
    expectedImageDigest = null,
    attemptEvidence = null,
    expectedCandidate = null,
    verifyQualifiedReceipt = runIndependentReleaseReliabilityVerifier
})
{
    const root = canonicalRepositoryRoot(repositoryRoot);
    const matches = qualifiedReceiptFiles(root);
    if (matches.length === 0)
    {
        throw new Error(
            'release-reliability-fresh qualified receipt is missing at '
            + '.tmp/release-reliability/*/qualified-receipt.json; '
            + `produce with: ${producerCommand}`
        );
    }
    if (matches.length > 1)
    {
        throw new Error(
            'ambiguous release-reliability-fresh qualified receipts: '
            + `${matches.map((entry) => entry.relative).join(', ')}; `
            + 'retain exactly one canonical qualified receipt'
        );
    }
    const selected = matches[0];
    verifyQualifiedReceipt({
        repositoryRoot: root,
        receiptPath: selected.relative
    });
    const binding = projectQualifiedReceipt(root, selected);
    const errors = validateReleaseReliabilityQualifiedBinding(binding, {
        expectedCommit,
        expectedWorktreeFingerprint,
        expectedBuildReceiptContentDigest,
        expectedImageDigest
    });
    if (errors.length > 0)
    {
        throw new Error(
            `${errors.join('; ')}; produce with: ${producerCommand}`
        );
    }
    requireCleanAttemptConsumerAdmission({
        consumerId: 'release-reliability',
        attemptEvidence,
        expectedCandidate,
        candidateBinding: { sourceCommit: binding.sourceIdentity.commit,
            worktreeFingerprint: binding.sourceIdentity.worktreeFingerprint,
            schedulerRunId: binding.sourceIdentity.runId, buildIdentity: binding.buildIdentity.build.contentDigest },
        repositoryRoot: root
    });
    return binding;
}
