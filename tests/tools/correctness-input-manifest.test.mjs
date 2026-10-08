import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createCorrectnessInputManifest, validateCorrectnessInputManifest,
    validateCorrectnessInputReadTrace } = await import(new URL('../../tools/test-matrix/correctness-input-manifest.mjs', import.meta.url));
const { runDag, tierInputFingerprint } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const { digestValue } = await import(new URL('../../tools/release/browser-contract-receipt-contract.mjs', import.meta.url));
const { controlledSchedulerCandidate } = await import(new URL('./support/canonical-scheduler-fixture.mjs', import.meta.url));

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'correctness-input-manifest-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (file, value) =>
    {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), value);
    };
    write('tools/entry.mjs', "import './helper.mjs';\n");
    write('tools/helper.mjs', 'export const value = 1;\n');
    write('package.json', '{"type":"module"}\n');
    const options = { root, entryCommand: 'node tools/entry.mjs', entryPath: 'tools/entry.mjs' };
    const tier = { id: 'controlled-correctness', command: options.entryCommand,
        cacheInputs: ['tools/entry.mjs'], executionKey: 'controlled-correctness' };
    return { root, write, options, tier };
}

test('automatic Node closure changes the real scheduler fingerprint despite an omitted manual helper', (t) =>
{
    const current = fixture(t);
    const first = createCorrectnessInputManifest(current.options);
    assert.deepEqual(first.staticDependencyPaths, ['package.json', 'tools/helper.mjs']);
    const before = tierInputFingerprint(current.tier, current.root, { inputManifest: first });
    current.write('tools/helper.mjs', 'export const value = 2;\n');
    assert.throws(() => validateCorrectnessInputManifest(first, { root: current.root }), /content-drift: tools\/helper/u);
    const next = createCorrectnessInputManifest(current.options);
    assert.notEqual(next.closureDigest, first.closureDigest);
    assert.notEqual(tierInputFingerprint(current.tier, current.root, { inputManifest: next }), before);
});

test('existing canonical shell parser includes sourced and directly executed helper dependencies', (t) =>
{
    const current = fixture(t);
    current.write('tools/entry.sh', '#!/usr/bin/env bash\nsource tools/helper.sh\nbash tools/child.sh\n');
    current.write('tools/helper.sh', 'echo helper\n');
    current.write('tools/child.sh', 'echo child\n');
    const options = { ...current.options, entryCommand: 'bash tools/entry.sh', entryPath: 'tools/entry.sh' };
    const first = createCorrectnessInputManifest(options);
    assert.deepEqual(first.staticDependencyPaths, ['tools/child.sh', 'tools/helper.sh']);
    current.write('tools/helper.sh', 'echo changed\n');
    assert.notEqual(createCorrectnessInputManifest(options).closureDigest, first.closureDigest);
});

test('unresolved dynamic module and read declarations fail closed instead of falling back to repository hashing', (t) =>
{
    const current = fixture(t);
    current.write('tools/entry.mjs', 'await import(process.env.DYNAMIC_MODULE);\n');
    assert.throws(() => createCorrectnessInputManifest(current.options), /unresolved dynamic import/u);
    current.write('tools/entry.mjs', "import './helper.mjs';\n");
    assert.throws(() => createCorrectnessInputManifest({ ...current.options,
        unresolvedDynamicReads: ['dynamic configuration'] }), /unresolved-dynamic-read/u);
});

test('bounded configuration, toolchain and local alias identities are additive and content bound', (t) =>
{
    const current = fixture(t);
    for (const file of ['global.json', 'Directory.Build.props', 'config/policy.json', 'aliases/fsusui-identity.json'])
    {
        current.write(file, 'initial');
    }
    const options = { ...current.options, toolchainInputs: ['global.json'],
        configurationInputs: ['Directory.Build.props', 'config/policy.json'], localAliasInputs: ['aliases/fsusui-identity.json'] };
    const first = createCorrectnessInputManifest(options);
    for (const file of ['global.json', 'Directory.Build.props', 'config/policy.json', 'aliases/fsusui-identity.json'])
    {
        current.write(file, 'changed');
        assert.notEqual(createCorrectnessInputManifest(options).closureDigest, first.closureDigest, file);
        current.write(file, 'initial');
    }
    // These are bound declarations, not an automatic MSBuild graph or live external FsusUI alias collector.
    current.write('project.csproj', '<Project Sdk="Microsoft.NET.Sdk" />');
    assert.throws(() => createCorrectnessInputManifest({ ...options, entryPath: 'project.csproj',
        entryCommand: 'dotnet test project.csproj' }), /language-unavailable/u);
});

