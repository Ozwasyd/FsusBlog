import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
    generatedOutputDigestRepairSchema,
    verifyGeneratedOutputDigestRepairV2
} from '../../tools/governance/generated-output-digest-repair-v2.mjs';

function sorted(value)
{
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
    return value;
}

function digest(bytes)
{
    return createHash('sha256').update(bytes).digest('hex');
}

function seal(document)
{
    return { ...document, contentDigest: `sha256:${digest(JSON.stringify(sorted(document)))}` };
}

function bytes(document)
{
    return Buffer.from(`${JSON.stringify(document, null, 4)}\n`);
}

function identity(content, mode = '100644')
{
    return { mode, sha256: digest(content) };
}

function fixture({ entries = null, sourceDigests = null, badSeal = false } = {})
{
    const revisions = Object.fromEntries(['parent', 'source', 'merge', 'base', 'head', 'intermediate']
        .map((key, index) => [key, String(index + 1).repeat(40)]));
    const producer = {
        id: 'correctness-attempt-producers',
        repairClass: 'digest-refresh',
        manifest: 'artifacts/change-contract/correctness-inventory-repair.json',
        command: { executable: 'node', arguments: ['tools/generate.mjs', '--write'] },
        closure: ['tests/matrix.yml', 'tools/generate.mjs', 'tools/parser.mjs'],
        digestInputs: ['tests/matrix.yml'],
        output: 'config/testing/correctness-attempt-producers.json',
        outputSchema: 'fsusblog.correctness-attempt-producers.v1',
        protectedPolicyPaths: ['tools/governance/policy.mjs']
    };
    const parentFiles = new Map([
        ['tests/matrix.yml', Buffer.from('tiers: [unit]\n')],
        ['tools/generate.mjs', Buffer.from('import "./parser.mjs";\n')],
        ['tools/parser.mjs', Buffer.from('export const parser = 1;\n')]
    ]);
    const sourceFiles = new Map(parentFiles);
    sourceFiles.set('tests/matrix.yml', Buffer.from('tiers:\n  - unit\n'));
    sourceFiles.set('tools/parser.mjs', Buffer.from('export const parser = 2;\n'));
    const before = seal({ schema: producer.outputSchema, generatedBy: producer.command.arguments[0],
        sourceDigests: { 'tests/matrix.yml': `sha256:${digest(parentFiles.get('tests/matrix.yml'))}` },
        entries: [{ producerId: 'matrix:unit', allowedRetries: 0, qualificationEligible: true }] });
    const after = seal({ schema: before.schema, generatedBy: before.generatedBy,
        sourceDigests: sourceDigests ?? { 'tests/matrix.yml': `sha256:${digest(sourceFiles.get('tests/matrix.yml'))}` },
        entries: entries ?? before.entries });
    if (badSeal) after.contentDigest = `sha256:${'f'.repeat(64)}`;
    const parentOutput = bytes(before);
    const expectedOutput = bytes(after);
    const blobs = new Map(Object.values(revisions).map((revision) => [revision, new Map(
        revision === revisions.parent ? parentFiles : sourceFiles
    )]));
    for (const [revision, files] of blobs)
        files.set(producer.output, revision === revisions.head ? expectedOutput : parentOutput);
    const commits = new Map([
        [revisions.parent, { commit: revisions.parent, parents: [], subject: 'synchronized producer' }],
        [revisions.source, { commit: revisions.source, parents: [revisions.parent], subject: 'change matrix and parser' }],
        [revisions.merge, { commit: revisions.merge, parents: [revisions.parent, revisions.source], subject: 'Merge pull request #42 from owner/source' }],
        [revisions.base, { commit: revisions.base, parents: [revisions.merge], subject: 'trusted policy bootstrap' }],
        [revisions.head, { commit: revisions.head, parents: [revisions.base], subject: 'repair inventory' }],
        [revisions.intermediate, { commit: revisions.intermediate, parents: [revisions.source], subject: 'intermediate change' }]
    ]);
    const changes = new Map([
        [`${revisions.parent}:${revisions.source}`, ['tests/matrix.yml', 'tools/parser.mjs', 'docs/unrelated.md']],
        [`${revisions.parent}:${revisions.merge}`, ['tests/matrix.yml', 'tools/parser.mjs', 'docs/unrelated.md']],
        [`${revisions.source}:${revisions.merge}`, []],
        [`${revisions.merge}:${revisions.base}`, ['tools/governance/policy.mjs']],
        [`${revisions.base}:${revisions.head}`, [producer.manifest, producer.output]],
        [`${revisions.source}:${revisions.intermediate}`, ['tools/parser.mjs']]
    ]);
    const evidence = {
        schema: generatedOutputDigestRepairSchema,
        producerId: producer.id,
        repairClass: producer.repairClass,
        sourceParent: revisions.parent,
        sourceCommit: revisions.source,
        mergedPullRequest: 42,
        mergeCommit: revisions.merge,
        baseCommit: revisions.base,
        command: structuredClone(producer.command),
        closure: producer.closure.map((file) => ({ path: file,
            parent: identity(parentFiles.get(file)), source: identity(sourceFiles.get(file)) })),
        output: { path: producer.output, parent: identity(parentOutput), source: identity(parentOutput),
            base: identity(parentOutput), expected: identity(expectedOutput), candidate: identity(expectedOutput) }
    };
    const calls = [];
    const repository = {
        authorityRevision: revisions.base,
        blob(revision, file)
        {
            calls.push(['blob', revision, file]);
            return { mode: '100644', bytes: blobs.get(revision).get(file) };
        },
        commit(revision) { return commits.get(revision); },
        isAncestor() { return true; },
        firstParentRevisions() { return [revisions.source]; },
        changedPaths(parent, head) { return changes.get(`${parent}:${head}`) ?? []; },
        revisionsBetween(ancestor) { return ancestor === revisions.source ? [revisions.merge, revisions.base] : [revisions.head]; },
        replay({ revision, attempt })
        {
            calls.push(['replay', revision, attempt]);
            const content = revision === revisions.parent ? parentOutput : expectedOutput;
            return { revision, isolationId: `${revision}:${attempt}`, first: { mode: '100644', bytes: content },
                second: { mode: '100644', bytes: content }, readPaths: [...producer.closure],
                writePaths: [producer.output], changedPaths: revision === revisions.parent ? [] : [producer.output] };
        }
    };
    const options = { evidence, producer, repository, base: revisions.base, head: revisions.head,
        changedFiles: [producer.manifest, producer.output] };
    return { options, revisions, repository, evidence, producer, blobs, commits, changes, calls };
}

