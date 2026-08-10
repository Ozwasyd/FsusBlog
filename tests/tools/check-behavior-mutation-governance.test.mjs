import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    FORBIDDEN_CONFIG_FIELDS,
    collectForbiddenFields,
    scanBehaviorMutationGovernance
} from '../../tools/governance/check-behavior-mutation-governance.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REQUIRED_BEHAVIORS = Object.freeze([
    'binary-api-aeds-contract',
    'authentication-session-permission',
    'configuration-error-security-policy',
    'article-comment-lifecycle-outbox'
]);

function validMatrix({ manualOnly = false, cadence = 'pr', requiredFor = 'production', nightlyOnly = false } = {})
{
    return [
        'version: 3',
        'tiers:',
        '    - id: backend-mutation-changed-critical',
        '      owner: ServerContractAgent',
        '      command: tools/test/lanes/backend-mutation-changed-critical.sh',
        `      cadence: ${cadence}`,
        `      requiredFor: ${requiredFor}`,
        `      manualOnly: ${manualOnly}`,
        `      nightlyOnly: ${nightlyOnly}`,
        '      phase: 5',
        '      risk: critical',
        '      localOnly: false',
        ''
    ].join('\n');
}

function validCatalog()
{
    return {
        schema: 'fsusblog.behavior-contracts.v1',
        contracts: REQUIRED_BEHAVIORS.map((behaviorId) => ({
            id: behaviorId,
            status: 'active',
            mutationPolicy: {
                mutationRequired: true,
                requireExecutedMutants: true,
                allowedEquivalentMutantPolicy: 'none',
                minimumMutationScore: 70
            }
        }))
    };
}

function validLane()
{
    return [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        ': "${FSUSBLOG_CHANGED_CRITICAL_PATHS_FILE:?missing}"',
        ': "${FSUSBLOG_TEST_SOURCE_COMMIT:?missing}"',
        ': "${FSUSBLOG_TEST_SOURCE_FINGERPRINT:?missing}"',
        ': "${FSUSBLOG_TEST_RUN_ID:?missing}"',
        ': "${FSUSBLOG_BEHAVIOR_OWNER_RECEIPT:?missing}"',
        ': "${FSUSBLOG_BEHAVIOR_TEST_BINDINGS:?missing}"',
        ': "${FSUSBLOG_BEHAVIOR_TEST_EVIDENCE:?missing}"',
        ': "${FSUSBLOG_TEST_PLAN:?missing}"',
        'node tools/test-matrix/produce-behavior-mutation-qualification.mjs',
        ''
    ].join('\n');
}

function validProducerSource()
{
    return 'export const mutationEvidenceReceiptSchema = \'fsusblog.mutation-evidence-receipt.v1\'\nexport const ok = true\n';
}

function validVerifierSource()
{
    return 'export const mutationEvidenceReceiptSchema = \'fsusblog.mutation-evidence-receipt.v1\'\nexport const ok = true\n';
}

const fixtureBase = path.join(REPO_ROOT, '.tmp', 'bmq-governance-tests');

function writeFixtureRoot(name, {
    matrix = validMatrix(),
    catalog = validCatalog(),
    mutationConfigs = {},
    lane = validLane(),
    producer = validProducerSource(),
    verifier = validVerifierSource(),
    governanceSource = '// present'
} = {})
{
    const dir = path.join(fixtureBase, `${name}-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, 'tests'), { recursive: true });
    mkdirSync(path.join(dir, 'config', 'contracts'), { recursive: true });
    mkdirSync(path.join(dir, 'config', 'testing', 'mutation'), { recursive: true });
    mkdirSync(path.join(dir, 'tools', 'test', 'lanes'), { recursive: true });
    mkdirSync(path.join(dir, 'tools', 'test-matrix'), { recursive: true });
    mkdirSync(path.join(dir, 'tools', 'governance'), { recursive: true });
    writeFileSync(path.join(dir, 'tests', 'matrix.yml'), matrix);
    writeFileSync(
        path.join(dir, 'config', 'contracts', 'behavior-contracts.json'),
        `${JSON.stringify(catalog, null, 2)}\n`
    );
    for (const [fileName, contents] of Object.entries(mutationConfigs))
    {
        writeFileSync(
            path.join(dir, 'config', 'testing', 'mutation', fileName),
            typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`
        );
    }
    writeFileSync(path.join(dir, 'tools', 'test', 'lanes', 'backend-mutation-changed-critical.sh'), lane);
    writeFileSync(
        path.join(dir, 'tools', 'test-matrix', 'produce-behavior-mutation-qualification.mjs'),
        producer
    );
    writeFileSync(
        path.join(dir, 'tools', 'test-matrix', 'verify-behavior-mutation-qualification.mjs'),
        verifier
    );
    writeFileSync(
        path.join(dir, 'tools', 'governance', 'check-behavior-mutation-governance.mjs'),
        governanceSource
    );
    return dir;
}

