import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const generatedOutputDigestRepairSchema = 'fsusblog.post-merge-generated-output-repair.v2';

const revisionPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const objectPattern = /^[a-f0-9]{40}$/u;
const pathPattern = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;
const maximumBlobBytes = 16 * 1024 * 1024;
const maximumHistoryRevisions = 128;
const maximumClosurePaths = 256;
const regularBlobModes = new Set(['100644', '100755']);

function requireValue(condition, message)
{
    if (!condition)
    {
        throw new Error(`generated digest repair v2: ${message}`);
    }
}

function exactKeys(value, keys, label)
{
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
        && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()), `${label} has an invalid closed shape`);
}

function exactPaths(paths, label)
{
    requireValue(Array.isArray(paths) && paths.length > 0 && paths.length <= maximumClosurePaths
        && paths.every((value) => typeof value === 'string' && pathPattern.test(value))
        && isDeepStrictEqual(paths, [...new Set(paths)].sort()), `${label} must be unique sorted repository paths`);
}

function same(left, right, label)
{
    requireValue(isDeepStrictEqual(left, right), label);
}

function sha256(bytes)
{
    return createHash('sha256').update(bytes).digest('hex');
}

function canonicalValue(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalValue);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
    }
    return value;
}

function contentDigest(value)
{
    return `sha256:${sha256(JSON.stringify(canonicalValue(value)))}`;
}

function validateIdentity(identity, label)
{
    exactKeys(identity, ['mode', 'object', 'sha256'], label);
    requireValue(regularBlobModes.has(identity.mode) && objectPattern.test(identity.object)
        && digestPattern.test(identity.sha256), `${label} must bind a regular blob mode, Git object and SHA-256`);
}

function observedBlob(blob, label, { git = false } = {})
{
    exactKeys(blob, git ? ['mode', 'object', 'bytes'] : ['mode', 'bytes'], label);
    requireValue(regularBlobModes.has(blob.mode) && Buffer.isBuffer(blob.bytes)
        && blob.bytes.length <= maximumBlobBytes
        && (!git || objectPattern.test(blob.object)), `${label} is not a bounded regular blob`);
    return {
        identity: { mode: blob.mode, ...(git ? { object: blob.object } : {}), sha256: sha256(blob.bytes) },
        bytes: blob.bytes
    };
}

function validateProducer(producer)
{
    exactKeys(producer, ['id', 'repairClass', 'manifest', 'command', 'closure', 'digestInputs',
        'output', 'outputSchema', 'protectedPolicyPaths', 'qualification'], 'trusted producer');
    requireValue(producer.id === 'correctness-attempt-producers' && producer.repairClass === 'digest-refresh',
        'producer or repair class is not supported');
    requireValue(pathPattern.test(producer.manifest) && pathPattern.test(producer.output)
        && producer.manifest !== producer.output, 'trusted producer paths are invalid');
    exactKeys(producer.command, ['executable', 'arguments'], 'trusted command');
    requireValue(producer.command.executable === 'node' && Array.isArray(producer.command.arguments)
        && producer.command.arguments.length === 2 && pathPattern.test(producer.command.arguments[0])
        && producer.command.arguments[1] === '--write', 'trusted canonical command is invalid');
    exactPaths(producer.closure, 'trusted closure');
    exactPaths(producer.digestInputs, 'trusted digest inputs');
    exactPaths(producer.protectedPolicyPaths, 'trusted policy paths');
    requireValue(producer.closure.includes(producer.command.arguments[0])
        && producer.digestInputs.every((entry) => producer.closure.includes(entry))
        && !producer.closure.includes(producer.output)
        && !producer.closure.includes(producer.manifest), 'trusted closure is incomplete or contains output metadata');
    requireValue(producer.outputSchema === 'fsusblog.correctness-attempt-producers.v1',
        'trusted output schema is unsupported');
    exactKeys(producer.qualification, ['sourceParent', 'sourceCommit', 'mergedPullRequest',
        'mergeCommit', 'outerBaseCommit', 'outerHeadCommit'],
    'trusted source qualification');
    for (const revision of [producer.qualification.sourceParent, producer.qualification.sourceCommit,
        producer.qualification.mergeCommit, producer.qualification.outerBaseCommit,
        producer.qualification.outerHeadCommit])
    {
        requireValue(revisionPattern.test(revision), 'trusted source qualification revision is invalid');
    }
    requireValue(Number.isSafeInteger(producer.qualification.mergedPullRequest)
        && producer.qualification.mergedPullRequest > 0,
    'trusted source qualification pull request is invalid');
    requireValue(producer.qualification.sourceParent === producer.qualification.outerBaseCommit,
        'trusted source qualification parent must equal the outer merge base');
}

