import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const { loadTestMatrix } = await import(new URL('../../tools/test-matrix/command-groups.mjs', import.meta.url));
const { executeWeightedStepDag } = await import(new URL('../../tools/test/bundles/bundle-steps.mjs', import.meta.url));
const {
    executeFrontendManifestEntry,
    parseFrontendManifestEntryArguments
} = await import(new URL('../../tools/test/frontend-atomic/manifest-entry.mjs', import.meta.url));
const {
    projectFrontendManifestGroup,
    projectFrontendManifestGroups
} = await import(new URL('../../tools/test/frontend-atomic/manifest-projection.mjs', import.meta.url));

const root = fileURLToPath(new URL('../..', import.meta.url));

function fixture(t, dependencies = [])
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-frontend-atomic-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(path.join(directory, 'tests'));
    fs.mkdirSync(path.join(directory, 'src/frontend'), { recursive: true });
    const matrix = {
        tiers: [{ id: 'frontend-fixture', executionDependsOn: [], executionClass: 'runtime' }],
        commandGroups: {
            'frontend-fixture': {
                schema: 'fsusblog.test-command-manifest.v1',
                lane: 'frontend-fixture',
                commands: ['a', 'b'].map((id) => ({
                    id,
                    access: 'read',
                    command: [process.execPath, '-e',
                        `require('node:fs').appendFileSync('executed.txt','${id}\\n');process.exit(${id === 'a' ? 1 : 0})`],
                    dependsOn: id === 'b' ? dependencies : []
                }))
            }
        }
    };
    const write = () =>
    {
        const group = matrix.commandGroups['frontend-fixture'];
        const flowMapping = (value) => `{ ${Object.entries(value)
            .map(([key, entry]) => `${key}: ${JSON.stringify(entry)}`).join(', ')} }`;
        fs.writeFileSync(path.join(directory, 'tests/matrix.yml'), [
            'tiers:',
            `    - ${flowMapping(matrix.tiers[0])}`,
            'commandGroups:',
            '    frontend-fixture:',
            `        schema: ${JSON.stringify(group.schema)}`,
            `        lane: ${JSON.stringify(group.lane)}`,
            '        commands:',
            ...group.commands.map((entry) => `            - ${flowMapping(entry)}`),
            ''
        ].join('\n'));
    };
    write();
    return { directory, matrix, write };
}

test('frontend manifest projection derives all current entries and retains complete declarations', () =>
{
    const matrix = loadTestMatrix(root);
    const result = projectFrontendManifestGroups(matrix);
    assert.equal(result.qualificationEligible, false);
    assert.deepEqual(result.groups.map((group) => group.groupId),
        Object.keys(matrix.commandGroups).filter((id) => id.startsWith('frontend-')).sort());
    for (const group of result.groups)
    {
        assert.deepEqual(group.parentDeclaration, matrix.tiers.find((tier) => tier.id === group.groupId));
        assert.deepEqual(group.entries.map((entry) => entry.manifestEntry), matrix.commandGroups[group.groupId].commands);
        assert.deepEqual(group.settledProjection.settledDependsOn, group.entries.map((entry) => entry.id));
        assert.equal(Object.hasOwn(group.settledProjection, 'command'), false);
    }
});

test('manifest additions, deletion and command/resource/applicability edits change the same source projection', () =>
{
    const matrix = loadTestMatrix(root);
    const original = projectFrontendManifestGroups(matrix);
    const group = matrix.commandGroups['frontend-runtime-contracts'];
    group.commands.push({ id: 'new-entry', command: ['node', 'new.mjs'], access: 'read',
        resources: { countedResources: { browser: 1 }, exclusiveResources: ['new-output'] },
        applicability: { platforms: ['linux'] } });
    const changed = projectFrontendManifestGroups(matrix);
    assert.notEqual(changed.sourceDigest, original.sourceDigest);
    const entry = changed.groups.find((item) => item.groupId === group.lane).entries.at(-1);
    assert.deepEqual(entry.manifestEntry, group.commands.at(-1));
    group.commands.pop();
    assert.deepEqual(projectFrontendManifestGroups(matrix), original);
    group.commands[0].script = 'changed-script';
    assert.notEqual(projectFrontendManifestGroups(matrix).sourceDigest, original.sourceDigest);
});

