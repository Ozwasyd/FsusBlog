import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { inspectReleaseFinalCommandTarget, validateApplicableExecutionAuthority, validateSourceGovernanceChildExecution } = await import(new URL('../../tools/test-matrix/release-final-static-boundary.mjs', import.meta.url));
const { sourceGovernanceChildEntries, sourceGovernanceExecutionTarget, sourceGovernanceExecutableEntries, sourceGovernanceDataInputs } = await import(new URL('../../tools/test-matrix/pr-impact-plan.mjs', import.meta.url));

const target = (value, owner) => ({ target: value, owners: [owner],
    declarations: [{ owner, argv: [value], commandKind: 'test', executionMode: 'execution' }],
    contentDigest: 'source-bound', indexDigest: 'index-bound', dependencyClosure: ['tools/shared.mjs'] });
const full = () => ({ schema: 'fsusblog.release-final-execution-target-authority.v2',
    source: 'tests/matrix.yml', sourceIndex: 'independent-index', sourceIndexDigest: 'independent-byte-binding',
    producer: 'original-producer', nodeParserIdentity: { nodeVersion: 'sealed' },
    targets: [target('tools/selected.mjs', 'selected'), target('tools/unselected.mjs', 'unselected')],
    closureFiles: [{ path: 'tools/shared.mjs', contentDigest: 'source-bound', indexDigest: 'index-bound' },
        { path: 'tools/unselected-dependency.mjs', contentDigest: 'other-source', indexDigest: 'other-index' }] });
const applicable = () => ({ ...full(), targets: [target('tools/selected.mjs', 'selected')],
    closureFiles: [full().closureFiles[0]] });

test('applicable exact target and dependency remain bound without certifying unrelated targets', () =>
{
    const expected = full();
    expected.targets[1].contentDigest = 'historical-unrelated-source';
    assert.deepEqual(validateApplicableExecutionAuthority(applicable(), expected, new Set(['selected']), [{ target: 'tools/selected.mjs', owners: ['selected'] }]), []);
});