function validateManifest(evidence, producer, base, head, changedFiles)
{
    exactKeys(evidence, ['schema', 'producerId', 'repairClass', 'sourceParent', 'sourceCommit',
        'mergedPullRequest', 'mergeCommit', 'outerBaseCommit',
        'outerHeadCommit', 'baseCommit', 'command', 'closure', 'output'], 'manifest');
    requireValue(evidence.schema === generatedOutputDigestRepairSchema && evidence.producerId === producer.id
        && evidence.repairClass === producer.repairClass, 'schema, producer or repair class mismatch');
    for (const revision of [evidence.sourceParent, evidence.sourceCommit, evidence.mergeCommit,
        evidence.outerBaseCommit, evidence.outerHeadCommit, evidence.baseCommit, base, head])
    {
        requireValue(typeof revision === 'string' && revisionPattern.test(revision), 'complete revision identities are required');
    }
    requireValue(evidence.baseCommit === base && base !== head,
        'candidate base identity mismatch');
    for (const [label, actual, expected] of [
        ['source parent', evidence.sourceParent, producer.qualification.sourceParent],
        ['source commit', evidence.sourceCommit, producer.qualification.sourceCommit],
        ['merged pull request', evidence.mergedPullRequest, producer.qualification.mergedPullRequest],
        ['merge commit', evidence.mergeCommit, producer.qualification.mergeCommit],
        ['outer base', evidence.outerBaseCommit, producer.qualification.outerBaseCommit],
        ['outer head', evidence.outerHeadCommit, producer.qualification.outerHeadCommit]
    ])
    {
        requireValue(actual === expected, `${label} does not match the trusted canonical qualification`);
    }
    requireValue(Number.isSafeInteger(evidence.mergedPullRequest) && evidence.mergedPullRequest > 0,
        'merged pull request identity is invalid');
    same(evidence.command, producer.command, 'manifest cannot choose a different command');
    requireValue(Array.isArray(evidence.closure) && evidence.closure.length === producer.closure.length,
        'manifest closure cardinality mismatch');
    same(evidence.closure.map((entry) => entry?.path), producer.closure, 'manifest closure differs from trusted closure');
    for (const entry of evidence.closure)
    {
        exactKeys(entry, ['path', 'parent', 'source'], 'closure entry');
        validateIdentity(entry.parent, 'parent closure identity');
        validateIdentity(entry.source, 'source closure identity');
    }
    exactKeys(evidence.output, ['path', 'parent', 'source', 'base', 'expected', 'candidate'], 'output binding');
    requireValue(evidence.output.path === producer.output, 'manifest cannot choose a different output');
    for (const key of ['parent', 'source', 'base', 'expected', 'candidate'])
    {
        validateIdentity(evidence.output[key], `output ${key}`);
    }
    same([...changedFiles].sort(), [producer.manifest, producer.output].sort(),
        'repair candidate must change only its exact manifest and output');
}

/**
 * Validate digest-only repair policy against a trusted repository adapter.
 *
 * The adapter is constructed by the trusted-base checker, never by the repair
 * manifest. It must read exact Git blobs with replacements disabled and run
 * fresh isolated producers with only the canonical output writable. This core
 * does not confer trust on adapter-supplied filesystem or process observations.
 */
