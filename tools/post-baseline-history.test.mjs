import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { maskCSharpTrivia } from './test/csharp-source-mask.mjs';
import {
    POST_BASELINE_BEFORE_ANCHOR,
    POST_BASELINE_HISTORY_ANCHOR,
    historicalMethodMayBePresent,
    historicalXunitMethodPresent,
    validatePostBaselineHistory
} from './test-convergence/post-baseline-history.mjs';
import { parseMatrix } from './test-matrix/parse-matrix.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validateHistory = (options) => validatePostBaselineHistory({ ...options, parseMatrix, maskCSharpTrivia });
const historicalXunitMethodPresentWithMask = (source, className, methodName) =>
    historicalXunitMethodPresent(source, className, methodName, maskCSharpTrivia);

test('post-baseline history refuses missing owner capabilities', () =>
{
    const result = validatePostBaselineHistory({ root, paths: [], replacements: [] });
    assert.deepEqual(result.errors, ['post-baseline history capabilities are missing']);
    assert.throws(
        () => historicalXunitMethodPresent('public class OldTests {}', 'OldTests', 'Removed'),
        /C# source mask capability is required/u
    );
});

test('new post-baseline retirement is bound to the trusted exact Git transition', () =>
{
    const ledger = JSON.parse(readFileSync(resolve(root, 'tests/test-retention-replacements.json'), 'utf8'));
    const newPath = 'tests/retention-postbaseline-history-baseline.json';
    const oldPath = 'tests/backend/Unit/BlacklistServiceTests.cs';
    const oldId = `xunit:${oldPath}#BlacklistServiceTests.BanUserAsync_PersistsBannedStatusAndCachesNormalizedReason`;
    const sourceCommit = 'd6d079b71a59b5ea1379a07857d71d947ce2e171';
    const deletionCommit = 'b5f77fc4030258cfe93ac227dcb494e74c1ff971';
    assert.match(POST_BASELINE_BEFORE_ANCHOR, /^[0-9a-f]{40}$/u);
    const valid = {
        schema: 'fsusblog.issue-acceptance-baseline.v2',
        sourceCommit,
        deletionCommit,
        issue: 3543,
        expectedRecords: 1,
        expectedMigrated: 1,
        records: [{
            id: oldId,
            path: oldPath,
            disposition: 'migrated',
            sourceBlobOid: 'c3dcdabb4ea23b732f89a908ebc08911369c2462',
            resultBlobOid: null
        }]
    };
    // Keep this synthetic candidate separate from later admitted v2 snapshots.
    const trustedMatrix = parseMatrix(execFileSync('git', [
        'show', `${POST_BASELINE_HISTORY_ANCHOR}:tests/matrix.yml`
    ], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } }));
    const legacyPaths = trustedMatrix.governance.retention.postBaselines;
    const validate = (snapshot, { paths = [...legacyPaths, newPath], readCurrent, beforeCommit } = {}) =>
        validateHistory({
            root,
            paths,
            beforeCommit,
            replacements: [
                ...ledger.deletedTests,
                ...snapshot.records.map((record) => ({ id: record.id, path: record.path }))
            ],
            readCurrent: readCurrent ?? ((path) => path === newPath
                ? JSON.stringify(snapshot)
                : readFileSync(resolve(root, path), 'utf8'))
        });

    const accepted = validate(valid);
    assert.deepEqual(accepted.errors, []);
    assert.ok(accepted.ids.includes(oldId));
    assert.equal(accepted.sources.length, legacyPaths.length + 1);

    const refusalCases = [
        ['v1 self-admission', { ...valid, schema: 'fsusblog.issue-acceptance-baseline.v1' }, /requires exact-history v2 schema/u],
        ['abbreviated source', { ...valid, sourceCommit: sourceCommit.slice(0, 8) }, /full Git object IDs/u],
        ['wrong parent', { ...valid, sourceCommit: deletionCommit }, /sole immediate parent/u],
        ['wrong source blob', { ...valid, records: [{ ...valid.records[0], sourceBlobOid: '0'.repeat(40) }] }, /source blob binding differs/u],
        ['wrong result blob', { ...valid, records: [{ ...valid.records[0], resultBlobOid: '0'.repeat(40) }] }, /deletion-result blob binding differs/u],
        ['forged old method', { ...valid, records: [{ ...valid.records[0], id: `xunit:${oldPath}#BlacklistServiceTests.NotARealTest` }] }, /old attributed method is absent/u],
        ['wrong owner path', { ...valid, records: [{ ...valid.records[0], path: 'tests/backend/Unit/OtherTests.cs' }] }, /exact legacy xUnit method and owner path/u],
        ['wrong count', { ...valid, expectedMigrated: 2 }, /expected counts must equal/u],
        ['duplicate record', { ...valid, expectedRecords: 2, expectedMigrated: 2, records: [valid.records[0], valid.records[0]] }, /duplicate post-baseline migrated ID/u]
    ];
    for (const [name, snapshot, refusal] of refusalCases)
    {
        assert.ok(validate(snapshot).errors.some((error) => refusal.test(error)), name);
    }

    const survivingPath = 'tests/backend/Unit/AdminSessionValidationServiceTests.cs';
    const surviving = {
        ...valid,
        records: [{
            id: `xunit:${survivingPath}#AdminSessionValidationServiceTests.ValidateAsync_UsesOnlyReadyLocalProjection_AndFailsClosedForUnknown`,
            path: survivingPath,
            disposition: 'migrated',
            sourceBlobOid: 'f98b2c21d985771c4fa35d2bc65264a3e407fd6a',
            resultBlobOid: 'ad083fe195976b32e5c752ed73688f60a155b1f2'
        }]
    };
    assert.ok(validate(surviving).errors.some((error) => /survives deletion commit/u.test(error)));
    assert.ok(validate(valid, { beforeCommit: POST_BASELINE_HISTORY_ANCHOR }).errors
        .some((error) => /source commit predates trusted before snapshot/u.test(error)));
    assert.ok(validate(valid, { paths: [newPath] }).errors.some((error) => /trusted post-baseline path removed/u.test(error)));
    const tamperedLegacy = (path) => path === legacyPaths[0]
        ? '{}'
        : path === newPath ? JSON.stringify(valid) : readFileSync(resolve(root, path), 'utf8');
    assert.ok(validate(valid, { readCurrent: tamperedLegacy }).errors.some((error) => /trusted v1 post-baseline bytes changed/u.test(error)));
});

