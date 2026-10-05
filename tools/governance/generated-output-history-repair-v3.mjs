import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const generatedOutputHistoryRepairSchema = 'fsusblog.post-merge-generated-output-repair.v3';

const revisionPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const pathPattern = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;
const maximumHistoryRevisions = 128;
const maximumBlobBytes = 16 * 1024 * 1024;
const matrixPath = 'tests/matrix.yml';
const requirementsPath = 'tests/backend/Fixtures/backend-test-requirements.json';

function requireValue(condition, message)
{
    if (!condition)
    {
        throw new Error(`generated history repair v3: ${message}`);
    }
}

function same(actual, expected, message)
{
    requireValue(isDeepStrictEqual(actual, expected), message);
}

function exactKeys(value, keys, label)
{
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
    same(Object.keys(value).sort(), [...keys].sort(), `${label} has an invalid closed shape`);
}

function sortedPaths(values, label)
{
    requireValue(Array.isArray(values) && values.length > 0 && values.length <= 256
        && values.every((value) => typeof value === 'string' && pathPattern.test(value)), `${label} paths are invalid`);
    same(values, [...new Set(values)].sort(), `${label} paths must be unique and sorted`);
}

function hash(bytes)
{
    return createHash('sha256').update(bytes).digest('hex');
}

function validateIdentity(identity)
{
    exactKeys(identity, ['mode', 'object', 'sha256'], 'blob identity');
    requireValue(['100644', '100755'].includes(identity.mode) && revisionPattern.test(identity.object)
        && digestPattern.test(identity.sha256), 'blob identity must bind a regular mode, object and SHA-256');
}

function observeBlob(blob, git = true)
{
    exactKeys(blob, git ? ['mode', 'object', 'bytes'] : ['mode', 'bytes'], 'observed blob');
    requireValue(['100644', '100755'].includes(blob.mode) && Buffer.isBuffer(blob.bytes)
        && blob.bytes.length <= maximumBlobBytes, 'observed blob must be bounded and regular');
    if (git)
    {
        const object = createHash('sha1').update(`blob ${blob.bytes.length}\0`).update(blob.bytes).digest('hex');
        requireValue(blob.object === object, 'Git object does not identify the observed bytes');
    }
    return { mode: blob.mode, ...(git ? { object: blob.object } : {}), sha256: hash(blob.bytes) };
}

function validateProducer(producer)
{
    exactKeys(producer, ['id', 'repairClass', 'manifest', 'command', 'closure', 'output', 'outputSchema',
        'historicalPolicyPaths', 'protectedPolicyPaths', 'qualification'], 'trusted producer');
    requireValue(producer.id === 'backend-evidence-path-authority' && producer.repairClass === 'sealed-history-digest-refresh',
        'producer and repair class are not supported');
    same(producer.command, { executable: 'node', arguments: ['tools/test/generate-backend-evidence-path-authority.mjs', '--write'] },
        'canonical command cannot change');
    same(producer.closure, [requirementsPath, matrixPath, 'tools/test-matrix/parse-matrix.mjs',
        'tools/test/backend-evidence-path-authority.mjs', 'tools/test/generate-backend-evidence-path-authority.mjs',
        'tools/yaml/parse-document.mjs'], 'complete backend producer closure is required');
    requireValue(producer.output === 'tests/backend/Fixtures/backend-evidence-path-authority.generated.json'
        && producer.outputSchema === 'fsusblog.backend-evidence-path-authority.v1'
        && pathPattern.test(producer.manifest) && !producer.closure.includes(producer.manifest)
        && producer.manifest !== producer.output, 'canonical output or manifest path is invalid');
    sortedPaths(producer.historicalPolicyPaths, 'historical policy');
    sortedPaths(producer.protectedPolicyPaths, 'current policy');
    requireValue(producer.historicalPolicyPaths.every((file) => producer.protectedPolicyPaths.includes(file))
        && producer.protectedPolicyPaths.every((file) => ![...producer.closure, producer.output, producer.manifest].includes(file)),
    'policy and producer ownership overlap or historical policy was removed');
    const qualification = producer.qualification;
    exactKeys(qualification, ['kind', 'anchor', 'frontier', 'sourceEvents', 'historySha256'], 'trusted qualification');
    requireValue(qualification.kind === 'reviewed-mainline-history'
        && revisionPattern.test(qualification.anchor) && revisionPattern.test(qualification.frontier)
        && qualification.anchor !== qualification.frontier && digestPattern.test(qualification.historySha256),
    'trusted reviewed history identities are invalid');
    requireValue(Array.isArray(qualification.sourceEvents) && qualification.sourceEvents.length > 0
        && qualification.sourceEvents.length <= 64
        && qualification.sourceEvents.every((revision) => revisionPattern.test(revision))
        && new Set(qualification.sourceEvents).size === qualification.sourceEvents.length,
    'trusted source events must be bounded and unique');
}

