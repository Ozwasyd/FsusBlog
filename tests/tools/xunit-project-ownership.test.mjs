import assert from 'node:assert/strict';
import test from 'node:test';

import { xunitTestProjects } from '../../tools/test-inventory/adapters.mjs';
import {
    groupXunitSources,
    validateXunitProjectReport,
    xunitProjects
} from '../../tools/test-inventory/xunit-projects.mjs';

// Pure owner/report fixtures only; no compiler, assembly or execution evidence.
test('xunit ownership derives from the existing canonical v2 registry, not a second table', () =>
{
    assert.deepEqual(xunitProjects, xunitTestProjects.map(({ directory, project }) =>
        ({ project, sourceDirectory: directory })));
    assert.ok(Object.isFrozen(xunitProjects));
    assert.ok(xunitProjects.every(Object.isFrozen));
    const sources = xunitProjects.map(({ sourceDirectory }) =>
        ({ path: `${sourceDirectory}/ExampleTests.cs`, adapter: 'xunit' }));
    const groups = groupXunitSources(sources);
    assert.deepEqual(groups.map(({ sourceFiles }) => sourceFiles.length), sources.map(() => 1));
    assert.deepEqual(sources.map(({ path }) => path), groups.flatMap(({ sourceFiles }) =>
        sourceFiles.map(({ path }) => path)));
});

test('xunit source grouping refuses missing, duplicate and non-normalized owners', () =>
{
    for (const path of [
        'tests/foreign/ExampleTests.cs',
        'tests/migration/../backend/ExampleTests.cs',
        'tests/migration//ExampleTests.cs',
        'tests\\migration\\ExampleTests.cs'
    ])
    {
        assert.throws(() => groupXunitSources([{ path, adapter: 'xunit' }]), /xunit source/u);
    }
    const source = { path: 'tests/migration/ExampleTests.cs', adapter: 'xunit' };
    assert.throws(() => groupXunitSources([source, source]), /unique normalized/u);
    for (const projects of [
        [xunitProjects[0], xunitProjects[0]],
        [{ sourceDirectory: 'tests/migration', project: 'tests/backend/Other.csproj' }],
        [{ sourceDirectory: 'tests/migration', project: 'tests/migration/../Other.csproj' }]
    ])
    {
        assert.throws(() => groupXunitSources([source], projects), /unique repository test projects/u);
    }
});

test('xunit project report retains exact owned case identity and rejects diagnostic or partial reports', () =>
{
    const path = 'tests/migration/ExampleTests.cs';
    const owner = groupXunitSources([{ path, adapter: 'xunit' }])
        .find(({ sourceDirectory }) => sourceDirectory === 'tests/migration');
    const report = {
        schema: 'fsusblog.test-inventory.xunit-roslyn.v1',
        adapter: 'xunit',
        adapterVersion: 'xunit.v2',
        diagnostics: [],
        testCases: [{ adapter: 'xunit', ownerFile: path, id: `xunit:${path}#Example.Test#case-0000` }]
    };
    assert.equal(validateXunitProjectReport(owner, report), report);
    for (const mutate of [
        (value) => { value.schema = 'foreign'; },
        (value) => { value.adapterVersion = 'xunit.v1'; },
        (value) => { value.diagnostics = null; },
        (value) => { value.diagnostics.push({ severity: 'warning', message: 'unresolved input' }); },
        (value) => { value.testCases = []; },
        (value) => { value.testCases[0].adapter = 'node-test'; },
        (value) => { value.testCases[0].ownerFile = 'tests/backend/ExampleTests.cs'; },
        (value) => { value.testCases[0].id = 'foreign-id'; },
        (value) => { value.testCases[0].id = `xunit:${path}#`; },
        (value) => { value.testCases.push(value.testCases[0]); }
    ])
    {
        const invalid = structuredClone(report);
        mutate(invalid);
        assert.throws(() => validateXunitProjectReport(owner, invalid), /xunit/u);
    }
});