test('static governance: a converged automatic/production-required matrix fixture passes', () =>
{
    const dir = writeFixtureRoot('ok');
    const report = scanBehaviorMutationGovernance({ repositoryRoot: dir });
    assert.equal(report.ok, true, report.violations.join('\n'));
    assert.ok(report.checks.includes('matrix tier backend-mutation-changed-critical present'));
});

test('static governance: manualOnly required behavior and requiredFor none are rejected', () =>
{
    const dir = writeFixtureRoot('manual-only', {
        matrix: validMatrix({ manualOnly: true, cadence: 'release-manual', requiredFor: 'none' })
    });
    const report = scanBehaviorMutationGovernance({ repositoryRoot: dir });
    assert.equal(report.ok, false);
    assert.ok(report.violations.some((v) => v.includes('must not be manualOnly')), report.violations.join('\n'));
    assert.ok(report.violations.some((v) => v.includes('cadence must be pr')), report.violations.join('\n'));
    assert.ok(report.violations.some((v) => v.includes('requiredFor must be production')), report.violations.join('\n'));
});

test('static governance: nightlyOnly and missing tier are rejected', () =>
{
    const nightly = writeFixtureRoot('nightly', { matrix: validMatrix({ nightlyOnly: true }) });
    const nightlyReport = scanBehaviorMutationGovernance({ repositoryRoot: nightly });
    assert.equal(nightlyReport.ok, false);
    assert.ok(nightlyReport.violations.some((v) => v.includes('must not be nightlyOnly')), nightlyReport.violations.join('\n'));

    const missing = writeFixtureRoot('missing-tier', {
        matrix: 'version: 3\ntiers:\n    - id: backend-mutation\n      cadence: nightly\n'
    });
    const missingReport = scanBehaviorMutationGovernance({ repositoryRoot: missing });
    assert.equal(missingReport.ok, false);
    assert.ok(missingReport.violations.some((v) => v.includes('is missing')), missingReport.violations.join('\n'));
});

test('static governance: every required release behavior must be active, mutationRequired and fail-closed in the catalog', () =>
{
    for (const behaviorId of REQUIRED_BEHAVIORS)
    {
        const catalog = validCatalog();
        const contract = catalog.contracts.find((entry) => entry.id === behaviorId);
        contract.status = 'retired';
        const retired = writeFixtureRoot(`retired-${behaviorId}`, { catalog });
        const retiredReport = scanBehaviorMutationGovernance({ repositoryRoot: retired });
        assert.equal(retiredReport.ok, false, `${behaviorId} retired must fail`);
        assert.ok(
            retiredReport.violations.some((v) => v.includes(`${behaviorId} must be active and mutationRequired`)),
            retiredReport.violations.join('\n')
        );

        contract.status = 'active';
        contract.mutationPolicy.mutationRequired = false;
        const notRequired = writeFixtureRoot(`not-required-${behaviorId}`, { catalog });
        const notRequiredReport = scanBehaviorMutationGovernance({ repositoryRoot: notRequired });
        assert.equal(notRequiredReport.ok, false, `${behaviorId} not mutationRequired must fail`);
        assert.ok(
            notRequiredReport.violations.some((v) => v.includes(`${behaviorId} must be active and mutationRequired`)),
            notRequiredReport.violations.join('\n')
        );

        contract.mutationPolicy.mutationRequired = true;
        contract.mutationPolicy.requireExecutedMutants = false;
        const noExecuted = writeFixtureRoot(`no-executed-${behaviorId}`, { catalog });
        const noExecutedReport = scanBehaviorMutationGovernance({ repositoryRoot: noExecuted });
        assert.equal(noExecutedReport.ok, false, `${behaviorId} requireExecutedMutants=false must fail`);
        assert.ok(
            noExecutedReport.violations.some((v) => v.includes(`${behaviorId} mutationPolicy.requireExecutedMutants must be true`)),
            noExecutedReport.violations.join('\n')
        );

        contract.mutationPolicy.requireExecutedMutants = true;
        contract.mutationPolicy.allowedEquivalentMutantPolicy = 'survived';
        const allowEquivalent = writeFixtureRoot(`allow-equivalent-${behaviorId}`, { catalog });
        const allowEquivalentReport = scanBehaviorMutationGovernance({ repositoryRoot: allowEquivalent });
        assert.equal(allowEquivalentReport.ok, false, `${behaviorId} allowedEquivalentMutantPolicy!=none must fail`);
        assert.ok(
            allowEquivalentReport.violations.some((v) => v.includes(`${behaviorId} mutationPolicy.allowedEquivalentMutantPolicy must be none`)),
            allowEquivalentReport.violations.join('\n')
        );
    }
});