test('historical xUnit identity rejects conditional code, comments, missing attributes and another class owner', () =>
{
    const legitimate = 'public class OldTests\n{\n    [Fact]\n    public void Removed() {}\n}';
    assert.equal(historicalXunitMethodPresentWithMask(legitimate, 'OldTests', 'Removed'), true);
    assert.equal(historicalXunitMethodPresentWithMask('public class OldTests\n{\n#if false\n    [Fact]\n    public void Removed() {}\n#endif\n}', 'OldTests', 'Removed'), false);
    assert.equal(historicalXunitMethodPresentWithMask('public class OldTests\n{\n#if FEATURE\n    [Fact]\n    public void Removed() {}\n#endif\n}', 'OldTests', 'Removed'), false);
    assert.equal(historicalXunitMethodPresentWithMask('#if false\npublic class OldTests {\n#endif\n    [Fact]\n    public void Removed() {}\n}', 'OldTests', 'Removed'), false);
    assert.equal(historicalXunitMethodPresentWithMask('public class OldTests\n{\n#if false\n    public void Helper() {}\n#endif\n    [Fact]\n    public void Removed() {}\n}', 'OldTests', 'Removed'), true);
    assert.equal(historicalXunitMethodPresentWithMask('// public class OldTests\n// [Fact]\n// public void Removed() {}', 'OldTests', 'Removed'), false);
    assert.equal(historicalXunitMethodPresentWithMask('/*\npublic class OldTests\n{\n    [Fact]\n    public void Removed() {}\n}\n*/', 'OldTests', 'Removed'), false);
    assert.equal(historicalXunitMethodPresentWithMask('public class OldTests\n{\n    public void Removed() {}\n}', 'OldTests', 'Removed'), false);
    assert.equal(historicalXunitMethodPresentWithMask('public class OldTests\n{}\npublic class OtherTests\n{\n    [Fact]\n    public void Removed() {}\n}', 'OldTests', 'Removed'), false);
    assert.equal(historicalXunitMethodPresentWithMask('public class OldTests\n{}\n[Fact]\npublic void Removed() {}', 'OldTests', 'Removed'), false);
    assert.equal(historicalXunitMethodPresentWithMask('public class OldTests\n{\n    class NestedTests\n    {\n        [Fact]\n        public void Removed() {}\n    }\n}', 'OldTests', 'Removed'), false);
});

