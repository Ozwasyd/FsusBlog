import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { contentDigest } from '../../tools/test-quality/schema.mjs';
import {
    applyReplacementTransaction,
    createReplacementTransaction,
    detectReplacementRequiredChanges,
    validateReplacementReceipt,
    validateReplacementTransaction,
    verifyDiffHasTransaction
} from '../../tools/test-replacement/transaction.mjs';

const hash = (value) => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;

function inventory(cases, marker)
{
    return {
        inventoryDigest: hash(`inventory:${marker}`),
        sourceState: { commit: marker.repeat(40).slice(0, 40), worktreeFingerprint: marker.repeat(64).slice(0, 64) },
        sourceFiles: [...new Set(cases.map((item) => item.path))].map((sourcePath) => ({
            path: sourcePath,
            sourceDigest: hash(`${marker}:${sourcePath}`)
        })),
        testCases: cases.map((item) => ({
            id: item.id,
            ownerFile: item.path,
            adapter: item.framework ?? 'xunit',
            identity: item.identity ?? 'static',
            platform: item.platform ?? 'linux',
            fixture: item.fixture ?? 'postgres'
        }))
    };
}

function retention(cases)
{
    return {
        testRecords: cases.map((item) => ({
            id: item.id,
            runtimeBoundary: item.runtimeBoundary ?? 'dotnet:integration',
            productionSymbols: item.productionSymbols ?? ['ArticleService.Read'],
            assertionTargets: item.assertionTargets ?? ['http:status:equal:200'],
            requirementIds: item.requirementIds ?? ['REQ-ARTICLE'],
            coverageIds: item.coverageIds ?? ['article-read'],
            tierIds: item.tierIds ?? ['backend-integration'],
            evidencePaths: item.evidencePaths ?? ['.tmp/article-read.json'],
            qualityOutcome: item.qualityOutcome ?? 'passed',
            retentionClass: item.retentionClass ?? 'must-keep'
        }))
    };
}

function mapping(beforeTestId, afterTestIds, disposition = afterTestIds.length > 1 ? 'shared-replacement' : 'replacement')
{
    const project = (before) => [{ before, after: disposition === 'retired' ? [] : [before] }];
    return {
        beforeTestId,
        afterTestIds,
        disposition,
        assertionMappings: project('http:status:equal:200'),
        requirementMappings: project('REQ-ARTICLE'),
        coverageMappings: project('article-read'),
        tierMappings: project('backend-integration'),
        evidenceMappings: project('.tmp/article-read.json')
    };
}

function quality(cases)
{
    return { cases: cases.map((item) => ({ testId: item.id, outcome: item.qualityOutcome ?? 'passed' })) };
}

function change(sourcePath, beforeContent, afterContent, kind = 'source', afterExists = true)
{
    return {
        path: sourcePath,
        beforeExists: beforeContent !== null,
        beforeDigest: hash(beforeContent ?? ''),
        afterExists,
        afterDigest: hash(afterContent),
        afterContent,
        kind
    };
}

function catalogChanges(mappings)
{
    const ledger = `${JSON.stringify({
        deletedTests: mappings.map((mapping) => ({
            id: mapping.beforeTestId,
            replacementTestIds: mapping.afterTestIds
        }))
    }, null, 2)}\n`;
    return [
        change('tests/test-retention-replacements.json', '{}\n', ledger, 'catalog'),
        change('tests/backend/Fixtures/backend-test-requirements.json', '{}\n', '{"updated":true}\n', 'catalog'),
        change('tests/coverage-registry.json', '{}\n', '{"updated":true}\n', 'catalog'),
        change('tests/matrix.yml', 'tiers: []\n', 'tiers:\n  - updated\n', 'catalog'),
        change('docs/generated/testing.md', 'old\n', 'new\n', 'generated-doc')
    ];
}

