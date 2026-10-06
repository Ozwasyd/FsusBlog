import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const { parseGeneratedMarkers } = await import(new URL('../docs/generated-fact-sections/markers.mjs', import.meta.url));

export const factSectionRepairHistorySchema = 'fsusblog.fact-section-repair-history-preflight.v1';

// This finite record is a review candidate, not an active generated-only rule.
// No Change Contract dispatch consumes it before separate trusted promotion.
export const releaseFactSectionRepairHistory = Object.freeze({
    id: 'release-aggregate-two-source-history',
    anchor: '0d8631114d95de7b8d8a13cc7b00d98c9d8c13d2',
    frontier: 'b19b3dc715691b871f0e3cab598ec5da8f27633c',
    graphCount: 22,
    graphSha256: '8c0439a8c1fa0d97f209f71f27b7d7c215bfc15982800f6d70d041ef13e710aa',
    document: 'docs/releases/release-identity.md',
    section: 'release.aggregate-contract',
    before: Object.freeze({
        mode: '100644', object: '0aca2f30d2881fbe5290f4086798e5ff0bec5815',
        sha256: '6b9334cf2dcd56223a950d4a824743f0f7d42ee67cd4e5e76b7495541dff420b'
    }),
    expected: Object.freeze({
        mode: '100644', object: '7fbd4192bb74cf9d2b901ff9580ef788984801f5',
        sha256: 'bf209d668365455603d5f5479cfe630539da94a5b57fd6d7b69a82af26f0fb29'
    }),
    events: Object.freeze([
        Object.freeze({
            commit: '709986ab493d488e3c9e841972be1c86a9b54929',
            parent: 'bb0f8436bec08fb9a39e70fedcb2d4c6b623577f',
            path: 'tools/test-matrix/behavior-evidence-post-runtime.mjs',
            key: 'postRuntimeSeal'
        }),
        Object.freeze({
            commit: '1e95f95fe21bb8a0da4a71689df0c64ed5a2879d',
            parent: '709986ab493d488e3c9e841972be1c86a9b54929',
            path: 'tools/test-matrix/required-evidence-catalog.mjs',
            key: 'evidenceCatalog'
        })
    ])
});

const revisionPattern = /^[a-f0-9]{40}$/u;
const pathPattern = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;
const maximumBlobBytes = 16 * 1024 * 1024;
const maximumHistory = 128;

function requireValue(value, message)
{
    if (!value)
    {
        throw new Error(`fact-section repair history: ${message}`);
    }
}

function sha256(bytes)
{
    return createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, keys, label)
{
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
        && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()), `${label} has an invalid closed shape`);
}

function identity(value)
{
    exactKeys(value, ['mode', 'object', 'bytes'], 'Git blob');
    requireValue(value.mode === '100644' && revisionPattern.test(value.object)
        && Buffer.isBuffer(value.bytes) && value.bytes.length <= maximumBlobBytes,
    'a bounded non-executable regular Git blob is required');
    const object = createHash('sha1').update(`blob ${value.bytes.length}\0`).update(value.bytes).digest('hex');
    requireValue(object === value.object, 'Git object does not bind the observed blob bytes');
    return { mode: value.mode, object, sha256: sha256(value.bytes) };
}

/**
 * Read-only Git capability: replacement refs and grafts are never authority.
 * This adapter neither executes producer code nor accepts a candidate override.
 */