test('complete owner-supplied current trace accepts declared config and rejects an undeclared template', (t) =>
{
    const current = fixture(t);
    current.write('config/settings.json', '{}');
    current.write('templates/page.html', '<p>template</p>');
    const manifest = createCorrectnessInputManifest({ ...current.options, dynamicDeclaredInputs: ['config/settings.json'] });
    const identity = { runId: 'input-run', targetTierId: current.tier.id, targetAttemptId: 'input-attempt' };
    const trace = { schema: 'fsusblog.correctness-input-read-trace.v1', complete: true, ...identity,
        manifestDigest: manifest.closureDigest, reads: ['tools/entry.mjs', 'tools/helper.mjs', 'config/settings.json'] };
    assert.equal(validateCorrectnessInputReadTrace({ manifest, trace, ...identity, root: current.root }).qualificationEligible, false);
    assert.throws(() => validateCorrectnessInputReadTrace({ manifest, ...identity, root: current.root }), /unavailable-or-mismatched/u);
    assert.throws(() => validateCorrectnessInputReadTrace({ manifest, trace: { ...trace, complete: false },
        ...identity, root: current.root }), /unavailable-or-mismatched/u);
    assert.throws(() => validateCorrectnessInputReadTrace({ manifest, trace: { ...trace,
        reads: [...trace.reads, 'templates/page.html'] }, ...identity, root: current.root }), /undeclared-read: templates\/page/u);
    assert.throws(() => validateCorrectnessInputReadTrace({ manifest, trace,
        ...identity, targetAttemptId: 'other-attempt', root: current.root }), /unavailable-or-mismatched/u);
});

test('generated output cycles, broad inputs, symlink aliases and command mismatch reject', (t) =>
{
    const current = fixture(t);
    current.write('.tmp/output.json', '{}');
    assert.throws(() => createCorrectnessInputManifest({ ...current.options,
        dynamicDeclaredInputs: ['.tmp/output.json'] }), /generated-output-in-inputs/u);
    assert.throws(() => createCorrectnessInputManifest({ ...current.options,
        generatedOutputPaths: ['tools/helper.mjs'] }), /generated-output-in-inputs/u);
    for (const value of ['.', 'tools', '**/*', '../other'])
    {
        assert.throws(() => createCorrectnessInputManifest({ ...current.options,
            supplementalInputs: [value] }), /path-invalid|not-finite-file/u);
    }
    fs.symlinkSync('helper.mjs', path.join(current.root, 'tools/alias.mjs'));
    assert.throws(() => createCorrectnessInputManifest({ ...current.options,
        localAliasInputs: ['tools/alias.mjs'] }), /symlink/u);
    assert.throws(() => createCorrectnessInputManifest({ ...current.options,
        entryCommand: 'node tools/unrelated.mjs' }), /command-path-mismatch/u);
});

test('resealed narrowed manifests cannot remove automatic dependencies or smuggle unrelated digest entries', (t) =>
{
    const current = fixture(t);
    const manifest = createCorrectnessInputManifest(current.options);
    const narrowed = structuredClone(manifest);
    narrowed.staticDependencyPaths = ['package.json'];
    delete narrowed.contentDigests['tools/helper.mjs'];
    delete narrowed.closureDigest;
    narrowed.closureDigest = digestValue(narrowed);
    assert.throws(() => validateCorrectnessInputManifest(narrowed, { root: current.root }), /static-closure-narrowed/u);
    const changed = structuredClone(manifest);
    changed.contentDigests.extra = `sha256:${'a'.repeat(64)}`;
    delete changed.closureDigest;
    changed.closureDigest = digestValue(changed);
    assert.throws(() => validateCorrectnessInputManifest(changed, { root: current.root }), /digest-roster-mismatch/u);
});

test('static manifest alone cannot authorize scheduler reuse without a connected real read-trace owner', async (t) =>
{
    const current = fixture(t);
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'controlled-input-source' };
    let executions = 0;
    const options = { root: current.root, runsRoot: path.join(current.root, 'runs'), runId: 'manifest-source-run',
        targetTierId: current.tier.id, sourceState, snapshotWorktree: async () => ({ fingerprint: sourceState.worktreeFingerprint, entries: new Map() }),
        dynamicPriority: false, systemResources: { cpuCount: 2, availableMemoryGiB: 8, load1: 0 }, currentFreeMemoryGiB: () => 8,
        candidateIdentity: controlledSchedulerCandidate(sourceState), verifyCandidateIdentity: async (document) => document,
        correctnessInputManifests: { [current.tier.id]: createCorrectnessInputManifest(current.options) },
        tiers: [{ ...current.tier, executionDependsOn: [], services: [], parallelizable: true, exclusiveResources: [],
            resourceClass: 'cpu', cpuUnits: 1, memoryGiB: 1 }],
        executeTier: async () =>
        {
            executions += 1;
            return { code: 0, signal: null };
        } };
    const first = await runDag(options);
    const resumed = await runDag({ ...options, mode: 'resume', resume: true,
        resumeCandidateIdentityDigest: first.checkpoint.schedulerCandidateIdentityDigest });
    assert.deepEqual(resumed.reusedTiers, []);
    assert.equal(executions, 2);
    assert.equal(resumed.checkpoint.authoritative, false);
});