function plan({
    operation = 'rename',
    beforeCases = [{ id: 'old', path: 'tests/OldTests.cs' }],
    afterCases = [{ id: 'new', path: 'tests/NewTests.cs' }],
    mappings = null,
    sourceChanges = null
} = {})
{
    const resolvedMappings = mappings ?? beforeCases.map((before) => mapping(
        before.id,
        afterCases.map((after) => after.id)
    ));
    const oldPaths = new Set(beforeCases.map((item) => item.path));
    const newPaths = new Set(afterCases.map((item) => item.path));
    const resolvedSourceChanges = sourceChanges ?? [
        ...[...oldPaths].map((sourcePath) => change(
            sourcePath,
            `before:${sourcePath}\n`,
            newPaths.has(sourcePath) ? `after:${sourcePath}\n` : '',
            'source',
            newPaths.has(sourcePath)
        )),
        ...[...newPaths].filter((sourcePath) => !oldPaths.has(sourcePath)).map((sourcePath) => change(
            sourcePath,
            null,
            `after:${sourcePath}\n`
        ))
    ];
    const beforeInventory = inventory(beforeCases, 'a');
    const afterInventory = inventory(afterCases, 'b');
    return createReplacementTransaction({
        request: {
            transactionId: `tx-${operation}`,
            operation,
            owner: 'test-governance',
            reason: 'fixture replacement',
            issue: '#2626',
            beforeTestIds: beforeCases.map((item) => item.id),
            afterTestIds: afterCases.map((item) => item.id),
            mappings: resolvedMappings,
            changes: [...resolvedSourceChanges, ...catalogChanges(resolvedMappings)]
        },
        beforeInventory,
        afterInventory,
        beforeRetention: retention(beforeCases),
        afterRetention: retention(afterCases),
        afterQuality: quality(afterCases)
    });
}

test('rename transaction seals exact identities, compatibility and catalog closure', () =>
{
    const transaction = plan();
    assert.equal(validateReplacementTransaction(transaction), transaction);
    assert.equal(transaction.before[0].testId, 'old');
    assert.equal(transaction.after[0].qualityOutcome, 'passed');
    assert.match(transaction.contentDigest, /^sha256:[0-9a-f]{64}$/u);
});

test('rename transaction accepts complete explicit mappings for all five renamed dimensions', () =>
{
    const renamed = mapping('old', ['new']);
    renamed.assertionMappings = [{ before: 'http:status:equal:200', after: ['http:status:equal:201'] }];
    renamed.requirementMappings = [{ before: 'REQ-ARTICLE', after: ['REQ-ARTICLE-V2'] }];
    renamed.coverageMappings = [{ before: 'article-read', after: ['article-read-v2'] }];
    renamed.tierMappings = [{ before: 'backend-integration', after: ['backend-contract'] }];
    renamed.evidenceMappings = [{ before: '.tmp/article-read.json', after: ['.tmp/article-read-v2.json'] }];
    const transaction = plan({
        afterCases: [{
            id: 'new',
            path: 'tests/NewTests.cs',
            assertionTargets: ['http:status:equal:201'],
            requirementIds: ['REQ-ARTICLE-V2'],
            coverageIds: ['article-read-v2'],
            tierIds: ['backend-contract'],
            evidencePaths: ['.tmp/article-read-v2.json']
        }],
        mappings: [renamed]
    });

    assert.equal(validateReplacementTransaction(transaction), transaction);
});

test('rename transaction rejects missing assertion mappings and invalid mapped targets', () =>
{
    const missing = mapping('old', ['new']);
    missing.assertionMappings = [];
    assert.throws(
        () => plan({ mappings: [missing] }),
        /assertionMappings is duplicated or incomplete/u
    );

    const invalid = mapping('old', ['new']);
    invalid.assertionMappings = [{ before: 'http:status:equal:200', after: ['http:status:equal:201'] }];
    assert.throws(
        () => plan({ mappings: [invalid] }),
        /assertionMappings points to missing target http:status:equal:201/u
    );
});