test('the original Markdown adapter has an exact source-only declaration and five actual repository inputs', t =>
{
    const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
    const root = mkdtempSync(path.join(os.tmpdir(), 'markdown-source-declaration-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const indexPath = 'config/testing/release-final-execution-authority-index.json';
    const owner = sourceGovernanceChildEntries.docs;
    const index = JSON.parse(readFileSync(path.join(repositoryRoot, indexPath), 'utf8'));
    const rows = index.runtimeDynamicImports.filter(row => row.owner === owner);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.deepEqual(row.dependencies, [
        '../../config/development/native-tooling-style-policy.json',
        '../../config/development/authoritative-development-docs.json',
        '../../config/development/native-tooling-style-exceptions.json',
        '../../config/development/native-tooling-style-baseline.json',
        '../../.markdownlint-cli2.jsonc'
    ]);
    const put = (entry, bytes) =>
    {
        mkdirSync(path.dirname(path.join(root, entry)), { recursive: true });
        writeFileSync(path.join(root, entry), bytes);
    };
    const inputs = row.dependencies.map(dependency => path.posix.normalize(path.posix.join(path.posix.dirname(owner), dependency)));
    for (const entry of [owner, ...inputs])
    {
        put(entry, readFileSync(path.join(repositoryRoot, entry)));
    }
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '--quiet');
    git('config', 'user.name', 'Source declaration control');
    git('config', 'user.email', 'source-control@example.invalid');
    git('add', '.');
    git('commit', '--quiet', '-m', 'test fixture');
    const inspect = value =>
    {
        put(indexPath, `${JSON.stringify(value)}\n`);
        git('add', indexPath);
        const isolated = mkdtempSync(path.join(os.tmpdir(), 'markdown-declaration-case-'));
        t.after(() => rmSync(isolated, { recursive: true, force: true }));
        cpSync(root, isolated, { recursive: true });
        return inspectReleaseFinalCommandTarget({ repositoryRoot: isolated, target: owner });
    };
    const positive = inspect(index);
    assert.deepEqual(positive.errors, []);
    assert.deepEqual(positive.dependencyClosure.map(record => record.path).sort(), inputs.sort());
    for (const field of ['owner', 'sourceDigest', 'expressionDigest', 'kind'])
    {
        const changed = structuredClone(index);
        changed.runtimeDynamicImports.find(value => value.owner === owner)[field] = 'unreviewed';
        assert.ok(inspect(changed).errors.some(error => error.includes('unresolved dynamic import')), field);
    }
    const unknownInput = structuredClone(index);
    unknownInput.runtimeDynamicImports.find(value => value.owner === owner).dependencies.push('../../config/unreviewed-input.json');
    assert.notEqual(inspect(unknownInput).errors.length, 0);
    put(indexPath, `${JSON.stringify(index)}\n`);
    git('add', indexPath);
    rmSync(path.join(root, inputs[0]));
    assert.notEqual(inspect(index).errors.length, 0);
});

test('the existing blame validator parser load has one exact independently reviewed source declaration', t =>
{
    const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
    const root = mkdtempSync(path.join(os.tmpdir(), 'blame-parser-source-declaration-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const indexPath = 'config/testing/release-final-execution-authority-index.json';
    const owner = 'tools/governance/javascript-format-equivalence.mjs';
    const index = JSON.parse(readFileSync(path.join(repositoryRoot, indexPath), 'utf8'));
    const rows = index.runtimeDynamicImports.filter(row => row.owner === owner);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].dependencies, [
        './javascript-format-parser/package.json',
        './javascript-format-parser/package-lock.json'
    ]);
    const inputs = rows[0].dependencies.map(dependency => path.posix.normalize(path.posix.join(path.posix.dirname(owner), dependency)));
    const put = (entry, bytes) =>
    {
        mkdirSync(path.dirname(path.join(root, entry)), { recursive: true });
        writeFileSync(path.join(root, entry), bytes);
    };
    for (const entry of [owner, ...inputs])
    {
        put(entry, readFileSync(path.join(repositoryRoot, entry)));
    }
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '--quiet');
    git('config', 'user.name', 'Source declaration control');
    git('config', 'user.email', 'source-control@example.invalid');
    git('add', '.');
    git('commit', '--quiet', '-m', 'test fixture');
    const inspect = value =>
    {
        put(indexPath, JSON.stringify(value) + '\n');
        git('add', indexPath);
        const isolated = mkdtempSync(path.join(os.tmpdir(), 'blame-parser-declaration-case-'));
        t.after(() => rmSync(isolated, { recursive: true, force: true }));
        cpSync(root, isolated, { recursive: true });
        return inspectReleaseFinalCommandTarget({ repositoryRoot: isolated, target: owner });
    };
    const positive = inspect(index);
    assert.deepEqual(positive.errors, []);
    assert.deepEqual(positive.dependencyClosure.map(record => record.path).sort(), [...inputs].sort());
    const absent = structuredClone(index);
    absent.runtimeDynamicImports = absent.runtimeDynamicImports.filter(row => row.owner !== owner);
    assert.ok(inspect(absent).errors.some(error => error.includes('unresolved dynamic require')));
    for (const field of ['owner', 'sourceDigest', 'expressionDigest', 'kind'])
    {
        const changed = structuredClone(index);
        changed.runtimeDynamicImports.find(row => row.owner === owner)[field] = 'unreviewed';
        assert.ok(inspect(changed).errors.some(error => error.includes('unresolved dynamic require')), field);
    }
    for (const entry of inputs)
    {
        rmSync(path.join(root, entry));
        assert.notEqual(inspect(index).errors.length, 0, entry);
        put(entry, readFileSync(path.join(repositoryRoot, entry)));
        git('add', entry);
    }
    const alias = structuredClone(index);
    alias.runtimeDynamicImports.find(row => row.owner === owner).dependencies.push('./javascript-format-parser/missing.json');
    assert.notEqual(inspect(alias).errors.length, 0);
    const linked = structuredClone(index);
    const linkedPath = 'tools/governance/javascript-format-parser/manifest-alias.json';
    symlinkSync('package.json', path.join(root, linkedPath));
    git('add', linkedPath);
    linked.runtimeDynamicImports.find(row => row.owner === owner).dependencies[0] = './javascript-format-parser/manifest-alias.json';
    assert.notEqual(inspect(linked).errors.length, 0);
    put(owner, readFileSync(path.join(repositoryRoot, owner), 'utf8') + '\n// unreviewed owner drift\n');
    git('add', owner);
    assert.ok(inspect(index).errors.some(error => error.includes('unresolved dynamic require')));
});