test('post-baseline history ignores local Git replacement objects', () =>
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-postbaseline-replace-'));
    const runGit = (args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
    const oldPath = 'tests/backend/Unit/OldTests.cs';
    const oldId = `xunit:${oldPath}#OldTests.Removed`;
    try
    {
        runGit(['init', '--quiet']);
        runGit(['config', 'user.name', 'History Test']);
        runGit(['config', 'user.email', 'history-test@example.invalid']);
        mkdirSync(resolve(repository, 'tests/backend/Unit'), { recursive: true });
        writeFileSync(resolve(repository, 'tests/matrix.yml'), 'governance:\n  retention:\n    postBaselines: []\n');
        writeFileSync(resolve(repository, oldPath), 'public class OldTests {}\n');
        runGit(['add', '.']);
        runGit(['commit', '--quiet', '-m', 'source without a test']);
        const sourceCommit = runGit(['rev-parse', 'HEAD']);
        rmSync(resolve(repository, oldPath));
        runGit(['add', '-u']);
        runGit(['commit', '--quiet', '-m', 'delete source file']);
        const deletionCommit = runGit(['rev-parse', 'HEAD']);
        runGit(['switch', '--quiet', '--orphan', 'forged-source']);
        writeFileSync(resolve(repository, 'tests/matrix.yml'), 'governance:\n  retention:\n    postBaselines: []\n');
        writeFileSync(resolve(repository, oldPath), 'public class OldTests\n{\n  [Fact]\n  public void Removed() {}\n}\n');
        runGit(['add', '.']);
        runGit(['commit', '--quiet', '-m', 'forged source']);
        const forgedCommit = runGit(['rev-parse', 'HEAD']);
        const forgedBlob = runGit(['rev-parse', `${forgedCommit}:${oldPath}`]);
        runGit(['replace', sourceCommit, forgedCommit]);
        const baseline = {
            schema: 'fsusblog.issue-acceptance-baseline.v2',
            sourceCommit,
            deletionCommit,
            expectedRecords: 1,
            expectedMigrated: 1,
            records: [{ id: oldId, path: oldPath, disposition: 'migrated', sourceBlobOid: forgedBlob, resultBlobOid: null }]
        };
        const result = validateHistory({
            root: repository,
            paths: ['tests/forged-baseline.json'],
            replacements: [{ id: oldId, path: oldPath }],
            anchorCommit: deletionCommit,
            beforeCommit: sourceCommit,
            readCurrent: () => JSON.stringify(baseline)
        });
        assert.ok(result.errors.some((error) => /old attributed method is absent from source commit/u.test(error)));
    }
    finally
    {
        rmSync(repository, { recursive: true, force: true });
    }
});