test('merge, parameterize and split preserve every case through explicit mappings', () =>
{
    const merged = plan({
        operation: 'merge',
        beforeCases: [
            { id: 'old-a', path: 'tests/OldATests.cs' },
            { id: 'old-b', path: 'tests/OldBTests.cs' }
        ],
        afterCases: [{ id: 'merged', path: 'tests/MergedTests.cs' }]
    });
    assert.deepEqual(merged.mappings.map((item) => item.beforeTestId), ['old-a', 'old-b']);
    const parameterized = plan({
        operation: 'parameterize',
        beforeCases: [
            { id: 'old-case-a', path: 'tests/CasesTests.cs' },
            { id: 'old-case-b', path: 'tests/CasesTests.cs' }
        ],
        afterCases: [
            { id: 'theory[row:a]', path: 'tests/CasesTests.cs' },
            { id: 'theory[row:b]', path: 'tests/CasesTests.cs' }
        ],
        mappings: [
            mapping('old-case-a', ['theory[row:a]']),
            mapping('old-case-b', ['theory[row:b]'])
        ]
    });
    assert.equal(parameterized.mappings.length, 2);
    const split = plan({
        operation: 'split',
        afterCases: [
            { id: 'new-a', path: 'tests/NewATests.cs' },
            { id: 'new-b', path: 'tests/NewBTests.cs' }
        ]
    });
    assert.deepEqual(split.mappings[0].afterTestIds, ['new-a', 'new-b']);
});

test('delete requires explicit retirement and a generated empty ledger disposition', () =>
{
    const mappings = [mapping('old', [], 'retired')];
    const transaction = plan({ operation: 'delete', afterCases: [], mappings });
    assert.equal(transaction.after.length, 0);
    assert.throws(() => plan({ operation: 'delete' }), /explicitly retired/u);
});

test('planning fails closed on missing IDs, failed quality and lost compatibility dimensions', () =>
{
    assert.throws(() => plan({
        afterCases: [{ id: 'new', path: 'tests/NewTests.cs', qualityOutcome: 'failed' }]
    }), /not quality-passed/u);
    assert.throws(() => plan({
        afterCases: [{ id: 'new', path: 'tests/NewTests.cs', platform: 'windows' }]
    }), /platform-compatible/u);
    assert.throws(() => plan({
        afterCases: [{
            id: 'new',
            path: 'tests/NewTests.cs',
            productionSymbols: ['ArticleService.Write']
        }]
    }), /productionSymbols lost ArticleService.Read/u);
    assert.throws(() => plan({
        mappings: [mapping('missing', ['new'])]
    }), /duplicated or incomplete/u);
    assert.throws(() => plan({ sourceChanges: [] }), /source change is missing/u);
    const lostCoverage = mapping('old', ['new']);
    lostCoverage.coverageMappings = [];
    assert.throws(() => plan({ mappings: [lostCoverage] }), /coverageMappings is duplicated or incomplete/u);
    assert.throws(() => plan({
        afterCases: [{ id: 'old', path: 'tests/NewTests.cs' }],
        mappings: [mapping('old', ['old'])]
    }), /remains discoverable/u);
    assert.throws(() => plan({
        afterCases: [
            { id: 'new', path: 'tests/NewATests.cs' },
            { id: 'new', path: 'tests/NewBTests.cs' }
        ]
    }), /duplicate test IDs/u);
    assert.throws(() => plan({
        operation: 'parameterize',
        afterCases: [{ id: 'theory-owner', path: 'tests/NewTests.cs', identity: 'dynamic' }]
    }), /stable current case identities/u);
});

test('transaction validation rejects partial catalogs and sealed-content tampering', () =>
{
    const partial = structuredClone(plan());
    partial.changes = partial.changes.filter((item) => item.path !== 'tests/coverage-registry.json');
    partial.contentDigest = contentDigest(partial);
    assert.throws(() => validateReplacementTransaction(partial), /catalog change is missing/u);

    const tamperedDoc = structuredClone(plan());
    const generated = tamperedDoc.changes.find((item) => item.kind === 'generated-doc');
    generated.afterContent = 'manually edited\n';
    tamperedDoc.contentDigest = contentDigest(tamperedDoc);
    assert.throws(() => validateReplacementTransaction(tamperedDoc), /does not match afterDigest/u);

    const tamperedMapping = structuredClone(plan());
    tamperedMapping.mappings[0].assertionMappings = [];
    tamperedMapping.contentDigest = contentDigest(tamperedMapping);
    assert.throws(
        () => validateReplacementTransaction(tamperedMapping),
        /assertionMappings is duplicated or incomplete/u
    );
});