test('digest repair policy accepts one merged multi-file source event including parser changes', () =>
{
    const { options, calls } = fixture();
    const result = verifyGeneratedOutputDigestRepairV2(options);
    assert.equal(result.status, 'verified');
    assert.equal(result.producerCount, 1);
    assert.equal(result.replayIsolations, 8);
    assert.equal(calls.filter(([kind]) => kind === 'replay').length, 8);
});

const preflightCases = [
    ['unknown manifest authority', (state) => { state.evidence.approved = true; }, /invalid closed shape/u],
    ['unregistered producer', (state) => { state.evidence.producerId = 'testing-docs'; }, /producer or repair class mismatch/u],
    ['unknown repair class', (state) => { state.evidence.repairClass = 'full-regeneration'; }, /repair class mismatch/u],
    ['alternate command', (state) => { state.evidence.command.arguments[0] = 'tools/other.mjs'; }, /different command/u],
    ['missing closure entry', (state) => { state.evidence.closure.pop(); }, /cardinality mismatch/u],
    ['duplicate closure path', (state) => { state.evidence.closure[1].path = state.evidence.closure[0].path; }, /trusted closure/u],
    ['escaping output path', (state) => { state.evidence.output.path = '../output.json'; }, /different output/u],
    ['symlink manifest mode', (state) => { state.evidence.closure[0].source.mode = '120000'; }, /regular blob mode/u],
    ['wrong source parent', (state) => { state.evidence.sourceParent = 'f'.repeat(40); }, /exact recorded single parent/u],
    ['wrong pull request', (state) => { state.evidence.mergedPullRequest = 43; }, /recorded merged pull request/u],
    ['wrong base', (state) => { state.evidence.baseCommit = state.revisions.source; }, /base identity mismatch/u],
    ['candidate policy authority', (state) => { state.repository.authorityRevision = state.revisions.head; }, /trusted base/u],
    ['candidate source edit', (state) => { state.options.changedFiles.push('tools/parser.mjs'); }, /only its exact manifest and output/u],
    ['source already wrote output', (state) => { state.changes.get(`${state.revisions.parent}:${state.revisions.source}`).push(state.producer.output); }, /without changing output/u],
    ['source edited policy', (state) => { state.changes.get(`${state.revisions.parent}:${state.revisions.source}`).push('tools/governance/policy.mjs'); }, /trusted policy/u],
    ['wrong ancestry', (state) => { state.repository.isAncestor = () => false; }, /ancestry mismatch/u],
    ['source outside merged branch', (state) => { state.repository.firstParentRevisions = () => [state.revisions.parent]; }, /first-parent history/u],
    ['candidate history source edit reverted', (state) => { state.changes.get(`${state.revisions.base}:${state.revisions.head}`).push('docs/extra.md'); }, /history changed source/u],
    ['candidate output digest mismatch', (state) => { state.blobs.get(state.revisions.head).set(state.producer.output, Buffer.from('{}')); }, /output binding mismatch/u],
    ['source-parent blob changed', (state) => { state.blobs.get(state.revisions.parent).set('tools/parser.mjs', Buffer.from('wrong')); }, /parent closure blob mismatch/u],
    ['closure changed then reverted', (state) => {
        state.blobs.get(state.revisions.intermediate).set('tools/parser.mjs', Buffer.from('temporary change'));
        const previous = state.repository.revisionsBetween;
        state.repository.revisionsBetween = (ancestor) => ancestor === state.revisions.source
            ? [state.revisions.intermediate, state.revisions.merge, state.revisions.base] : previous(ancestor);
    }, /closure changed after source/u],
    ['missing history', (state) => { state.repository.revisionsBetween = () => []; }, /enumerate bounded full history/u],
    ['history bound exceeded', (state) => { state.repository.revisionsBetween = () => Array.from({ length: 129 }, (_, index) => index.toString(16).padStart(40, '0')); }, /revision bound/u],
    ['Git symlink observation', (state) => {
        const read = state.repository.blob;
        state.repository.blob = (...args) => ({ ...read(...args), mode: '120000' });
    }, /bounded regular blob/u],
    ['mode-only source change', (state) => {
        state.evidence.closure[0].source.mode = '100755';
        const read = state.repository.blob;
        state.repository.blob = (revision, file) => ({ ...read(revision, file),
            mode: revision === state.revisions.source && file === 'tests/matrix.yml' ? '100755' : '100644' });
    }, /closure mode changed/u]
];

