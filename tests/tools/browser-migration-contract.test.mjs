import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const {
    browserTestIsolationViolations,
    expandBrowserTestMigrationManifest,
    repositoryBrowserTestIsolationViolations,
    validateBrowserTestMigration,
    validateReplacementTargets
} = await import(pathToFileURL(path.join(root, 'tools/check-browser-test-migration.mjs')).href);
const fixture = JSON.parse(readFileSync(
    path.join(root, 'tests/fixtures/browser-migration/valid-case.json'),
    'utf8'
));

function expanded(value = fixture)
{
    return expandBrowserTestMigrationManifest(value.manifest, () =>
    {
        throw new Error('the focused fixture has no imports');
    });
}

function validate(value = fixture, records = expanded(value))
{
    return validateBrowserTestMigration({
        manifest: value.manifest,
        records,
        acceptanceBaseline: value.acceptanceBaseline,
        acceptanceReplacements: value.acceptanceReplacements,
        diagnosticsMigration: value.diagnosticsMigration,
        historicalDeletedRecords: value.historicalDeletedRecords,
        currentRecords: value.currentRecords
    });
}

test('repository browser migration contract is internally consistent', () =>
{
    const result = spawnSync(process.execPath, [
        'tools/check-browser-test-migration.mjs',
        '--root', root
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('every migration replacement resolves to a current semantic owner', () =>
{
    const manifest = JSON.parse(readFileSync(
        path.join(root, 'tests/governance/browser-test-migration.json'),
        'utf8'
    ));
    const records = expandBrowserTestMigrationManifest(manifest, (relativePath) => JSON.parse(
        readFileSync(path.join(root, relativePath), 'utf8'
        )));
    assert.deepEqual(validateReplacementTargets(root, records), []);

    records[0].replacementTestIds = ['vitest:tests/frontend/unit/does-not-exist.test.ts#missing'];
    assert.ok(validateReplacementTargets(root, records).some((error) => error.includes('does not exist')));
});

test('unmapped or silently removed browser identities fail closed', () =>
{
    const withoutMapping = expanded().filter(
        (record) => record.sourceTestId !== 'vitest:tests/frontend/e2e/old.spec.ts#old'
    );
    assert.ok(validate(fixture, withoutMapping).some((error) => error.includes('unmapped Acceptance baseline test')));

    const withoutDiagnostic = structuredClone(fixture);
    withoutDiagnostic.currentRecords = withoutDiagnostic.currentRecords.filter(
        (record) => record.sourceTestId !== 'vitest:tests/frontend/e2e/visual.spec.ts#visual'
    );
    assert.ok(validate(withoutDiagnostic).some((error) => error.includes('was deleted without changing its migration mapping')));
});

test('browser-only risk requires a real browser replacement or approved removal', () =>
{
    const unapproved = expanded();
    const obsolete = unapproved.find((record) => record.replacementLayer === 'none');
    obsolete.removalReason = '';
    obsolete.approval = null;
    assert.ok(validate(fixture, unapproved).some((error) => error.includes('requires an explicit reason')));

    const domOnly = expanded();
    const visual = domOnly.find(
        (record) => record.sourceTestId === 'vitest:tests/frontend/e2e/visual.spec.ts#visual'
    );
    visual.replacementTestIds.push('vitest:happy-dom-equivalence');
    assert.ok(validate(fixture, domOnly).some((error) => error.includes('cannot claim happy-dom equivalence')));
});

test('browser tests remain isolated from direct infrastructure control', () =>
{
    assert.deepEqual(repositoryBrowserTestIsolationViolations(root), []);
});

test('browser isolation rejects SQL Redis Docker and child process primitives', () =>
{
    const sources = [
        { file: 'sql.spec.ts', source: "const sqlTool = 'psql'" },
        { file: 'redis.spec.ts', source: "const redisTool = 'redis-cli'" },
        { file: 'docker.spec.ts', source: "const containerTool = 'docker'" },
        { file: 'process.spec.ts', source: "const processModule = 'node:child_process'" }
    ];
    assert.equal(browserTestIsolationViolations(sources).length, sources.length);
});