export function createFactSectionHistoryRepository(root)
{
    const repositoryRoot = realpathSync(path.resolve(root));
    const git = (args) => execFileSync('git', ['--no-replace-objects', '-c', 'advice.graftFileDeprecated=false', ...args], {
        cwd: repositoryRoot,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null' },
        maxBuffer: maximumBlobBytes + 1024, timeout: 10_000
    });
    const revision = (value) =>
    {
        requireValue(typeof value === 'string' && revisionPattern.test(value), 'complete revision is required');
        requireValue(git(['rev-parse', '--verify', `${value}^{commit}`]).toString('utf8').trim() === value,
            'revision is not an exact reachable commit');
        return value;
    };
    requireValue(git(['rev-parse', '--show-toplevel']).toString('utf8').trim() === repositoryRoot,
        'root must be the canonical Git checkout root');
    requireValue(git(['rev-parse', '--is-shallow-repository']).toString('utf8').trim() === 'false',
        'shallow history cannot qualify an exact finite graph');
    return {
        commit(value)
        {
            revision(value);
            const [commit, parents, tree] = git(['show', '-s', '--format=%H%x00%P%x00%T', value])
                .toString('utf8').trim().split('\0');
            return { commit, parents: parents.split(' ').filter(Boolean), tree };
        },
        revisionsBetween(anchor, frontier)
        {
            revision(anchor);
            revision(frontier);
            git(['merge-base', '--is-ancestor', anchor, frontier]);
            const revisions = git(['rev-list', `--max-count=${maximumHistory + 1}`, '--reverse', '--topo-order', `${anchor}..${frontier}`])
                .toString('utf8').trim().split('\n').filter(Boolean);
            requireValue(revisions.length <= maximumHistory, 'history exceeds the finite replay bound');
            return revisions;
        },
        blob(value, file)
        {
            revision(value);
            requireValue(typeof file === 'string' && pathPattern.test(file), 'exact repository file path is required');
            const entry = git(['ls-tree', '-z', '--full-tree', value, '--', file]).toString('utf8')
                .match(/^(100644) blob ([a-f0-9]{40})\t([^\0]+)\0$/u);
            requireValue(entry && entry[3] === file, 'path must identify exactly one non-executable regular blob');
            const size = Number(git(['cat-file', '-s', entry[2]]).toString('utf8'));
            requireValue(Number.isSafeInteger(size) && size >= 0 && size <= maximumBlobBytes, 'blob exceeds its byte bound');
            const bytes = git(['cat-file', 'blob', entry[2]]);
            requireValue(bytes.length === size, 'truncated Git blob');
            return { mode: entry[1], object: entry[2], bytes };
        },
        changedPaths(base, head)
        {
            revision(base);
            revision(head);
            return git(['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', base, head, '--'])
                .toString('utf8').split('\0').filter(Boolean).sort();
        }
    };
}

function authorityModules(bytes)
{
    const source = bytes.toString('utf8');
    const section = parseGeneratedMarkers(source).find((entry) => entry.sectionId === releaseFactSectionRepairHistory.section);
    requireValue(section, 'registered generated section is missing');
    const rows = source.slice(section.bodyStart, section.bodyEnd).split('\n')
        .filter((line) => line.startsWith('| authorityModules |'));
    requireValue(rows.length === 1, 'authorityModules must have one exact generated row');
    const value = rows[0].match(/^\| authorityModules \| (\{.+\}) \|$/u)?.[1];
    requireValue(value, 'authorityModules row must retain its canonical renderer shape');
    return JSON.parse(value);
}

/**
 * Preflight only. Exact historical and candidate bytes do not prove a fresh
 * extractor run, a build receipt, canonical renderer replay, or policy trust.
 * Nothing in this function admits a generated-only PR or advances a baseline.
 */