test('atomic apply deletes and writes as one unit and rolls everything back on verification failure', () =>
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsus-replacement-'));
    try
    {
        const transaction = plan();
        for (const item of transaction.changes)
        {
            if (!item.beforeExists)
            {
                continue;
            }
            const absolute = path.join(root, item.path);
            mkdirSync(path.dirname(absolute), { recursive: true });
            const fixtureContent = item.kind === 'source' ? `before:${item.path}\n`
                : item.path === 'tests/matrix.yml' ? 'tiers: []\n'
                    : item.kind === 'generated-doc' ? 'old\n' : '{}\n';
            writeFileSync(absolute, fixtureContent);
        }
        const receipt = applyReplacementTransaction({ root, transaction });
        assert.equal(receipt.verification, 'passed');
        assert.equal(validateReplacementReceipt(receipt, { transaction }), receipt);
        const tamperedReceipt = structuredClone(receipt);
        tamperedReceipt.verificationOutcomes.pop();
        assert.throws(() => validateReplacementReceipt(tamperedReceipt, { transaction }), /content digest/u);
        assert.equal(existsSync(path.join(root, 'tests/OldTests.cs')), false);
        assert.equal(readFileSync(path.join(root, 'tests/NewTests.cs'), 'utf8'), 'after:tests/NewTests.cs\n');
        assert.throws(() => validateReplacementTransaction(transaction, { existingReceipts: [receipt] }), /already applied/u);

        const rollbackRoot = mkdtempSync(path.join(os.tmpdir(), 'fsus-replacement-rollback-'));
        try
        {
            for (const item of transaction.changes)
            {
                if (!item.beforeExists)
                {
                    continue;
                }
                const absolute = path.join(rollbackRoot, item.path);
                mkdirSync(path.dirname(absolute), { recursive: true });
                const fixtureContent = item.kind === 'source' ? `before:${item.path}\n`
                    : item.path === 'tests/matrix.yml' ? 'tiers: []\n'
                        : item.kind === 'generated-doc' ? 'old\n' : '{}\n';
                writeFileSync(absolute, fixtureContent);
            }
            assert.throws(() => applyReplacementTransaction({
                root: rollbackRoot,
                transaction,
                verifyAfter: () => { throw new Error('verification failed'); }
            }), /verification failed/u);
            assert.equal(readFileSync(path.join(rollbackRoot, 'tests/OldTests.cs'), 'utf8'), 'before:tests/OldTests.cs\n');
            assert.equal(existsSync(path.join(rollbackRoot, 'tests/NewTests.cs')), false);
        }
        finally
        {
            rmSync(rollbackRoot, { recursive: true, force: true });
        }
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
});

function receiptFixture(run)
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsus-replacement-receipt-'));
    const transaction = plan({ afterCases: [{ id: 'new', path: 'tests/OldTests.cs' }] });
    assert.equal(transaction.changes.length, 6);
    for (const item of transaction.changes)
    {
        const absolute = path.join(root, item.path);
        mkdirSync(path.dirname(absolute), { recursive: true });
        const bytes = item.kind === 'source' ? `before:${item.path}\n`
            : item.path === 'tests/matrix.yml' ? 'tiers: []\n'
                : item.kind === 'generated-doc' ? 'old\n' : '{}\n';
        writeFileSync(absolute, bytes);
    }
    const receiptPath = path.join(root, 'receipts', 'final.json');
    mkdirSync(path.dirname(receiptPath));
    const evidencePath = path.join(root, 'receipts', 'existing-evidence.json');
    writeFileSync(evidencePath, 'existing evidence\n');
    const evidenceInode = fs.statSync(evidencePath).ino;
    try
    {
        run({ root, transaction, receiptPath });
        assert.equal(readFileSync(evidencePath, 'utf8'), 'existing evidence\n');
        assert.equal(fs.statSync(evidencePath).ino, evidenceInode);
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
}

function withFilesystemFault(operation, fault, run)
{
    const original = fs[operation];
    fs[operation] = (...args) => fault(original, ...args);
    syncBuiltinESMExports();
    try
    {
        return run();
    }
    finally
    {
        fs[operation] = original;
        syncBuiltinESMExports();
    }
}

