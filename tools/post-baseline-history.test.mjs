import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { maskCSharpTrivia } from './test/csharp-source-mask.mjs';
import {
    POST_BASELINE_BEFORE_ANCHOR,
    POST_BASELINE_HISTORY_ANCHOR,
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