test('static governance: global score pass fields are forbidden everywhere in mutation configs', () =>
{
    for (const field of ['globalScorePass', 'allowGlobalScorePass', 'scoreOnly', 'forcePass'])
    {
        const violations = [];
        collectForbiddenFields({ stryker: { [field]: true } }, 'config/testing/mutation/t.json', violations);
        assert.ok(violations.some((v) => v.includes(`${field} is forbidden`)), violations.join('\n'));

        const dir = writeFixtureRoot(`score-${field}`, { mutationConfigs: { 'score.json': { [field]: true } } });
        const report = scanBehaviorMutationGovernance({ repositoryRoot: dir });
        assert.equal(report.ok, false, `${field} must fail the scan`);
        assert.ok(report.violations.some((v) => v.includes(`${field} is forbidden`)), report.violations.join('\n'));
    }
});

test('static governance: history reuse fields are forbidden (main/latest/previous-run evidence)', () =>
{
    for (const field of ['historyReuse', 'reuseHistory', 'useMain', 'useLatest', 'latestEvidence'])
    {
        const violations = [];
        collectForbiddenFields({ [field]: true }, 'config/testing/mutation/t.json', violations);
        assert.ok(violations.some((v) => v.includes(`${field} is forbidden`)), violations.join('\n'));

        const dir = writeFixtureRoot(`history-${field}`, { mutationConfigs: { 'history.json': { [field]: true } } });
        const report = scanBehaviorMutationGovernance({ repositoryRoot: dir });
        assert.equal(report.ok, false, `${field} must fail the scan`);
        assert.ok(report.violations.some((v) => v.includes(`${field} is forbidden`)), report.violations.join('\n'));
    }
});

test('static governance: mutant allowlists are forbidden', () =>
{
    for (const field of ['allowlist', 'allowedMutants', 'ignoreMutants', 'skipMutants'])
    {
        const violations = [];
        collectForbiddenFields({ [field]: ['m1'] }, 'config/testing/mutation/t.json', violations);
        assert.ok(violations.some((v) => v.includes(`${field} is forbidden`)), violations.join('\n'));

        const dir = writeFixtureRoot(`allowlist-${field}`, { mutationConfigs: { 'allowlist.json': { [field]: ['m1'] } } });
        const report = scanBehaviorMutationGovernance({ repositoryRoot: dir });
        assert.equal(report.ok, false, `${field} must fail the scan`);
        assert.ok(report.violations.some((v) => v.includes(`${field} is forbidden`)), report.violations.join('\n'));
    }
});

test('static governance: manual override/approval fields are forbidden', () =>
{
    for (const field of ['manualOverride', 'manualApproval', 'allowManual', 'fallbackToManual'])
    {
        const violations = [];
        collectForbiddenFields({ [field]: true }, 'config/testing/mutation/t.json', violations);
        assert.ok(violations.some((v) => v.includes(`${field} is forbidden`)), violations.join('\n'));

        const dir = writeFixtureRoot(`manual-${field}`, { mutationConfigs: { 'manual.json': { [field]: true } } });
        const report = scanBehaviorMutationGovernance({ repositoryRoot: dir });
        assert.equal(report.ok, false, `${field} must fail the scan`);
        assert.ok(report.violations.some((v) => v.includes(`${field} is forbidden`)), report.violations.join('\n'));
    }
});

test('static governance: every forbidden config field name is collected', () =>
{
    const config = Object.fromEntries(FORBIDDEN_CONFIG_FIELDS.map((field) => [field, true]));
    const violations = [];
    collectForbiddenFields(config, 'config/testing/mutation/all.json', violations);
    assert.equal(violations.length, FORBIDDEN_CONFIG_FIELDS.length);
    for (const field of FORBIDDEN_CONFIG_FIELDS)
    {
        assert.ok(violations.some((v) => v.includes(`${field} is forbidden`)), `${field} missing from ${violations.join('; ')}`);
    }
});