function assertAppliedState(root, transaction, state)
{
    for (const item of transaction.changes)
    {
        const absolute = path.join(root, item.path);
        assert.equal(existsSync(absolute), item[`${state}Exists`], `${state} existence: ${item.path}`);
        assert.equal(hash(existsSync(absolute) ? readFileSync(absolute) : ''), item[`${state}Digest`], `${state} digest: ${item.path}`);
    }
}

function assertNoOwnedStaging(root)
{
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith('.replacement-transaction-')), []);
    assert.deepEqual(fs.readdirSync(path.join(root, 'receipts')).filter((name) => name.startsWith('.replacement-receipt-')), []);
}

test('receipt publication exposes a complete validated receipt only after all six files pass verification', () =>
{
    receiptFixture(({ root, transaction, receiptPath }) =>
    {
        const receipt = applyReplacementTransaction({
            root,
            transaction,
            receiptPath,
            verifyAfter: () =>
            {
                assertAppliedState(root, transaction, 'after');
                assert.equal(existsSync(receiptPath), false);
            }
        });
        assert.deepEqual(JSON.parse(readFileSync(receiptPath, 'utf8')), receipt);
        validateReplacementReceipt(receipt, { transaction });
        assertAppliedState(root, transaction, 'after');
        assertNoOwnedStaging(root);
    });
});

test('partial receipt staging write restores all six files without publishing terminal bytes', () =>
{
    receiptFixture(({ root, transaction, receiptPath }) =>
    {
        let injected = false;
        withFilesystemFault('writeFileSync', (original, file, bytes, options) =>
        {
            if (String(file).includes('.replacement-receipt-') && path.basename(file) === 'receipt.json')
            {
                injected = true;
                original(file, bytes.slice(0, 23), options);
                assert.equal(readFileSync(file, 'utf8'), bytes.slice(0, 23));
                assert.equal(existsSync(receiptPath), false);
                throw new Error('partial receipt write');
            }
            return original(file, bytes, options);
        }, () => assert.throws(() => applyReplacementTransaction({ root, transaction, receiptPath }), /partial receipt write/u));
        assert.equal(injected, true);
        assertAppliedState(root, transaction, 'before');
        assert.equal(existsSync(receiptPath), false);
        assertNoOwnedStaging(root);
    });
});

test('preexisting receipt retains its exact bytes and inode without applying any files', () =>
{
    receiptFixture(({ root, transaction, receiptPath }) =>
    {
        writeFileSync(receiptPath, 'existing terminal\n');
        const inode = fs.statSync(receiptPath).ino;
        assert.throws(() => applyReplacementTransaction({ root, transaction, receiptPath }), /receipt path already exists/u);
        assert.equal(readFileSync(receiptPath, 'utf8'), 'existing terminal\n');
        assert.equal(fs.statSync(receiptPath).ino, inode);
        assertAppliedState(root, transaction, 'before');
        assertNoOwnedStaging(root);
    });
});

test('racing receipt publication preserves the other publisher inode and rolls back all six files', () =>
{
    receiptFixture(({ root, transaction, receiptPath }) =>
    {
        let inode = null;
        withFilesystemFault('linkSync', (original, source, destination) =>
        {
            assert.equal(destination, receiptPath);
            writeFileSync(destination, 'racing terminal\n', { flag: 'wx' });
            inode = fs.statSync(destination).ino;
            return original(source, destination);
        }, () => assert.throws(() => applyReplacementTransaction({ root, transaction, receiptPath }), { code: 'EEXIST' }));
        assert.notEqual(inode, null);
        assert.equal(readFileSync(receiptPath, 'utf8'), 'racing terminal\n');
        assert.equal(fs.statSync(receiptPath).ino, inode);
        assertAppliedState(root, transaction, 'before');
        assertNoOwnedStaging(root);
    });
});

