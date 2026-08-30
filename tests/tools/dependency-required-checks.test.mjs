import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    auditRequiredChecks,
    discoverWorkflowChecks,
    evaluateRequiredChecks,
    resolveGroupChecks,
    runRequiredChecksFixtures,
    validateRequiredChecksCatalog
} from '../../tools/governance/check-dependency-required-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/dependencies/required-checks.json'), 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/governance/dependency-required-checks.json'), 'utf8'));
const workflowChecks = discoverWorkflowChecks(root);

function successRuns(names)
{
    return names.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
}

test('required-checks catalog matches workflows and simulated branch protection', () => {
    const result = auditRequiredChecks(root, { forbidAutomerge: false });
    assert.deepEqual(result.errors, []);
    assert.equal(result.catalog.schema, 'fsusblog.dependency-required-checks.v1');
    for (const name of result.catalog.branchProtection.contexts)
    {
        assert.ok(workflowChecks.has(name), `missing workflow check ${name}`);
    }
});

test('required-checks fixtures kill missing, skipped, lint-only and drift cases', () => {
    const failures = runRequiredChecksFixtures(catalog, fixtures, {
        root,
        workflowChecks,
        forbidAutomerge: true
    });
    assert.deepEqual(failures, []);
});

test('patch and minor hit the same contract set while major and digest differ', () => {
    const patch = resolveGroupChecks(catalog, 'frontend-runtime', 'patch');
    const minor = resolveGroupChecks(catalog, 'frontend-runtime', 'minor');
    const major = resolveGroupChecks(catalog, 'frontend-runtime', 'major');
    const digest = resolveGroupChecks(catalog, 'container-toolchain', 'digest');
    const lockfile = resolveGroupChecks(catalog, 'lockfile-maintenance', 'lockFileMaintenance');
    assert.deepEqual(patch, minor);
    assert.notDeepEqual(major, patch);
    assert.notDeepEqual(digest, patch);
    assert.notDeepEqual(lockfile, patch);
    assert.ok(patch.includes('Quality Gate / Production Summary'));
    assert.ok(major.includes('Quality Gate / Fast Backend DAG'));
    assert.ok(digest.includes('Quality Gate / Release Evidence'));
    assert.ok(lockfile.includes('Quality Gate / Fast Backend DAG'));
    assert.ok(lockfile.includes('Quality Gate / Fast Frontend Unit DAG'));
});

test('skipped, neutral, cancelled, timed_out and missing required checks are not success', () => {
    const required = ['Quality Gate / Production Summary'];
    assert.deepEqual(
        evaluateRequiredChecks(required, [{ name: required[0], status: 'completed', conclusion: 'skipped' }]).map((error) => error.code),
        ['check-skipped']
    );
    assert.deepEqual(
        evaluateRequiredChecks(required, [{ name: required[0], status: 'completed', conclusion: 'neutral' }]).map((error) => error.code),
        ['check-neutral']
    );
    assert.deepEqual(
        evaluateRequiredChecks(required, [{ name: required[0], status: 'completed', conclusion: 'cancelled' }]).map((error) => error.code),
        ['check-cancelled']
    );
    assert.deepEqual(
        evaluateRequiredChecks(required, [{ name: required[0], status: 'completed', conclusion: 'timed_out' }]).map((error) => error.code),
        ['check-timed-out']
    );
    assert.deepEqual(evaluateRequiredChecks(required, []).map((error) => error.code), ['check-missing']);
    assert.deepEqual(evaluateRequiredChecks(required, successRuns(required)), []);
});

test('local branch protection simulation rejects catalog drift', () => {
    const errors = validateRequiredChecksCatalog(catalog, {
        root,
        workflowChecks,
        branchProtection: {
            strict: true,
            contexts: catalog.branchProtection.contexts.filter((name) => name !== 'Dependency Review / Dependency Review')
        }
    });
    assert.ok(errors.some((error) => error.code === 'branch-protection-missing-catalog-check'));
});

test('required-checks catalog does not encode automerge or freshness workflows', () => {
    const serialized = JSON.stringify(catalog);
    assert.equal(serialized.includes('automerge'), false);
    assert.equal(fs.existsSync(path.join(root, '.github/workflows/dependency-freshness.yml')), false);
});