test('post-baseline history rejects non-regular historical xUnit paths', () =>
{
    for (const nonRegularSide of ['source', 'deletion'])
    {
        const repository = mkdtempSync(join(tmpdir(), 'fsusblog-postbaseline-mode-'));
        const runGit = (args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
        const oldPath = 'tests/backend/Unit/OldTests.cs';
        const oldId = `xunit:${oldPath}#OldTests.Removed`;
        const putSymlink = (target) =>
        {
            const oid = execFileSync('git', ['-C', repository, 'hash-object', '-w', '--stdin'], {
                input: target,
                encoding: 'utf8'
            }).trim();
            runGit(['update-index', '--add', '--cacheinfo', `120000,${oid},${oldPath}`]);
            return oid;
        };
        try
        {
            runGit(['init', '--quiet']);
            runGit(['config', 'user.name', 'History Test']);
            runGit(['config', 'user.email', 'history-test@example.invalid']);
            mkdirSync(resolve(repository, 'tests/backend/Unit'), { recursive: true });
            writeFileSync(resolve(repository, 'tests/matrix.yml'), 'governance:\n  retention:\n    postBaselines: []\n');
            runGit(['add', 'tests/matrix.yml']);
            if (nonRegularSide === 'source')
            {
                putSymlink('public class OldTests\n{\n  [Fact]\n  public void Removed() {}\n}\n');
            }
            else
            {
                writeFileSync(resolve(repository, oldPath), 'public class OldTests\n{\n  [Fact]\n  public void Removed() {}\n}\n');
                runGit(['add', oldPath]);
            }
            runGit(['commit', '--quiet', '-m', 'source with attributed method']);
            const sourceCommit = runGit(['rev-parse', 'HEAD']);
            const sourceBlobOid = runGit(['rev-parse', `${sourceCommit}:${oldPath}`]);
            if (nonRegularSide === 'source')
            {
                runGit(['update-index', '--force-remove', oldPath]);
            }
            else
            {
                putSymlink('not a C# test');
            }
            runGit(['commit', '--quiet', '-m', 'delete attributed method']);
            const deletionCommit = runGit(['rev-parse', 'HEAD']);
            const resultBlobOid = nonRegularSide === 'source' ? null : runGit(['rev-parse', `${deletionCommit}:${oldPath}`]);
            const baseline = {
                schema: 'fsusblog.issue-acceptance-baseline.v2',
                sourceCommit,
                deletionCommit,
                expectedRecords: 1,
                expectedMigrated: 1,
                records: [{ id: oldId, path: oldPath, disposition: 'migrated', sourceBlobOid, resultBlobOid }]
            };
            const result = validateHistory({
                root: repository,
                paths: ['tests/non-regular-baseline.json'],
                replacements: [{ id: oldId, path: oldPath }],
                anchorCommit: deletionCommit,
                beforeCommit: sourceCommit,
                readCurrent: () => JSON.stringify(baseline)
            });
            assert.ok(result.errors.some((error) => /non-regular historical Git blob/u.test(error)), nonRegularSide);
        }
        finally
        {
            rmSync(repository, { recursive: true, force: true });
        }
    }
});

function createGraftHistoryFixture()
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-postbaseline-graft-'));
    const rawEnvironment = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull };
    const runGit = (args, environment = rawEnvironment) => execFileSync('git', ['-C', repository, ...args], {
        encoding: 'utf8',
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    try
    {
        runGit(['init', '--quiet']);
        runGit(['config', 'user.name', 'History Test']);
        runGit(['config', 'user.email', 'history-test@example.invalid']);
        const oldPath = 'tests/backend/Unit/OldTests.cs';
        const oldId = `xunit:${oldPath}#OldTests.Removed`;
        mkdirSync(resolve(repository, 'tests/backend/Unit'), { recursive: true });
        writeFileSync(resolve(repository, 'tests/matrix.yml'), 'governance:\n  retention:\n    postBaselines: []\n');
        runGit(['add', '.']);
        runGit(['commit', '--quiet', '-m', 'immutable before snapshot']);
        const beforeCommit = runGit(['rev-parse', 'HEAD']);
        writeFileSync(resolve(repository, oldPath), 'public class OldTests\n{\n  [Fact]\n  public void Removed() {}\n}\n');
        runGit(['add', '.']);
        runGit(['commit', '--quiet', '-m', 'attributed historical source']);
        const sourceCommit = runGit(['rev-parse', 'HEAD']);
        const sourceTree = runGit(['rev-parse', 'HEAD^{tree}']);
        const sourceBlobOid = runGit(['rev-parse', `${sourceCommit}:${oldPath}`]);
        rmSync(resolve(repository, oldPath));
        runGit(['add', '-u']);
        runGit(['commit', '--quiet', '-m', 'exact historical deletion']);
        const deletionCommit = runGit(['rev-parse', 'HEAD']);
        const deletionTree = runGit(['rev-parse', 'HEAD^{tree}']);
        const anchorCommit = runGit(['commit-tree', deletionTree, '-p', deletionCommit, '-m', 'trusted anchor']);
        const foreignDeletion = runGit(['commit-tree', deletionTree, '-p', sourceCommit, '-m', 'unrelated deletion']);
        const foreignSource = runGit(['commit-tree', sourceTree, '-p', beforeCommit, '-m', 'different source object']);
        const baseline = {
            schema: 'fsusblog.issue-acceptance-baseline.v2',
            sourceCommit,
            deletionCommit,
            expectedRecords: 1,
            expectedMigrated: 1,
            records: [{ id: oldId, path: oldPath, disposition: 'migrated', sourceBlobOid, resultBlobOid: null }]
        };
        const validate = (snapshot) => validateHistory({
            root: repository,
            paths: ['tests/grafted-baseline.json'],
            replacements: [{ id: oldId, path: oldPath }],
            anchorCommit,
            beforeCommit,
            readCurrent: () => JSON.stringify(snapshot)
        });
        return { repository, runGit, baseline, validate, anchorCommit, foreignDeletion, foreignSource };
    }
    catch (error)
    {
        rmSync(repository, { recursive: true, force: true });
        throw error;
    }
}

for (const graftInput of ['repository-local', 'ambient'])
{
    test(`post-baseline history refuses ${graftInput} grafts that forge immutable ancestry`, () =>
    {
        const fixture = createGraftHistoryFixture();
        const { repository, runGit, baseline, validate, anchorCommit, foreignDeletion, foreignSource } = fixture;
        const previousGraftFile = process.env.GIT_GRAFT_FILE;
        try
        {
            delete process.env.GIT_GRAFT_FILE;
            assert.deepEqual(validate(baseline).errors, [], 'real immutable history remains accepted');
            const graftFile = graftInput === 'repository-local'
                ? resolve(repository, '.git/info/grafts')
                : resolve(repository, 'ambient-grafts');
            if (graftInput === 'ambient') process.env.GIT_GRAFT_FILE = graftFile;
            const graftEnvironment = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
            const unrelated = { ...baseline, deletionCommit: foreignDeletion };
            assert.ok(validate(unrelated).errors.some((error) => /not in trusted master history/u.test(error)));
            writeFileSync(graftFile, `${anchorCommit} ${foreignDeletion}\n`);
            assert.equal(runGit(['merge-base', '--is-ancestor', foreignDeletion, anchorCommit], graftEnvironment), '',
                'native Git actually sees the forged ancestor with replacement objects disabled');
            assert.ok(validate(unrelated).errors.some((error) => /not in trusted master history/u.test(error)),
                'history owner must ignore the graft rather than accept an unrelated deletion');

            const wrongParent = { ...baseline, sourceCommit: foreignSource };
            writeFileSync(graftFile, `${baseline.deletionCommit} ${foreignSource}\n`);
            assert.equal(runGit(['rev-list', '--parents', '-n', '1', baseline.deletionCommit], graftEnvironment),
                `${baseline.deletionCommit} ${foreignSource}`, 'native Git actually sees the grafted sole parent');
            const rawCommit = runGit(['cat-file', '-p', baseline.deletionCommit]);
            assert.ok(rawCommit.includes(`\nparent ${baseline.sourceCommit}\n`), 'stored commit parent is unchanged');
            assert.ok(validate(wrongParent).errors.some((error) => /sole immediate parent/u.test(error)),
                'history owner must bind the stored parent, not the grafted parent');
            assert.deepEqual(validate(baseline).errors, [], 'valid history stays accepted with hostile graft input');
        }
        finally
        {
            if (previousGraftFile === undefined) delete process.env.GIT_GRAFT_FILE;
            else process.env.GIT_GRAFT_FILE = previousGraftFile;
            rmSync(repository, { recursive: true, force: true });
        }
    });
}

test('historical xUnit source recognizes contiguous attribute lists without guessing aliased identity', () =>
{
    const method = (attributes) => `public class OldTests\n{\n${attributes}\npublic void Removed() {}\n}`;
    for (const attributes of [
        '[Fact]\n[Trait("Category", "governance")]',
        '[Theory]\n[InlineData(1)]',
        '[Xunit.Fact]',
        '[global::Xunit.FactAttribute]',
        '[Fact, Trait("Category", "governance")]',
        '[Other.TheoryAttribute(Timeout = 1)]\n[InlineData(1)]'
    ])
    {
        assert.equal(historicalXunitMethodPresentWithMask(method(attributes), 'OldTests', 'Removed'), true, attributes);
    }
    for (const source of [
        'using Fact = DifferentAttribute;\npublic class DifferentAttribute : System.Attribute {}\n' + method('[Fact]'),
        'using F\\u0061ct = DifferentAttribute;\n' + method('[Fact]'),
        'using Xunit = DifferentNamespace;\n' + method('[Xunit.Fact]'),
        'public class Fact : System.Attribute {}\n' + method('[Fact]')
    ])
    {
        assert.equal(historicalXunitMethodPresentWithMask(source, 'OldTests', 'Removed'), false, source);
    }
    assert.equal(historicalXunitMethodPresentWithMask(
        'public class FactAttribute : System.Attribute {}\n' + method('[Fact]'), 'OldTests', 'Removed'), true,
    'original inventory accepts resolved simple FactAttribute names, not only the Xunit namespace');
});

test('real immutable result and anchor history refuse live methods with different or unknown syntax', () =>
{
    const forms = [
        '[Fact]\n[Trait("Category", "governance")]\npublic void Removed() {}',
        '[Theory]\n[InlineData(1)]\npublic void Removed(int value) {}',
        '[Xunit.Fact]\npublic void Removed() {}',
        '#if true\n[Fact]\npublic void Removed() {}\n#endif',
        '#if FEATURE\n[Fact]\npublic void Removed() {}\n#endif',
        '[UnknownAttribute]\npublic void Removed() {}',
        '[Fact]\npublic\nTask Removed() => null;'
    ];
    for (const location of ['result', 'anchor'])
    {
        for (const form of forms)
        {
            const { repository, runGit, baseline, validate } = createGraftHistoryFixture();
            try
            {
                assert.deepEqual(validate(baseline).errors, []);
                const oldPath = baseline.records[0].path;
                writeFileSync(resolve(repository, oldPath), `public class OldTests\n{\n${form}\n}\n`);
                runGit(['add', oldPath]);
                const liveTree = runGit(['write-tree']);
                const liveBlob = runGit(['rev-parse', `:${oldPath}`]);
                const emptyTree = runGit(['rev-parse', `${baseline.deletionCommit}^{tree}`]);
                const deletionCommit = location === 'result'
                    ? runGit(['commit-tree', liveTree, '-p', baseline.sourceCommit, '-m', 'still-live result'])
                    : baseline.deletionCommit;
                const anchorCommit = runGit(['commit-tree', location === 'anchor' ? liveTree : emptyTree,
                    '-p', deletionCommit, '-m', 'immutable anchor']);
                const snapshot = { ...baseline, deletionCommit,
                    records: [{ ...baseline.records[0], resultBlobOid: location === 'result' ? liveBlob : null }] };
                const result = validateHistory({
                    root: repository, paths: ['tests/still-live-baseline.json'],
                    replacements: [{ id: baseline.records[0].id, path: oldPath }],
                    anchorCommit, beforeCommit: runGit(['rev-parse', `${baseline.sourceCommit}^`]),
                    readCurrent: () => JSON.stringify(snapshot)
                });
                const refusal = location === 'result' ? /survives deletion commit/u : /survives trusted master anchor/u;
                assert.ok(result.errors.some((error) => refusal.test(error)), `${location}: ${form}`);
            }
            finally
            {
                rmSync(repository, { recursive: true, force: true });
            }
        }
    }
});

test('real immutable source history refuses local and global Fact aliases for a different attribute', () =>
{
    for (const globalAlias of [false, true])
    {
        const { repository, runGit, baseline } = createGraftHistoryFixture();
        try
        {
            const oldPath = baseline.records[0].path;
            if (globalAlias)
            {
                writeFileSync(resolve(repository, 'tests/backend/GlobalUsings.cs'), 'global\nusing Fact = DifferentAttribute;\n');
                runGit(['add', 'tests/backend/GlobalUsings.cs']);
            }
            writeFileSync(resolve(repository, oldPath),
                (globalAlias ? '' : 'using Fact = DifferentAttribute;\n')
                + 'public class DifferentAttribute : System.Attribute {}\n'
                + 'public class OldTests\n{\n[Fact]\npublic void Removed() {}\n}\n');
            runGit(['add', oldPath]);
            const sourceTree = runGit(['write-tree']);
            const sourceBlobOid = runGit(['rev-parse', `:${oldPath}`]);
            const beforeCommit = runGit(['rev-parse', `${baseline.sourceCommit}^`]);
            const sourceCommit = runGit(['commit-tree', sourceTree, '-p', beforeCommit, '-m', 'aliased non-test source']);
            const emptyTree = runGit(['rev-parse', `${baseline.deletionCommit}^{tree}`]);
            const deletionCommit = runGit(['commit-tree', emptyTree, '-p', sourceCommit, '-m', 'delete non-test']);
            const anchorCommit = runGit(['commit-tree', emptyTree, '-p', deletionCommit, '-m', 'immutable anchor']);
            const result = validateHistory({
                root: repository, paths: ['tests/alias-baseline.json'],
                replacements: [{ id: baseline.records[0].id, path: oldPath }],
                anchorCommit, beforeCommit,
                readCurrent: () => JSON.stringify({ ...baseline, sourceCommit, deletionCommit,
                    records: [{ ...baseline.records[0], sourceBlobOid }] })
            });
            assert.ok(result.errors.some((error) => /old attributed method is absent from source commit/u.test(error)));
        }
        finally
        {
            rmSync(repository, { recursive: true, force: true });
        }
    }
});

test('real immutable source refuses cross-file Fact and Theory type shadows but retains Attribute identities', () =>
{
    for (const [attribute, declaredName, accepted] of [
        ['DifferentNamespace.Fact', 'Fact', false],
        ['global::DifferentNamespace.Fact', 'Fact', false],
        ['DifferentNamespace.Theory', 'Theory', false],
        ['DifferentNamespace.Fact', 'F\\u0061ct', false],
        ['DifferentNamespace.Fact', 'FactAttribute', true],
        ['DifferentNamespace.TheoryAttribute', 'TheoryAttribute', true]
    ])
    {
        const { repository, runGit, baseline } = createGraftHistoryFixture();
        try
        {
            const oldPath = baseline.records[0].path;
            const declarationPath = 'tests/backend/Unit/SeparateAttribute.cs';
            writeFileSync(resolve(repository, declarationPath),
                `namespace DifferentNamespace\n{\npublic sealed class ${declaredName} : System.Attribute {}\n}\n`);
            writeFileSync(resolve(repository, oldPath),
                `namespace Consumer\n{\npublic class OldTests\n{\n[${attribute}]\npublic void Removed() {}\n}\n}\n`);
            runGit(['add', oldPath, declarationPath]);
            const sourceTree = runGit(['write-tree']);
            const sourceBlobOid = runGit(['rev-parse', `:${oldPath}`]);
            const beforeCommit = runGit(['rev-parse', `${baseline.sourceCommit}^`]);
            const sourceCommit = runGit(['commit-tree', sourceTree, '-p', beforeCommit, '-m', 'cross-file attribute identity']);
            const emptyTree = runGit(['rev-parse', `${baseline.deletionCommit}^{tree}`]);
            const deletionCommit = runGit(['commit-tree', emptyTree, '-p', sourceCommit, '-m', 'delete historical member']);
            const anchorCommit = runGit(['commit-tree', emptyTree, '-p', deletionCommit, '-m', 'immutable anchor']);
            const result = validateHistory({
                root: repository, paths: ['tests/type-shadow-baseline.json'],
                replacements: [{ id: baseline.records[0].id, path: oldPath }],
                anchorCommit, beforeCommit,
                readCurrent: () => JSON.stringify({ ...baseline, sourceCommit, deletionCommit,
                    records: [{ ...baseline.records[0], sourceBlobOid }] })
            });
            if (accepted) assert.deepEqual(result.errors, [], attribute);
            else assert.ok(result.errors.some((error) => /old attributed method is absent from source commit/u.test(error)), attribute);
        }
        finally
        {
            rmSync(repository, { recursive: true, force: true });
        }
    }
});

test('deletion evidence is independent of test attribution and refuses unresolved identifiers', () =>
{
    const mayBePresent = (source) => historicalMethodMayBePresent(source, 'OldTests', 'Removed', maskCSharpTrivia);
    assert.equal(mayBePresent(undefined), false);
    assert.equal(mayBePresent('public class OtherTests { public void Removed() {} }'), false);
    assert.equal(mayBePresent('public class OldTests { string value = "Removed()"; /* Removed() */ }'), false);
    assert.equal(mayBePresent('public class OldTests { class NestedTests { public void Removed() {} } }'), false);
    assert.equal(mayBePresent('public class OldTests { [Unknown] public void Removed() {} }'), true);
    assert.equal(mayBePresent('public class OldTests { public Task Removed<T>() => null; }'), true);
    assert.equal(mayBePresent('public class @OldTests { public void @Removed() {} }'), true);
    assert.equal(mayBePresent('public class OldTests { public void R\\u0065moved() {} }'), true);
    assert.equal(mayBePresent('public class Old\\u0054ests { public void Removed() {} }'), true);
    assert.equal(mayBePresent('public class OldTests { public void Removed() {}'), true);
    assert.equal(mayBePresent('public class OldTests {\n#if FEATURE\n}\npublic class OtherTests {\n#else\n'
        + '[Fact] public void Removed() {}\n}\n#endif'), true);
    assert.throws(() => historicalMethodMayBePresent('', 'OldTests', 'Removed'), /C# source mask capability/u);
});