test('changed applicable source, index, owner and argv each refuse', () =>
{
    for (const mutate of [
        value =>
        {
            value.targets[0].contentDigest = 'tampered-source';
        },
        value =>
        {
            value.targets[0].indexDigest = 'tampered-index';
        },
        value =>
        {
            value.targets[0].owners = ['unregistered-owner'];
        },
        value =>
        {
            value.targets[0].declarations[0].argv = ['tools/selected.mjs', '--hidden'];
        },
        value =>
        {
            value.closureFiles[0].contentDigest = 'tampered-dependency';
        }
    ])
    {
        const value = applicable();
        mutate(value);
        assert.ok(validateApplicableExecutionAuthority(value, full(), new Set(['selected']), [{ target: 'tools/selected.mjs', owners: ['selected'] }]).length);
    }
});

test('missing applicable target/dependency, parser or independent index binding refuses', () =>
{
    for (const mutate of [
        value =>
        {
            value.targets = [];
        },
        value =>
        {
            value.closureFiles = [];
        },
        value =>
        {
            value.nodeParserIdentity.nodeVersion = 'unsealed';
        },
        value =>
        {
            value.sourceIndexDigest = 'candidate-minted';
        }
    ])
    {
        const expected = full();
        mutate(expected);
        assert.ok(validateApplicableExecutionAuthority(applicable(), expected, new Set(['selected']), [{ target: 'tools/selected.mjs', owners: ['selected'] }]).length);
    }
});

test('duplicate authority records cannot mint an applicable binding by last-entry overwrite', () =>
{
    const expected = full();
    expected.targets.push({ ...expected.targets[0] });
    expected.closureFiles.push({ ...expected.closureFiles[0] });
    assert.ok(validateApplicableExecutionAuthority(applicable(), expected, new Set(['selected']), [{ target: 'tools/selected.mjs', owners: ['selected'] }]).some(error => error.includes('duplicate')));
});

test('omitting a required applicable dependency cannot become an empty successful closure', () =>
{
    const value = applicable();
    value.closureFiles = [];
    assert.ok(validateApplicableExecutionAuthority(value, full(), new Set(['selected']), [{ target: 'tools/selected.mjs', owners: ['selected'] }]).some(error => error.includes('missing applicable')));
});

test('actual target or selected owner omissions cannot self-authorize an empty subset', () =>
{
    for (const mutate of [value =>
    {
        value.targets = [];
        value.closureFiles = [];
    },
    value =>
    {
        value.targets[0].owners = [];
        value.targets[0].declarations = [];
    }])
    {
        const value = applicable();
        mutate(value);
        assert.ok(validateApplicableExecutionAuthority(value, full(), new Set(['selected']), [{ target: 'tools/selected.mjs', owners: ['selected'] }]).some(error => error.includes('roster')));
    }
});