export function verifyGeneratedOutputDigestRepairV2({ evidence, producer, repository, base, head, changedFiles })
{
    validateProducer(producer);
    validateManifest(evidence, producer, base, head, changedFiles);
    requireValue(repository?.authorityRevision === base, 'repository adapter must be bound to the trusted base');
    const closure = new Map(evidence.closure.map((entry) => [entry.path, entry]));
    const blobCache = new Map();
    const readBlob = (revision, file) =>
    {
        const key = `${revision}:${file}`;
        if (!blobCache.has(key))
        {
            blobCache.set(key, observedBlob(repository.blob(revision, file), key, { git: true }));
        }
        return blobCache.get(key);
    };
    const commit = (revision) =>
    {
        const value = repository.commit(revision);
        exactKeys(value, ['commit', 'parents', 'subject', 'message'], 'commit observation');
        requireValue(value.commit === revision && Array.isArray(value.parents)
            && value.parents.every((entry) => revisionPattern.test(entry)) && typeof value.subject === 'string'
            && typeof value.message === 'string',
        'commit observation is not exact');
        return value;
    };
    const source = commit(evidence.sourceCommit);
    same(source.parents, [evidence.sourceParent], 'source commit must have the exact recorded single parent');
    const merge = commit(evidence.mergeCommit);
    requireValue(merge.parents.length === 2
        && new RegExp(`^Merge pull request #${evidence.mergedPullRequest}\\b`, 'u').test(merge.subject),
    'merge commit does not identify the recorded merged pull request');
    const [mergeBase, mergeHead] = merge.parents;
    requireValue(evidence.sourceParent === mergeBase && evidence.outerBaseCommit === mergeBase
        && evidence.outerHeadCommit === mergeHead
        && repository.isAncestor(evidence.mergeCommit, base)
        && repository.isAncestor(base, head), 'source, merge, base or candidate ancestry mismatch');
    const branch = repository.firstParentRevisions(mergeBase, mergeHead, maximumHistoryRevisions);
    requireValue(Array.isArray(branch) && branch.length > 0 && branch.length <= maximumHistoryRevisions
        && new Set(branch).size === branch.length && branch.includes(evidence.sourceCommit),
    'source commit is outside the bounded pull request first-parent history');
    const sourceChanges = repository.changedPaths(evidence.sourceParent, evidence.sourceCommit);
    requireValue(Array.isArray(sourceChanges) && sourceChanges.some((entry) => closure.has(entry))
        && !sourceChanges.includes(producer.output)
        && !sourceChanges.some((entry) => producer.protectedPolicyPaths.includes(entry)),
    'source event must change its closure without changing output or trusted policy');

    // Finish all source/history/shape preflight before executing any producer.
    for (const [file, binding] of closure)
    {
        same(readBlob(evidence.sourceParent, file).identity, binding.parent, `parent closure blob mismatch: ${file}`);
        same(readBlob(evidence.sourceCommit, file).identity, binding.source, `source closure blob mismatch: ${file}`);
        same(binding.parent.mode, binding.source.mode, `closure mode changed: ${file}`);
    }
    const revisionsAfterSource = repository.revisionsBetween(evidence.sourceCommit, base, maximumHistoryRevisions);
    const candidateRevisions = repository.revisionsBetween(base, head, maximumHistoryRevisions);
    requireValue(Array.isArray(revisionsAfterSource) && Array.isArray(candidateRevisions)
        && new Set([...revisionsAfterSource, ...candidateRevisions]).size <= maximumHistoryRevisions,
    'combined repair history exceeds its revision bound');
    for (const [revisions, target, label] of [[revisionsAfterSource, base, 'source history'], [candidateRevisions, head, 'candidate history']])
    {
        requireValue(Array.isArray(revisions) && revisions.length > 0 && revisions.length <= maximumHistoryRevisions
            && new Set(revisions).size === revisions.length && revisions.includes(target)
            && revisions.every((revision) => revisionPattern.test(revision)), `${label} must enumerate bounded full history`);
        for (const revision of revisions)
        {
            const info = commit(revision);
            for (const [file, binding] of closure)
            {
                same(readBlob(revision, file).identity, binding.source, `closure changed after source: ${revision}:${file}`);
            }
            for (const parent of info.parents)
            {
                const changes = repository.changedPaths(parent, revision);
                if (label === 'candidate history')
                {
                    requireValue(changes.every((file) => [producer.manifest, producer.output].includes(file)),
                        `candidate history changed source or unregistered metadata: ${revision}`);
                }
            }
            if (label === 'source history')
            {
                same(readBlob(revision, producer.output).identity, evidence.output.source,
                    `output changed before repair candidate: ${revision}`);
            }
        }
    }
    const identities = new Map([
        [evidence.sourceParent, 'parent'], [evidence.sourceCommit, 'source'], [base, 'base'], [head, 'candidate']
    ]);
    for (const [revision, name] of identities)
    {
        same(readBlob(revision, producer.output).identity, evidence.output[name], `checked-in output binding mismatch: ${name}`);
    }
    same(evidence.output.parent, evidence.output.source, 'source event already changed its generated output');
    same(evidence.output.source, evidence.output.base, 'base output differs from the missed source output');
    same(evidence.output.expected, evidence.output.candidate, 'candidate is not the expected canonical output');
    requireValue(evidence.output.parent.sha256 !== evidence.output.expected.sha256
        && evidence.output.parent.mode === evidence.output.expected.mode, 'repair must change bytes without changing output mode');

    const usedIsolations = new Set();
    const replay = (revision) =>
    {
        const passes = [];
        for (let attempt = 0; attempt < 2; attempt += 1)
        {
            const observation = repository.replay({ revision, producer, attempt });
            exactKeys(observation, ['revision', 'isolationId', 'first', 'second', 'readPaths', 'writePaths', 'changedPaths'], 'replay observation');
            requireValue(observation.revision === revision && typeof observation.isolationId === 'string'
                && observation.isolationId && !usedIsolations.has(observation.isolationId), 'replays must use distinct fresh isolation');
            usedIsolations.add(observation.isolationId);
            same([...observation.readPaths].sort(), producer.closure, 'replay read closure is not exact');
            same([...observation.writePaths].sort(), [producer.output], 'replay wrote outside its canonical output');
            requireValue(Array.isArray(observation.changedPaths)
                && observation.changedPaths.every((file) => file === producer.output), 'replay changed unregistered tracked, untracked or ignored paths');
            const first = observedBlob(observation.first, 'fresh replay output');
            const second = observedBlob(observation.second, 'fixed-point replay output');
            same(first.identity, second.identity, 'replay is not a fixed point');
            passes.push(first);
        }
        same(passes[0].identity, passes[1].identity, 'fresh replays are nondeterministic');
        return passes[0];
    };
    const replayIdentity = (identity) => ({ mode: identity.mode, sha256: identity.sha256 });
    const parentReplay = replay(evidence.sourceParent);
    same(replayIdentity(parentReplay.identity), replayIdentity(evidence.output.parent),
        'source parent was not canonically synchronized');
    const sourceReplay = replay(evidence.sourceCommit);
    same(replayIdentity(sourceReplay.identity), replayIdentity(evidence.output.expected),
        'source event does not produce the expected drift');
    same(replayIdentity(replay(base).identity), replayIdentity(sourceReplay.identity),
        'base replay drifted from the source owner');
    same(replayIdentity(replay(head).identity), replayIdentity(sourceReplay.identity),
        'candidate replay drifted from the source owner');

    const parseOutput = (blob, revision) =>
    {
        const document = JSON.parse(blob.bytes.toString('utf8'));
        exactKeys(document, ['schema', 'generatedBy', 'sourceDigests', 'entries', 'contentDigest'], 'canonical output');
        requireValue(document.schema === producer.outputSchema && document.generatedBy === producer.command.arguments[0]
            && Array.isArray(document.entries), 'canonical output identity or entries are invalid');
        exactKeys(document.sourceDigests, producer.digestInputs, 'output source digests');
        for (const file of producer.digestInputs)
        {
            requireValue(document.sourceDigests[file] === `sha256:${readBlob(revision, file).identity.sha256}`,
                `output source digest is not bound to Git bytes: ${file}`);
        }
        const { contentDigest: seal, ...payload } = document;
        requireValue(seal === contentDigest(payload), 'canonical output content seal is invalid');
        return document;
    };
    const before = parseOutput(parentReplay, evidence.sourceParent);
    const after = parseOutput(sourceReplay, evidence.sourceCommit);
    const withoutDigests = (value) =>
    {
        const rest = { ...value };
        delete rest.sourceDigests;
        delete rest.contentDigest;
        return rest;
    };
    same(withoutDigests(before), withoutDigests(after), 'repair changed producer entries or other non-digest fields');
    requireValue(!isDeepStrictEqual(before.sourceDigests, after.sourceDigests), 'repair did not refresh a source digest');
    return {
        schema: generatedOutputDigestRepairSchema,
        status: 'verified',
        producerId: producer.id,
        sourceCommit: evidence.sourceCommit,
        baseCommit: base,
        output: { path: producer.output, ...sourceReplay.identity },
        producerCount: after.entries.length,
        replayIsolations: usedIsolations.size
    };
}
