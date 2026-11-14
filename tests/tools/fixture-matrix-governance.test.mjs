import assert from 'node:assert/strict';
import test from 'node:test';

const { buildFixtureMatrixAcceptance, scanFixtureMatrixSources, verifyFixtureMatrixAcceptance, verifyFixtureMatrixExactness } = await import(new URL('../../tools/test/fixture-matrix-governance.mjs', import.meta.url));
const { seal } = await import(new URL('../../tools/test-fixtures/mutation-recovery/canonical.mjs', import.meta.url));

import { governanceMaterials } from './support/fixture-matrix-evidence-fixture.mjs';

test('source scanner kills forbidden fixture inference and wrapper variants across executable languages', () =>
{
    const samples = [
        ['environment-override', 'tools/env.mjs', 'const p = process.env.FSUSBLOG_FIXTURE_PROFILE;'],
        ['environment-override', 'tools/env.sh', 'profile="${RENAMED_FIXTURE_CUSTOM_PROFILE:-auth-basic}"'],
        ['environment-override', 'src/backend/Env.cs', 'GetEnvironmentVariable("RENAMED_FIXTURE_PROFILE");'],
        ['missing-profile-default', 'tools/default.mjs', "const profileId = 'auth-basic';"],
        ['missing-profile-default', 'tools/fallback.mjs', "const profileId = explicitValue ?? 'auth-basic';"],
        ['all-runtime-acceptance-all', 'tests/matrix.yml', 'fixtureProfile: acceptance-all'],
        ['tier-case-seed', 'tools/lane.sh', 'case "$tier" in\n public) seedFixture();;\nesac'],
        ['hidden-bootstrap-seed', 'src/backend/Bootstrap.cs', 'seedAcceptance();'],
        ['second-producer-dag', 'tools/map.mjs', 'const customProfileDag = {};'],
        ['old-parser', 'tools/parser.mjs', 'parseLegacyFixture(value);'],
        ['data-scale-local-fallback', 'tools/config.toml', 'data-scale fallback = local'],
        ['diagnostic-receipt-reuse', '.github/workflows/ci.yml', 'correctness: diagnosticReceipt'],
        ['consumer-bypass', 'tools/admission.mjs', 'allowUnverifiedFixture = true;'],
        ['latest-receipt', 'tools/receipt.mjs', 'latest fixture recovery receipt'],
        ['sequence-restart', 'tools/recovery.mjs', 'restartBackend();']
    ];
    for (const [ruleId, file, source] of samples)
    {
        const result = scanFixtureMatrixSources({ [file]: source });
        assert.ok(result.violations.some((violation) => violation.ruleId === ruleId), `${ruleId} survived`);
    }
});

test('long minified lines remain bounded and inspected with an explicit semantic review warning', () =>
{
    const result = scanFixtureMatrixSources({ 'tools/minified.mjs': `${'x'.repeat(20000)};restartBackend();` });
    assert.ok(result.violations.some((violation) => violation.ruleId === 'sequence-restart'));
    assert.ok(result.warnings.some((warning) => warning.reason === 'long-line-cross-window-semantics-requires-review'));
});

test('documentation matches remain review warnings and never silently authorize acceptance', () =>
{
    const scanner = scanFixtureMatrixSources({ 'docs/example.md': "profileId = 'auth-basic'" });
    assert.equal(scanner.violations.length, 0);
    assert.equal(scanner.warnings.length, 1);
    const inputs = governanceMaterials();
    inputs.scanner = scanner;
    assert.equal(buildFixtureMatrixAcceptance(inputs).status, 'blocked');
});

test('canonical alias and second-authority errors bind to actual scanned paths without a duplicate registry', () =>
{
    const sources = { 'tools/data-only.mjs': 'export const value = true;' };
    const result = scanFixtureMatrixSources(sources, {
        authorityErrors: ['tools/data-only.mjs: fixture profile alias is forbidden']
    });
    assert.equal(result.violations[0].ruleId, 'canonical-fixture-authority');
    assert.throws(() => scanFixtureMatrixSources(sources, { authorityErrors: ['other.mjs: unbound'] }), /not bound/);
});