test('manifest duplicate/orphan IDs and ambiguous parents fail closed', () =>
{
    const matrix = loadTestMatrix(root);
    matrix.commandGroups['frontend-runtime-contracts'].commands[1].id = 'worker-contracts';
    assert.throws(() => projectFrontendManifestGroups(matrix), /duplicate command id/u);
    matrix.commandGroups['frontend-runtime-contracts'].commands[1].id = 'new-id';
    matrix.commandGroups['frontend-runtime-contracts'].commands[1].dependsOn = ['not-an-entry'];
    assert.throws(() => projectFrontendManifestGroups(matrix), /unknown command/u);
    matrix.commandGroups['frontend-runtime-contracts'].commands[1].dependsOn = [];
    matrix.tiers.push(structuredClone(matrix.tiers.find((tier) => tier.id === 'frontend-runtime-contracts')));
    assert.throws(() => projectFrontendManifestGroups(matrix), /exactly one matrix parent/u);
});

test('manifest group order supplies no dependency and missing contracts remain explicit', () =>
{
    const matrix = loadTestMatrix(root);
    const entries = projectFrontendManifestGroup(matrix, 'frontend-runtime-contracts').entries;
    assert.ok(entries.every((entry) => entry.dependsOn.length === 0 && entry.settledDependsOn.length === 0));
    assert.ok(entries.every((entry) => entry.missingContracts.includes('entry-input-closure')
        && entry.missingContracts.includes('entry-resource-contract')));
    matrix.commandGroups['frontend-runtime-contracts'].commands.reverse();
    assert.ok(projectFrontendManifestGroup(matrix, 'frontend-runtime-contracts').entries
        .every((entry) => entry.dependsOn.length === 0));
});

for (const dependencies of [[], ['a']])
{
    test(`existing DAG executes a failing entry once; sibling ${dependencies.length ? 'is blocked' : 'completes'}`, async (t) =>
    {
        const { directory, matrix } = fixture(t, dependencies);
        const projection = projectFrontendManifestGroup(matrix, 'frontend-fixture');
        const steps = projection.entries.map((entry) => ({ ...entry,
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }));
        let failure;
        try
        {
            await executeWeightedStepDag(steps, { maxParallel: 2, cpuUnits: 2, memoryGiB: 1 },
                (entry) => executeFrontendManifestEntry({ root: directory, groupId: projection.groupId,
                    entryId: entry.id, expectedSourceDigest: projection.sourceDigest }));
        }
        catch (error)
        {
            failure = error;
        }
        assert.equal(failure.states.a, 'failed');
        assert.equal(failure.states.b, dependencies.length ? 'blocked' : 'success');
        const observed = fs.readFileSync(path.join(directory, 'src/frontend/executed.txt'), 'utf8').trim().split('\n').sort();
        assert.deepEqual(observed, dependencies.length ? ['a'] : ['a', 'b']);
    });
}

test('single entry rejects stale source digest and unknown ID before spawn', async (t) =>
{
    const { directory, matrix, write } = fixture(t);
    const projection = projectFrontendManifestGroup(matrix, 'frontend-fixture');
    const options = { root: directory, groupId: projection.groupId, entryId: 'b',
        expectedSourceDigest: projection.sourceDigest };
    await assert.rejects(executeFrontendManifestEntry({ ...options, entryId: 'unknown' }), /unknown frontend/u);
    matrix.commandGroups['frontend-fixture'].commands[1].command.push('changed');
    write();
    await assert.rejects(executeFrontendManifestEntry(options), /source digest mismatch/u);
    assert.equal(fs.existsSync(path.join(directory, 'src/frontend/executed.txt')), false);
});

test('single entry refuses canonical composite localCommands instead of executing its wrapper', async () =>
{
    const projection = projectFrontendManifestGroup(loadTestMatrix(root), 'frontend-static-governance');
    assert.ok(projection.entries.find((entry) => entry.id === 'views-constraints').missingContracts
        .includes('composite-entry-disposition'));
    await assert.rejects(executeFrontendManifestEntry({ root, groupId: projection.groupId,
        entryId: 'views-constraints', expectedSourceDigest: projection.sourceDigest }), /composite-entry disposition/u);
});

test('single-entry CLI requires all exact selectors and refuses duplicate or group-only invocation', () =>
{
    for (const argv of [[], ['--matrix-group', 'frontend-runtime-contracts'],
        ['--entry-id', 'a', '--entry-id', 'b'], ['--unknown', 'a'],
        ['--matrix-group', '--entry-id']])
    {
        assert.throws(() => parseFrontendManifestEntryArguments(argv), /requires/u);
    }
    assert.deepEqual(parseFrontendManifestEntryArguments(['--matrix-group', 'frontend-runtime-contracts',
        '--entry-id', 'worker-contracts', '--source-digest', 'sha256:source']), {
        groupId: 'frontend-runtime-contracts', entryId: 'worker-contracts', expectedSourceDigest: 'sha256:source'
    });
});
