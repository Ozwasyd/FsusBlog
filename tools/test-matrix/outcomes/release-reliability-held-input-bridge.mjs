import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { types } from 'node:util';

import { adaptReleaseReliabilitySemanticOutcome } from './release-reliability-adapter.mjs';

const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
const { digestValue } = await import(new URL('../../test/release-reliability-receipt.mjs', import.meta.url));
const terminalPath = 'tools/test/release-reliability-terminal.mjs';
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function require(condition, message)
{
    if (!condition)
    {
        throw new Error(`release reliability held bridge: ${message}`);
    }
}

function record(value, label)
{
    require(value && typeof value === 'object' && !types.isProxy(value)
        && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype,
    `${label} must be plain data`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    require(Reflect.ownKeys(descriptors).every(key => typeof key === 'string'
        && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')),
    `${label} cannot contain getters or hidden fields`);
}

function pathKey(value)
{
    require(typeof value === 'string' && value.length > 0 && !value.startsWith('/')
        && !value.includes('\\') && !value.includes('\0')
        && value.split('/').every(segment => segment && segment !== '.' && segment !== '..'),
    'artifact path must be an exact repository-relative identity');
    return value;
}

function same(actual, expected, label)
{
    require(expected !== undefined && digestCanonical(actual) === digestCanonical(expected),
        `${label} differs from independent held input`);
}

function metadata(fd)
{
    const stat = fs.fstatSync(fd, { bigint: true });
    require(stat.isFile(), 'held descriptor is not a regular file');
    return { device: String(stat.dev), inode: String(stat.ino), size: String(stat.size),
        mode: String(stat.mode), modifiedNs: String(stat.mtimeNs), changedNs: String(stat.ctimeNs) };
}

function readHeld(file, expected, limits)
{
    record(file, 'held file');
    const path = pathKey(file.path);
    require(Number.isSafeInteger(file.fd) && file.fd >= 0, 'held descriptor is missing');
    const before = metadata(file.fd);
    const heldIdentity = expected.heldFileIdentities[path];
    record(heldIdentity, 'independent held file identity');
    require(Object.keys(heldIdentity).sort().join(',') === Object.keys(before).sort().join(',')
        && Object.values(heldIdentity).every(value => typeof value === 'string'),
    'independent held file identity must be exact scalar metadata');
    same(before, heldIdentity, `held file ${path} identity`);
    const size = Number(before.size);
    require(Number.isSafeInteger(size) && size >= 0 && size <= limits.maxArtifactBytes,
        'held artifact exceeds independent byte budget');
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size)
    {
        const read = fs.readSync(file.fd, bytes, offset, size - offset, offset);
        require(read > 0, 'held artifact was truncated');
        offset += read;
    }
    same(metadata(file.fd), before, `held file ${path} read fence`);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    require(digestPattern.test(expected.heldFileDigests[path]), 'independent held file digest is missing');
    same(digest, expected.heldFileDigests[path], `held file ${path} bytes`);
    return { file, before, bytes, digest };
}

function document(files, path)
{
    const held = files.get(pathKey(path));
    require(held, `required held artifact ${path} is absent`);
    const text = held.bytes.toString('utf8');
    require(Buffer.from(text).equals(held.bytes), 'held artifact is not exact UTF-8');
    const parsed = JSON.parse(text);
    record(parsed, `held artifact ${path}`);
    return parsed;
}

function seal(document, expectedDigest, label)
{
    require(digestPattern.test(expectedDigest) && document.contentDigest === expectedDigest
        && digestValue(document) === expectedDigest, `${label} seal mismatch`);
}

/**
 * Couple borrowed, independently admitted held descriptors to the outcome adapter.
 * The caller owns descriptor acquisition, canonical path admission and lifetime;
 * this bridge never opens a path, closes a descriptor, executes a scenario, issues
 * an attestation or derives expected authority from observed inputs. Positional
 * reads preserve the owner's descriptor offsets. Every descriptor is fenced
 * again after the canonical terminal API and adapter finish.
 *
 * The existing qualified attestation supports the positive retained-input route.
 * Its verifier still has no exported unqualified held-snapshot API: failed-run
 * acquisition/verification and producer semantic projection issuance remain with
 * that owner. Absence rejects; a failed candidate cannot impersonate attestation.
 * The canonical terminal module executes from its independently admitted held
 * bytes, rather than a mutable import path or a caller-supplied success callback.
 *
 * @param {object} options Adapter identities, independent expected input and held artifact locations.
 * @param {object} hostExpectedLimits Independent finite artifact count and byte budgets.
 * @returns {Promise<object>} Existing producer outcome candidate, without runtime qualification.
 */
export async function runHeldReleaseReliabilitySemanticOutcome(options, hostExpectedLimits)
{
    record(options, 'bridge options');
    record(hostExpectedLimits, 'independent host limits');
    require(Object.keys(hostExpectedLimits).sort().join(',') === 'maxArtifactBytes,maxArtifacts'
        && Number.isSafeInteger(hostExpectedLimits.maxArtifacts) && hostExpectedLimits.maxArtifacts > 0
        && Number.isSafeInteger(hostExpectedLimits.maxArtifactBytes) && hostExpectedLimits.maxArtifactBytes > 0,
    'independent finite host budgets are required');
    const { identity, inputAuthorityRefs, attemptEligibility, expected, heldInputs } = options;
    record(expected, 'independent expected inputs');
    record(expected.heldFileDigests, 'independent file digests');
    record(expected.heldFileIdentities, 'independent file identities');
    record(heldInputs, 'held input locations');
    require(Array.isArray(heldInputs.files) && !types.isProxy(heldInputs.files)
        && heldInputs.files.length > 0 && heldInputs.files.length <= hostExpectedLimits.maxArtifacts,
    'held file set is missing or exceeds independent budget');
    const files = new Map();
    for (const file of heldInputs.files)
    {
        const held = readHeld(file, expected, hostExpectedLimits);
        require(!files.has(file.path), 'duplicate held artifact');
        files.set(file.path, held);
    }
    same([...files.keys()].sort(), Object.keys(expected.heldFileDigests).sort(), 'exact held digest roster');
    same([...files.keys()].sort(), Object.keys(expected.heldFileIdentities).sort(), 'exact held identity roster');
    const finalFence = () =>
    {
        for (const held of files.values())
        {
            const reread = readHeld(held.file, expected, hostExpectedLimits);
            same(reread.before, held.before, `held file ${held.file.path} completion fence`);
        }
    };
    try
    {
        const verification = document(files, heldInputs.verificationReceiptPath);
        seal(verification, expected.verificationReceiptDigest, 'independent verification receipt');
        require(verification.schema === 'fsusblog.release-reliability-verified-attestation.v1'
            && verification.status === 'verified',
        'canonical unqualified held-snapshot verifier API is not available; verified attestation is required');
        same(verification.invocationId, expected.binding.invocationId, 'attestation invocation');
        same(verification.runId, identity.schedulerRunId, 'attestation run');
        const receipt = document(files, verification.candidate?.path);
        seal(receipt, verification.candidate.contentDigest, 'attested candidate receipt');
        same(files.get(verification.candidate.path).digest, verification.candidate.fileDigest, 'attested candidate bytes');
        require(receipt.schema === 'fsusblog.release-reliability-candidate-receipt.v1'
            && receipt.status === 'candidate' && receipt.failure === null, 'attested candidate is unqualified');
        require(Array.isArray(verification.files), 'attestation retained file manifest is missing');
        const attested = new Map();
        for (const entry of verification.files)
        {
            record(entry, 'attested file');
            require(!attested.has(pathKey(entry.path)), 'duplicate attested file');
            require(files.has(entry.path), `attested retained artifact ${entry.path} is missing`);
            same(files.get(entry.path).digest, entry.fileDigest, `attested file ${entry.path} bytes`);
            attested.set(entry.path, entry.fileDigest);
        }
        require(verification.verifier?.path === 'tools/test/verify-release-reliability-receipt.mjs',
            'canonical verifier source binding is missing');
        same(verification.verifier.fileDigest, attested.get(verification.verifier.path), 'attested verifier source');
        const runIdentity = document(files, receipt.identity?.path);
        seal(runIdentity, expected.runIdentityReference.contentDigest, 'run identity');
        same(receipt.identity, expected.runIdentityReference, 'attested run identity reference');
        require(runIdentity.schema === 'fsusblog.release-reliability-run-identity.v1'
            && runIdentity.status === 'complete', 'run identity is incomplete');
        same(runIdentity.runId, identity.schedulerRunId, 'run identity run');
        same(runIdentity.invocationId, expected.binding.invocationId, 'run identity invocation');
        same(runIdentity.sourceState?.commit, identity.sourceCommit, 'run source');
        same(`sha256:${String(runIdentity.sourceState?.worktreeFingerprint).replace(/^sha256:/u, '')}`,
            identity.worktreeFingerprint, 'run worktree');
        same(runIdentity.build?.contentDigest, identity.buildIdentity, 'run build');
        const timeline = document(files, receipt.timeline?.path);
        seal(timeline, receipt.timeline.contentDigest, 'attested timeline');
        require(Array.isArray(receipt.scenarios) && Array.isArray(heldInputs.memberPaths),
            'scenario/member held locations are missing');
        const scenarioResults = receipt.scenarios.map(reference =>
        {
            const result = document(files, reference.resultPath);
            seal(result, reference.resultContentDigest, 'attested scenario result');
            same(result.scenarioId, reference.scenarioId, 'attested scenario identity');
            return result;
        });
        const members = heldInputs.memberPaths.map(path => document(files, path));
        const receiptPaths = Object.keys(expected.receiptDigests);
        for (const path of [receipt.identity.path, receipt.timeline.path,
            ...receipt.scenarios.map(reference => reference.resultPath), ...receiptPaths])
        {
            require(files.has(path), `retained artifact ${path} is missing`);
            same(files.get(path).digest, attested.get(path), `attested retained file ${path}`);
        }
        for (const path of receiptPaths)
        {
            same(files.get(path).digest, expected.receiptDigests[path], `retained receipt ${path}`);
        }
        const source = files.get(terminalPath);
        require(source && inputAuthorityRefs.some(reference => reference.kind === 'reliability-terminal-module'
            && reference.path === terminalPath && reference.digest === source.digest), 'held canonical terminal source is missing');
        const api = await import(`data:text/javascript;base64,${source.bytes.toString('base64')}`);
        require(typeof api.verifyTerminalEvents === 'function' && typeof api.createTerminalEvents === 'function',
            'canonical terminal verification API is absent');
        require(api.verifyTerminalEvents(timeline.terminalEvents, scenarioResults) === true,
            'canonical terminal verification failed');
        const binding = members[0]?.binding;
        const result = adaptReleaseReliabilitySemanticOutcome({ identity, inputAuthorityRefs,
            attemptEligibility, expected, evidence: { binding, timeline, scenarioResults, members } });
        finalFence();
        return result;
    }
    catch (error)
    {
        finalFence();
        throw error;
    }
}