function observer(repository)
{
    const blobs = new Map();
    const blob = (revision, file) =>
    {
        const key = `${revision}:${file}`;
        if (!blobs.has(key))
        {
            const value = repository.blob(revision, file);
            blobs.set(key, { ...value, identity: observeBlob(value) });
        }
        return blobs.get(key);
    };
    const commit = (revision) =>
    {
        const value = repository.commit(revision);
        exactKeys(value, ['commit', 'parents', 'subject', 'message'], 'commit observation');
        requireValue(value.commit === revision && revisionPattern.test(revision)
            && Array.isArray(value.parents) && value.parents.length <= 2
            && value.parents.every((parent) => revisionPattern.test(parent))
            && new Set(value.parents).size === value.parents.length
            && typeof value.subject === 'string' && typeof value.message === 'string', 'commit observation is not exact');
        return value;
    };
    const revisions = (ancestor, descendant) =>
    {
        requireValue(repository.isAncestor(ancestor, descendant), 'history endpoints are not ancestral');
        const values = ancestor === descendant ? [] : repository.revisionsBetween(ancestor, descendant, maximumHistoryRevisions);
        requireValue(Array.isArray(values) && values.length <= maximumHistoryRevisions
            && values.every((revision) => revisionPattern.test(revision))
            && new Set(values).size === values.length && !values.includes(ancestor)
            && (ancestor === descendant || values.includes(descendant)), 'history enumeration is incomplete or unbounded');
        return values;
    };
    return { blob, commit, revisions };
}

function inspectHistory(producer, repository, observed)
{
    const { anchor, frontier, sourceEvents } = producer.qualification;
    const revisions = observed.revisions(anchor, frontier);
    const allowed = new Set([anchor, ...revisions]);
    const paths = [...new Set([...producer.closure, producer.output, ...producer.historicalPolicyPaths])].sort();
    const edges = revisions.flatMap((revision) =>
    {
        const info = observed.commit(revision);
        requireValue(info.parents.length > 0 && info.parents.every((parent) => allowed.has(parent)),
            'reviewed history is not closed at its synchronized anchor');
        return info.parents.map((parent) => ({ revision, parent,
            relevantChanges: repository.changedPaths(parent, revision).filter((file) => paths.includes(file)) }));
    });
    const nodes = [...allowed].sort().map((revision) => ({ ...observed.commit(revision),
        paths: paths.map((file) => ({ path: file, ...observed.blob(revision, file).identity })) }));
    const firstParent = repository.firstParentRevisions(anchor, frontier, maximumHistoryRevisions);
    requireValue(Array.isArray(firstParent) && firstParent.length > 0 && firstParent.at(-1) === frontier
        && new Set(firstParent).size === firstParent.length, 'first-parent history is invalid');
    let parent = anchor;
    const events = [];
    for (const revision of firstParent)
    {
        requireValue(allowed.has(revision) && observed.commit(revision).parents[0] === parent,
            'first-parent chain is not anchored');
        if (repository.changedPaths(parent, revision).includes(matrixPath))
        {
            requireValue(observed.commit(revision).parents.length === 1, 'source event must have one exact parent');
            events.push(revision);
        }
        parent = revision;
    }
    same(events, sourceEvents, 'ordered source events differ from reviewed history');
    for (const edge of edges)
    {
        same(edge.relevantChanges, sourceEvents.includes(edge.revision) ? [matrixPath] : [],
            'unreviewed closure, output, policy or side-parent transition');
    }
    for (const node of nodes)
    {
        for (const file of paths)
        {
            const current = observed.blob(node.commit, file).identity;
            const initial = observed.blob(anchor, file).identity;
            requireValue(current.mode === initial.mode, 'historical executable mode drift');
            if (file !== matrixPath)
            {
                same(current, initial, 'historical closure, output or policy drift');
            }
        }
    }
    // This shape is deliberately reproducible from Git alone, not PR text.
    return { anchor, base: frontier, sourceEvents, paths, nodes, edges };
}

/** Inspect bounded immutable history for review; this function does not approve a policy or run producers. */
export function inspectGeneratedOutputHistoryV3({ producer, repository })
{
    validateProducer(producer);
    const history = inspectHistory(producer, repository, observer(repository));
    return { history, historySha256: hash(JSON.stringify(history)) };
}