test('compiled bindings, consumer admissions and local/CI observed rosters compare bidirectionally', () =>
{
    const inputs = governanceMaterials();
    assert.equal(verifyFixtureMatrixExactness(inputs.exactness).status, 'verified');
    for (const field of ['bindings', 'consumers', 'local', 'ci'])
    {
        for (const update of [
            (roster) =>
            {
                roster.pop();
            },
            (roster) =>
            {
                roster.push(structuredClone(roster[0]));
            },
            (roster) =>
            {
                roster[0].profileId = 'auth-basic';
            },
            (roster) =>
            {
                roster[0].testIds.push('new-test');
            },
            (roster) =>
            {
                roster[0].capabilities.push('orphan-capability');
            },
            (roster) =>
            {
                roster[0].producerIds.push('extra-producer');
            },
            (roster) =>
            {
                roster[0].nodes.push('extra-node');
            },
            (roster) =>
            {
                roster[0].admissionDigest = `sha256:${'f'.repeat(64)}`;
            }
        ])
        {
            const exactness = structuredClone(inputs.exactness);
            update(exactness[field]);
            assert.throws(() => verifyFixtureMatrixExactness(exactness), /roster|duplicate|drifted/);
        }
    }
});

test('even two self-sealed input receipts plus positive data-only controls remain blocked without upstream authority', () =>
{
    const inputs = governanceMaterials();
    inputs.inputReceipts = { '2663': seal({ status: 'verified' }), '2664': seal({ status: 'verified' }) };
    const receipt = buildFixtureMatrixAcceptance(inputs);
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.qualificationEligible, false);
    assert.equal(receipt.inputRefs.length, 2);
    assert.ok(receipt.results.filter((result) => result.check.startsWith('input')).every((result) => result.status === 'unrun'));
    assert.ok(receipt.results.filter((result) => !result.check.startsWith('input')).every((result) => result.status === 'passed'));
    assert.equal(verifyFixtureMatrixAcceptance(receipt, inputs), receipt);
});

test('missing upstream receipts and unobserved parity/mutations/invalidation produce unrun rather than pass', () =>
{
    const inputs = governanceMaterials();
    delete inputs.inputReceipts;
    delete inputs.exactness;
    delete inputs.mutations;
    delete inputs.invalidation;
    const receipt = buildFixtureMatrixAcceptance(inputs);
    assert.equal(receipt.results.filter((result) => result.status === 'unrun').length, 5);
    assert.equal(receipt.status, 'blocked');
});

test('every required mutation rejects survived, skipped, zero-exit and cross-source evidence', () =>
{
    const inputs = governanceMaterials();
    for (let index = 0; index < inputs.mutations.length; index += 1)
    {
        for (const update of [
            (result) =>
            {
                result.status = 'survived';
            },
            (result) =>
            {
                result.status = 'not-observed';
            },
            (result) =>
            {
                result.exitCode = 0;
            },
            (result) =>
            {
                result.source = { ...result.source, commit: 'f'.repeat(40) };
            }
        ])
        {
            const changed = structuredClone(inputs);
            update(changed.mutations[index]);
            assert.equal(buildFixtureMatrixAcceptance(changed).results.find((result) => result.check === 'mutations').status, 'failed');
        }
    }
    inputs.mutations.pop();
    assert.equal(buildFixtureMatrixAcceptance(inputs).results.find((result) => result.check === 'mutations').status, 'failed');
});

test('every identity dimension must reject old plan, cache, evidence and release candidate', () =>
{
    const inputs = governanceMaterials();
    for (let index = 0; index < inputs.invalidation.length; index += 1)
    {
        for (const field of ['oldPlanAdmitted', 'oldCacheHit', 'oldEvidenceAdmitted', 'oldReleaseCandidateAdmitted'])
        {
            const changed = structuredClone(inputs);
            changed.invalidation[index][field] = true;
            assert.equal(buildFixtureMatrixAcceptance(changed).results.find((result) => result.check === 'identity-invalidation').status, 'failed');
        }
    }
    inputs.invalidation[0].afterDigest = inputs.invalidation[0].beforeDigest;
    assert.equal(buildFixtureMatrixAcceptance(inputs).results.find((result) => result.check === 'identity-invalidation').status, 'failed');
});

test('terminal receipt/scanner/material tamper and resealed acceptance promotion fail recomputation', () =>
{
    const inputs = governanceMaterials();
    const receipt = buildFixtureMatrixAcceptance(inputs);
    assert.throws(() => verifyFixtureMatrixAcceptance({ ...receipt, status: 'accepted' }, inputs), /digest mismatch/);
    assert.throws(() => verifyFixtureMatrixAcceptance(seal({ ...receipt, status: 'accepted', warnings: [] }), inputs), /recomputed/);
    inputs.scanner = { ...inputs.scanner, violations: [{}] };
    assert.throws(() => buildFixtureMatrixAcceptance(inputs), /digest mismatch/);
});