test('receipt link I/O failure leaves no final receipt and restores all six files', () =>
{
    receiptFixture(({ root, transaction, receiptPath }) =>
    {
        let injected = false;
        withFilesystemFault('linkSync', (_original, source, destination) =>
        {
            injected = true;
            validateReplacementReceipt(JSON.parse(readFileSync(source, 'utf8')), { transaction });
            assert.equal(destination, receiptPath);
            throw Object.assign(new Error('receipt link I/O failure'), { code: 'EIO' });
        }, () => assert.throws(() => applyReplacementTransaction({ root, transaction, receiptPath }), { code: 'EIO' }));
        assert.equal(injected, true);
        assertAppliedState(root, transaction, 'before');
        assert.equal(existsSync(receiptPath), false);
        assertNoOwnedStaging(root);
    });
});

test('each of six staging write and rename failures restores the complete before state', () =>
{
    for (const operation of ['writeFileSync', 'renameSync'])
    {
        for (let slot = 0; slot < 6; slot += 1)
        {
            receiptFixture(({ root, transaction, receiptPath }) =>
            {
                let seen = 0;
                let injected = false;
                withFilesystemFault(operation, (original, file, ...args) =>
                {
                    if (String(file).includes('.replacement-transaction-') && seen++ === slot)
                    {
                        injected = true;
                        // Exercise a real partial write or a completed rename, then fail.
                        if (operation === 'writeFileSync')
                        {
                            original(file, String(args[0]).slice(0, 2));
                        }
                        else
                        {
                            original(file, ...args);
                        }
                        throw new Error(`injected ${operation} slot ${slot}`);
                    }
                    return original(file, ...args);
                }, () => assert.throws(() => applyReplacementTransaction({ root, transaction, receiptPath }), /injected/u));
                assert.equal(injected, true, `${operation} slot ${slot}`);
                assertAppliedState(root, transaction, 'before');
                assert.equal(existsSync(receiptPath), false);
                assertNoOwnedStaging(root);
            });
        }
    }
});

test('post-publication cleanup failure preserves the complete receipt and all six applied files', () =>
{
    receiptFixture(({ root, transaction, receiptPath }) =>
    {
        let retainedStaging = null;
        withFilesystemFault('rmSync', (original, target, options) =>
        {
            if (path.basename(target).startsWith('.replacement-receipt-'))
            {
                retainedStaging = target;
                throw new Error('owned staging cleanup fault');
            }
            return original(target, options);
        }, () => assert.throws(() => applyReplacementTransaction({ root, transaction, receiptPath }), (error) =>
        {
            assert.match(error.message, /receipt published; applied sources retained/u);
            assert.equal(error.errors.length, 1);
            assert.match(error.errors[0].message, /owned staging cleanup fault/u);
            return true;
        }));
        validateReplacementReceipt(JSON.parse(readFileSync(receiptPath, 'utf8')), { transaction });
        assertAppliedState(root, transaction, 'after');
        assert.notEqual(retainedStaging, null);
        assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith('.replacement-transaction-')), []);
        rmSync(retainedStaging, { recursive: true });
        assertNoOwnedStaging(root);
    });
});

test('diff checker detects deleted tests, renamed tests and removed discoverable cases', () =>
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsus-replacement-git-'));
    try
    {
        execFileSync('git', ['init', '-q'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
        mkdirSync(path.join(root, 'tests'), { recursive: true });
        writeFileSync(path.join(root, 'tests', 'OldTests.cs'), '[Fact]\npublic void Old() {}\n');
        execFileSync('git', ['add', '.'], { cwd: root });
        execFileSync('git', ['commit', '-qm', 'before'], { cwd: root });
        execFileSync('git', ['mv', 'tests/OldTests.cs', 'tests/NewTests.cs'], { cwd: root });
        writeFileSync(path.join(root, 'tests', 'NewTests.cs'), 'public void Helper() {}\n');
        execFileSync('git', ['commit', '-qam', 'after'], { cwd: root });
        const changes = detectReplacementRequiredChanges({ root, base: 'HEAD^' });
        assert.ok(changes.some((item) => item.reason === 'test-source-delete-or-rename'));
        assert.ok(changes.some((item) => item.reason === 'discoverable-test-or-case-removal'));
        assert.throws(() => verifyDiffHasTransaction({ root, base: 'HEAD^' }), /unregistered test source change/u);
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
});
