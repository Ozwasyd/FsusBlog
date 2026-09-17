import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {auditDependencyAutomerge, evaluatePlatformAutomerge, runAutomergeFixtures, validateRenovateAutomerge} = await import(new URL('../../tools/governance/check-dependency-automerge.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/dependencies/required-checks.json'), 'utf8'));
const renovate = JSON.parse(fs.readFileSync(path.join(root, 'renovate.json5'), 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/governance/dependency-automerge.json'), 'utf8'));

test('platform automerge config covers all update types without bypass', () =>
{
    const result = auditDependencyAutomerge(root);
    assert.deepEqual(result.errors, []);
    assert.equal(result.renovate.automergeType, 'pr');
    assert.equal(result.renovate.platformAutomerge, true);
    assert.equal(result.renovate.dependencyDashboardApproval, false);
    assert.equal(validateRenovateAutomerge(result.renovate).length, 0);
});

test('automerge fixtures kill draft, conflict, failed checks and stale targets', () =>
{
    assert.deepEqual(runAutomergeFixtures(catalog, renovate, fixtures), []);
});

test('required-checks catalog remains the unique check-name authority', () =>
{
    assert.equal(JSON.stringify(renovate).includes('Quality Gate /'), false);
    assert.equal(JSON.stringify(renovate).includes('required-checks.json'), false);
});

test('security updates cannot bypass required checks with branch automerge', () =>
{
    const result = evaluatePlatformAutomerge({
        catalog,
        defaultHeadSha: 'base',
        latestStable: '1.0.1',
        pullRequest: {
            group: 'identity-security',
            updateType: 'patch',
            draft: false,
            mergeable: true,
            mergeableState: 'clean',
            labels: [],
            baseSha: 'base',
            platformAutomerge: true,
            automergeType: 'branch',
            directPush: true,
            targetVersion: '1.0.1',
            checkRuns: []
        }
    });
    assert.equal(result.decision, 'reject');
    assert.ok(result.errors.some((error) => error.code === 'security-bypass'));
    assert.equal(result.close, false);
});

test('no freshness workflow is created by platform automerge', () =>
{
    assert.equal(JSON.stringify(renovate).includes('dependency-freshness.yml'), false);
    assert.equal(JSON.stringify(renovate).includes('run-dependency-freshness-schedule'), false);
});