test('static governance: invalid mutation config JSON fails closed', () =>
{
    const dir = writeFixtureRoot('bad-json', { mutationConfigs: { 'bad.json': '{ nope' } });
    const report = scanBehaviorMutationGovernance({ repositoryRoot: dir });
    assert.equal(report.ok, false);
    assert.ok(report.violations.some((v) => v.includes('is not valid JSON')), report.violations.join('\n'));
});

test('static governance: lane must require every fail-closed input and invoke the canonical producer', () =>
{
    for (const env of [
        'FSUSBLOG_CHANGED_CRITICAL_PATHS_FILE',
        'FSUSBLOG_TEST_SOURCE_COMMIT',
        'FSUSBLOG_TEST_SOURCE_FINGERPRINT',
        'FSUSBLOG_TEST_RUN_ID',
        'FSUSBLOG_BEHAVIOR_OWNER_RECEIPT',
        'FSUSBLOG_BEHAVIOR_TEST_BINDINGS',
        'FSUSBLOG_BEHAVIOR_TEST_EVIDENCE',
        'FSUSBLOG_TEST_PLAN'
    ])
    {
        const lane = validLane().replace(new RegExp(`: "\\$\\{${env}:\\?missing\\}"`), '');
        const dir = writeFixtureRoot(`lane-${env}`, { lane });
        const report = scanBehaviorMutationGovernance({ repositoryRoot: dir });
        assert.equal(report.ok, false, `${env} omission must fail`);
        assert.ok(
            report.violations.some((v) => v.includes(`lane is missing required input contract ${env}`)),
            report.violations.join('\n')
        );
    }

    const noProducer = writeFixtureRoot('lane-no-producer', {
        lane: validLane().replace('produce-behavior-mutation-qualification.mjs', 'changed-critical-mutation.mjs')
    });
    const noProducerReport = scanBehaviorMutationGovernance({ repositoryRoot: noProducer });
    assert.equal(noProducerReport.ok, false);
    assert.ok(
        noProducerReport.violations.some((v) => v.includes('lane must invoke the canonical per-behavior mutation qualification producer')),
        noProducerReport.violations.join('\n')
    );
});

test('static governance: lane fallback to manual approval or warning success is rejected', () =>
{
    const lane = `${validLane()}\nif ! check; then exit 0 --warn; fi\n`;
    const dir = writeFixtureRoot('lane-warn', { lane });
    const report = scanBehaviorMutationGovernance({ repositoryRoot: dir });
    assert.equal(report.ok, false);
    assert.ok(
        report.violations.some((v) => v.includes('lane must not fall back to manual approval, allowlist, history reuse or warning success')),
        report.violations.join('\n')
    );
});

test('static governance: missing producer/verifier and forbidden tooling fallback patterns fail closed', () =>
{
    const missingProducer = writeFixtureRoot('missing-producer', { producer: '' });
    rmSync(path.join(missingProducer, 'tools', 'test-matrix', 'produce-behavior-mutation-qualification.mjs'), { force: true });
    const missingProducerReport = scanBehaviorMutationGovernance({ repositoryRoot: missingProducer });
    assert.equal(missingProducerReport.ok, false);
    assert.ok(
        missingProducerReport.violations.some((v) => v.includes('producer is missing')),
        missingProducerReport.violations.join('\n')
    );

    const missingVerifier = writeFixtureRoot('missing-verifier', { verifier: '' });
    rmSync(path.join(missingVerifier, 'tools', 'test-matrix', 'verify-behavior-mutation-qualification.mjs'), { force: true });
    const missingVerifierReport = scanBehaviorMutationGovernance({ repositoryRoot: missingVerifier });
    assert.equal(missingVerifierReport.ok, false);
    assert.ok(
        missingVerifierReport.violations.some((v) => v.includes('verifier is missing')),
        missingVerifierReport.violations.join('\n')
    );

    const forbiddenProducer = writeFixtureRoot('producer-warn', {
        producer: 'export const schema = \'fsusblog.mutation-evidence-receipt.v1\'\nexport const fallback = \'warningSuccess\'\n'
    });
    const forbiddenProducerReport = scanBehaviorMutationGovernance({ repositoryRoot: forbiddenProducer });
    assert.equal(forbiddenProducerReport.ok, false);
    assert.ok(
        forbiddenProducerReport.violations.some((v) => v.includes('must not contain forbidden fallback pattern')),
        forbiddenProducerReport.violations.join('\n')
    );
});

test('static governance: the checked-in repository passes the scan', () =>
{
    const report = scanBehaviorMutationGovernance({ repositoryRoot: REPO_ROOT });
    assert.equal(report.ok, true, report.violations.join('\n'));
});