function validateManifest(evidence, producer, base, head, changedFiles)
{
    exactKeys(evidence, ['schema', 'producerId', 'repairClass', 'qualification', 'baseCommit', 'command', 'closure', 'output'], 'manifest');
    requireValue(evidence.schema === generatedOutputHistoryRepairSchema && evidence.producerId === producer.id
        && evidence.repairClass === producer.repairClass && evidence.baseCommit === base
        && revisionPattern.test(base) && revisionPattern.test(head) && base !== head, 'manifest candidate identity mismatch');
    same(evidence.qualification, producer.qualification, 'manifest cannot select history or provenance');
    same(evidence.command, producer.command, 'manifest cannot select its command');
    requireValue(Array.isArray(evidence.closure), 'manifest closure must be an array');
    same(evidence.closure.map((entry) => entry?.path), producer.closure, 'manifest closure is not exact');
    for (const entry of evidence.closure)
    {
        exactKeys(entry, ['path', 'anchor', 'frontier', 'base'], 'closure binding');
        for (const key of ['anchor', 'frontier', 'base'])
        {
            validateIdentity(entry[key]);
        }
    }
    exactKeys(evidence.output, ['path', 'anchor', 'base', 'candidate'], 'output binding');
    requireValue(evidence.output.path === producer.output, 'manifest cannot select its output');
    for (const key of ['anchor', 'base', 'candidate'])
    {
        validateIdentity(evidence.output[key]);
    }
    same([...changedFiles].sort(), [producer.manifest, producer.output].sort(), 'candidate must change only exact manifest and output');
}

function preflightLaterHistory(producer, repository, observed, base, head)
{
    const { frontier } = producer.qualification;
    const later = observed.revisions(frontier, base);
    const candidate = observed.revisions(base, head);
    const policies = new Map(producer.protectedPolicyPaths.map((file) =>
    {
        const original = repository.optionalBlob(frontier, file);
        requireValue(producer.historicalPolicyPaths.includes(file) || original === null,
            'new policy path already existed outside the sealed history');
        return [file, { initial: original === null ? null : observeBlob(original), current: observed.blob(base, file).identity }];
    }));
    const policyIdentity = (revision, file) =>
    {
        const value = repository.optionalBlob(revision, file);
        return value === null ? null : observeBlob(value);
    };
    for (const [values, start, isCandidate] of [[later, frontier, false], [candidate, base, true]])
    {
        const allowed = new Set([start, ...values]);
        for (const revision of values)
        {
            const info = observed.commit(revision);
            requireValue(info.parents.length > 0 && info.parents.every((parent) => allowed.has(parent))
                && repository.isAncestor(start, revision), 'later history contains an unanchored side parent');
            for (const file of producer.closure)
            {
                same(observed.blob(revision, file).identity, observed.blob(frontier, file).identity,
                    'source closure changed after reviewed frontier');
            }
            if (!isCandidate)
            {
                same(observed.blob(revision, producer.output).identity, observed.blob(frontier, producer.output).identity,
                    'output changed before repair candidate');
            }
            for (const parent of info.parents)
            {
                const changes = repository.changedPaths(parent, revision);
                if (isCandidate)
                {
                    requireValue(changes.every((file) => [producer.manifest, producer.output].includes(file)),
                        'candidate history changed source, policy or unrelated paths');
                }
                for (const [file, identities] of policies)
                {
                    const previous = policyIdentity(parent, file);
                    const current = policyIdentity(revision, file);
                    requireValue(isDeepStrictEqual(current, identities.current)
                        || (!isCandidate && isDeepStrictEqual(current, identities.initial)), 'unknown policy identity');
                    requireValue(isDeepStrictEqual(previous, current)
                        || (!isCandidate && isDeepStrictEqual(previous, identities.initial)
                            && isDeepStrictEqual(current, identities.current)), 'policy rollback or unreviewed transition');
                }
            }
        }
    }
    return [...later, ...candidate];
}

/**
 * Verify a generated-only repair using capabilities constructed by the trusted
 * base checker. Adapter fixtures exercise logic, not physical isolation or an
 * independent policy review; neither a manifest nor a candidate supplies trust.
 */