test('source governance owns all four actual child entries and recursive indexed source, with independent cache vectors', t =>
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'source-child-closure-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    const put = (entry, bytes) =>
    {
        mkdirSync(path.dirname(path.join(root, entry)), { recursive: true });
        writeFileSync(path.join(root, entry), bytes);
    };
    put(sourceGovernanceExecutionTarget, 'export const sourceOnly = true;\n');
    for (const entry of [...sourceGovernanceExecutableEntries(), ...sourceGovernanceDataInputs])
    {
        put(entry, entry.endsWith('.json') ? '{}\n' : 'export const checker = true;\n');
    }
    const dependency = 'tools/shared/actual-child-input.mjs';
    put(dependency, 'export const immutableInput = 1;\n');
    put(sourceGovernanceChildEntries.frontend, "import '../shared/actual-child-input.mjs';\n");
    git('init', '--quiet');
    git('config', 'user.name', 'Source closure control');
    git('config', 'user.email', 'source-control@example.invalid');
    git('add', '.');
    git('commit', '--quiet', '-m', 'test fixture');
    const original = inspectReleaseFinalCommandTarget({ repositoryRoot: root, target: sourceGovernanceExecutionTarget });
    assert.equal(original.dependencyClosure.length, 0);
    const bound = inspectReleaseFinalCommandTarget({ repositoryRoot: root, target: sourceGovernanceExecutionTarget,
        additionalTargets: [...sourceGovernanceExecutableEntries(), ...sourceGovernanceDataInputs] });
    assert.deepEqual(bound.errors, []);
    const closure = bound.dependencyClosure.map(record => record.path);
    for (const entry of [...sourceGovernanceExecutableEntries(), ...sourceGovernanceDataInputs, dependency])
    {
        assert.ok(closure.includes(entry), entry);
    }
    const authority = { targets: [{ target: sourceGovernanceExecutionTarget, owners: ['source-governance'], dependencyClosure: closure }],
        closureFiles: bound.dependencyClosure };
    const current = inspectReleaseFinalCommandTarget({ repositoryRoot: root, target: sourceGovernanceChildEntries.frontend, additionalTargets: sourceGovernanceDataInputs });
    assert.deepEqual(validateSourceGovernanceChildExecution(current, authority, sourceGovernanceChildEntries.frontend), []);
    assert.ok(validateSourceGovernanceChildExecution(current, authority, dependency).some(error => error.includes('unknown')));
    const missingInput = structuredClone(authority);
    missingInput.targets[0].dependencyClosure = closure.filter(entry => entry !== sourceGovernanceDataInputs[0]);
    assert.ok(validateSourceGovernanceChildExecution(current, missingInput, sourceGovernanceChildEntries.frontend).some(error => error.includes('omits child')));
    const omittedCurrent = { ...current, dependencyClosure: current.dependencyClosure.filter(record => record.path !== sourceGovernanceDataInputs[0]) };
    assert.ok(validateSourceGovernanceChildExecution(omittedCurrent, authority, sourceGovernanceChildEntries.frontend).some(error => error.includes('current data input omitted')));
    const missing = structuredClone(authority);
    missing.targets[0].dependencyClosure = closure.filter(entry => entry !== sourceGovernanceChildEntries.docs);
    assert.ok(validateSourceGovernanceChildExecution(current, missing, sourceGovernanceChildEntries.frontend).some(error => error.includes('omits child')));
    const borrowed = structuredClone(authority);
    borrowed.targets[0].owners = ['frontend-static-governance'];
    assert.ok(validateSourceGovernanceChildExecution(current, borrowed, sourceGovernanceChildEntries.frontend).some(error => error.includes('sole current owner')));
    put(dependency, 'export const immutableInput = 2;\n');
    const dirty = inspectReleaseFinalCommandTarget({ repositoryRoot: root, target: sourceGovernanceChildEntries.frontend, additionalTargets: sourceGovernanceDataInputs });
    assert.ok(dirty.errors.some(error => error.includes('repository index')));
    assert.notEqual(validateSourceGovernanceChildExecution(dirty, authority, sourceGovernanceChildEntries.frontend).length, 0);
    git('add', dependency);
    const drifted = inspectReleaseFinalCommandTarget({ repositoryRoot: root, target: sourceGovernanceChildEntries.frontend, additionalTargets: sourceGovernanceDataInputs });
    assert.deepEqual(drifted.errors, []);
    assert.ok(validateSourceGovernanceChildExecution(drifted, authority, sourceGovernanceChildEntries.frontend).some(error => error.includes('source/index closure drifted')));
});