export function verifyFactSectionRepairHistoryPreflight({ evidence, repository, base, head })
{
    const registration = releaseFactSectionRepairHistory;
    exactKeys(evidence, ['schema', 'historyId', 'frontierCommit', 'candidateCommit'], 'history manifest');
    requireValue(evidence.schema === factSectionRepairHistorySchema && evidence.historyId === registration.id,
        'unregistered schema or history identity');
    requireValue(base === registration.frontier && evidence.frontierCommit === base
        && typeof head === 'string' && revisionPattern.test(head) && evidence.candidateCommit === head && head !== base,
    'preflight requires the exact reviewed frontier and externally bound candidate');
    const revisions = repository.revisionsBetween(registration.anchor, base);
    requireValue(Array.isArray(revisions) && new Set(revisions).size === revisions.length
        && revisions.length + 1 === registration.graphCount && revisions.at(-1) === base,
    'full-history roster is not the exact finite registered graph');
    const graph = [registration.anchor, ...revisions].map((value) =>
    {
        const info = repository.commit(value);
        exactKeys(info, ['commit', 'parents', 'tree'], 'commit observation');
        requireValue(info.commit === value && revisionPattern.test(info.tree) && Array.isArray(info.parents)
            && info.parents.every((parent) => revisionPattern.test(parent)), 'commit, parents or tracked tree identity is invalid');
        return { commit: info.commit, parents: info.parents, tree: info.tree };
    });
    requireValue(sha256(JSON.stringify(graph)) === registration.graphSha256,
        'full-history commit, parents, order or tracked tree seal mismatch');
    requireValue(isDeepStrictEqual(identity(repository.blob(registration.anchor, registration.document)), registration.before),
        'anchor document identity does not match its reviewed owner');

    const events = [];
    for (const node of graph.slice(1))
    {
        requireValue(isDeepStrictEqual(identity(repository.blob(node.commit, registration.document)), registration.before),
            'historical output drift or change-revert is not admitted');
        for (const parent of node.parents)
        {
            for (const source of registration.events)
            {
                if (!isDeepStrictEqual(identity(repository.blob(parent, source.path)), identity(repository.blob(node.commit, source.path))))
                {
                    events.push({ commit: node.commit, parent, path: source.path, key: source.key });
                }
            }
        }
    }
    requireValue(isDeepStrictEqual(events, registration.events), 'source event omission, substitution, reordering or change-revert');
    for (const event of registration.events)
    {
        requireValue(isDeepStrictEqual(repository.commit(event.commit).parents, [event.parent]),
            'source event must have its exact single parent');
    }
    const candidateHistory = repository.revisionsBetween(base, head);
    requireValue(candidateHistory.length > 0 && candidateHistory.length <= maximumHistory
        && candidateHistory.at(-1) === head && new Set(candidateHistory).size === candidateHistory.length,
    'candidate must enumerate its bounded complete ancestry');
    let previous = base;
    for (const revision of candidateHistory)
    {
        const info = repository.commit(revision);
        exactKeys(info, ['commit', 'parents', 'tree'], 'candidate commit observation');
        requireValue(info.commit === revision && revisionPattern.test(info.tree)
            && isDeepStrictEqual(info.parents, [previous]), 'repair candidate history must be the exact single-parent chain');
        requireValue(repository.changedPaths(info.parents[0], revision).every((file) => file === registration.document),
            'candidate history changed source, policy, metadata or an unrelated output');
        const document = identity(repository.blob(revision, registration.document));
        requireValue(isDeepStrictEqual(document, registration.before) || isDeepStrictEqual(document, registration.expected),
            'candidate history contains intermediate prose, range or partial-drift mutation');
        previous = revision;
    }
    requireValue(isDeepStrictEqual(repository.changedPaths(base, head), [registration.document]),
        'candidate must change exactly the registered document');
    const before = repository.blob(base, registration.document);
    const after = repository.blob(head, registration.document);
    requireValue(isDeepStrictEqual(identity(before), registration.before)
        && isDeepStrictEqual(identity(after), registration.expected), 'exact base or expected document blob mismatch');
    const oldModules = authorityModules(before.bytes);
    const newModules = authorityModules(after.bytes);
    const expectedModules = structuredClone(oldModules);
    for (const event of registration.events)
    {
        exactKeys(expectedModules[event.key], ['sourceDigest', 'sourcePath'], 'authority module');
        requireValue(expectedModules[event.key].sourcePath === event.path, 'authority module source path was substituted');
        expectedModules[event.key].sourceDigest = `sha256:${identity(repository.blob(base, event.path)).sha256}`;
        requireValue(expectedModules[event.key].sourceDigest !== oldModules[event.key].sourceDigest,
            'source event must create a real digest drift');
    }
    requireValue(isDeepStrictEqual(newModules, expectedModules), 'repair changed non-digest authority fields or omitted drift');
    return { schema: factSectionRepairHistorySchema, status: 'preflight-only', qualification: false,
        historyId: registration.id, baseCommit: base, candidateCommit: head, graphCount: graph.length,
        requiredNextStage: 'trusted original producer epochs and fresh current-source canonical execution' };
}