export function verifyGeneratedOutputHistoryRepairV3({ evidence, producer, repository, base, head, changedFiles })
{
    validateProducer(producer);
    validateManifest(evidence, producer, base, head, changedFiles);
    requireValue(repository?.authorityRevision === base, 'repository must use the exact trusted base');
    const observed = observer(repository);
    const history = inspectHistory(producer, repository, observed);
    requireValue(hash(JSON.stringify(history)) === producer.qualification.historySha256, 'reviewed history seal mismatch');
    const later = preflightLaterHistory(producer, repository, observed, base, head);
    requireValue(new Set([...history.nodes.map((node) => node.commit), ...later]).size <= maximumHistoryRevisions,
        'combined history exceeds the revision bound');
    const { anchor, frontier, sourceEvents } = producer.qualification;
    for (const entry of evidence.closure)
    {
        for (const [label, revision] of [['anchor', anchor], ['frontier', frontier], ['base', base]])
        {
            same(observed.blob(revision, entry.path).identity, entry[label], 'manifest closure identity mismatch');
        }
    }
    for (const [label, revision] of [['anchor', anchor], ['base', base], ['candidate', head]])
    {
        same(observed.blob(revision, producer.output).identity, evidence.output[label], 'manifest output identity mismatch');
    }
    same(evidence.output.anchor, evidence.output.base, 'base output is no longer the omitted output');
    requireValue(evidence.output.candidate.mode === evidence.output.anchor.mode
        && evidence.output.candidate.sha256 !== evidence.output.anchor.sha256, 'repair must refresh bytes without changing mode');

    // Every shape, Git history and policy check above finishes before execution.
    const isolations = new Set();
    const replays = new Map();
    let baseline = null;
    for (const revision of [...new Set([anchor, ...sourceEvents, frontier, base, head])])
    {
        const outputs = [];
        for (let attempt = 0; attempt < 2; attempt += 1)
        {
            const replay = repository.replay({ revision, producer, attempt });
            exactKeys(replay, ['revision', 'isolationId', 'first', 'second', 'readPaths', 'writePaths', 'changedPaths'], 'replay');
            requireValue(replay.revision === revision && typeof replay.isolationId === 'string' && replay.isolationId.length > 0
                && !isolations.has(replay.isolationId), 'replay must use fresh distinct isolation');
            isolations.add(replay.isolationId);
            same(replay.readPaths, producer.closure, 'replay read closure is not exact');
            same(replay.writePaths, [producer.output], 'replay wrote outside canonical output');
            requireValue(Array.isArray(replay.changedPaths) && replay.changedPaths.every((file) => file === producer.output),
                'replay changed undeclared tracked, untracked or ignored paths');
            const first = observeBlob(replay.first, false);
            same(first, observeBlob(replay.second, false), 'replay did not reach a fixed point');
            requireValue(first.mode === evidence.output.anchor.mode, 'replay output mode drift');
            outputs.push(first);
            const output = JSON.parse(replay.first.bytes.toString('utf8'));
            exactKeys(output, ['schema', 'generatedBy', 'sources', 'entries'], 'canonical output');
            requireValue(output.schema === producer.outputSchema && output.generatedBy === producer.command.arguments[0]
                && Array.isArray(output.entries), 'canonical output identity is invalid');
            exactKeys(output.sources, [matrixPath, requirementsPath], 'canonical sources');
            requireValue(output.sources[matrixPath] === `sha256:${observed.blob(revision, matrixPath).identity.sha256}`,
                'matrix digest is not bound to source bytes');
            const requirements = JSON.parse(observed.blob(revision, requirementsPath).bytes.toString('utf8'));
            requireValue(output.sources[requirementsPath] === `sha256:${hash(`${JSON.stringify(requirements, null, 4)}\n`)}`,
                'requirements digest is not bound to canonical source');
            const semantics = { ...output };
            delete semantics.sources;
            baseline ??= semantics;
            same(semantics, baseline, 'replay changed non-digest producer semantics');
        }
        same(outputs[0], outputs[1], 'fresh replays are nondeterministic');
        replays.set(revision, outputs[0]);
    }
    const replayIdentity = ({ mode, sha256 }) => ({ mode, sha256 });
    same(replays.get(anchor), replayIdentity(evidence.output.anchor), 'anchor was not canonically synchronized');
    for (const revision of [sourceEvents.at(-1), frontier, base, head])
    {
        same(replays.get(revision), replayIdentity(evidence.output.candidate), 'candidate is not the canonical current output');
    }
    return { schema: generatedOutputHistoryRepairSchema, status: 'verified', producerId: producer.id,
        baseCommit: base, candidateCommit: head, historySha256: producer.qualification.historySha256,
        replayIsolations: isolations.size, output: { path: producer.output, ...replays.get(head) } };
}