for (const [name, mutate, expected] of preflightCases)
{
    test(`digest repair rejects ${name} before any replay`, () =>
    {
        const state = fixture();
        mutate(state);
        assert.throws(() => verifyGeneratedOutputDigestRepairV2(state.options), expected);
        assert.equal(state.calls.filter(([kind]) => kind === 'replay').length, 0);
    });
}

const replayCases = [
    ['unregistered read', (observation) => { observation.readPaths.push('config/unowned.json'); }, /read closure is not exact/u],
    ['omitted import', (observation) => { observation.readPaths.pop(); }, /read closure is not exact/u],
    ['extra write', (observation) => { observation.writePaths.push('src/unowned.mjs'); }, /wrote outside/u],
    ['ignored side output', (observation) => { observation.changedPaths.push('.tmp/undeclared'); }, /unregistered tracked, untracked or ignored/u],
    ['non-fixed-point producer', (observation) => { observation.second.bytes = Buffer.from('second run differs'); }, /not a fixed point/u],
    ['reused replay isolation', (observation) => { observation.isolationId = 'same-directory'; }, /distinct fresh isolation/u],
    ['nondeterministic fresh replay', (observation, request) => {
        if (request.attempt === 1) observation.first.bytes = observation.second.bytes = Buffer.from('different fresh result');
    }, /fresh replays are nondeterministic/u],
    ['symlink output', (observation) => { observation.first.mode = '120000'; }, /bounded regular blob/u]
];

for (const [name, mutate, expected] of replayCases)
{
    test(`digest repair rejects ${name}`, () =>
    {
        const state = fixture();
        const replay = state.repository.replay;
        state.repository.replay = (request) =>
        {
            const observation = replay(request);
            mutate(observation, request);
            return observation;
        };
        assert.throws(() => verifyGeneratedOutputDigestRepairV2(state.options), expected);
    });
}

test('digest repair rejects an unsynchronized source parent', () =>
{
    const state = fixture();
    const stale = Buffer.from('{"stale":true}');
    for (const revision of [state.revisions.parent, state.revisions.source, state.revisions.merge, state.revisions.base])
        state.blobs.get(revision).set(state.producer.output, stale);
    for (const key of ['parent', 'source', 'base']) state.evidence.output[key] = identity(stale);
    assert.throws(() => verifyGeneratedOutputDigestRepairV2(state.options), /not canonically synchronized/u);
});

for (const entries of [[], [{ producerId: 'matrix:unit', allowedRetries: 1, qualificationEligible: true }],
    [{ producerId: 'matrix:unit', allowedRetries: 0, qualificationEligible: true }, { producerId: 'matrix:extra' }]])
{
    test(`digest repair rejects a canonical entry mutation ${JSON.stringify(entries)}`, () =>
    {
        assert.throws(() => verifyGeneratedOutputDigestRepairV2(fixture({ entries }).options), /producer entries or other non-digest fields/u);
    });
}

test('digest repair rejects a self-reported input digest even when every replay reproduces it', () =>
{
    const state = fixture({ sourceDigests: { 'tests/matrix.yml': `sha256:${'f'.repeat(64)}` } });
    assert.throws(() => verifyGeneratedOutputDigestRepairV2(state.options), /not bound to Git bytes/u);
});

test('digest repair rejects an invalid output seal even when every replay reproduces it', () =>
{
    assert.throws(() => verifyGeneratedOutputDigestRepairV2(fixture({ badSeal: true }).options), /content seal is invalid/u);
});
