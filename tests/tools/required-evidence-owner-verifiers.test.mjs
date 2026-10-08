import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { loadCanonicalRequiredEvidenceCatalog } = await import(new URL('../../tools/test-matrix/required-evidence-catalog.mjs', import.meta.url));
const { createDomainVerifierRegistry, loadDomainVerifier } = await import(new URL('../../tools/release/required-evidence-verifier-registry.mjs', import.meta.url));
const { generateEvidenceLocationGovernance } = await import(new URL('../../tools/test/generate-evidence-location-governance.mjs', import.meta.url));
const { validateReleaseFinalCoverageSummaries } = await import(new URL('../../tools/coverage/check-release-final-coverage.mjs', import.meta.url));
const { validateRegistry } = await import(new URL('../../tools/ci/check-flaky-registry.mjs', import.meta.url));
const { validateStrictJobSummarySet } = await import(new URL('../../tools/ci/check-job-summaries.mjs', import.meta.url));
const { verifyConformanceArtifact } = await import(new URL('../../tools/test-quality/conformance.mjs', import.meta.url));
const { contentDigest } = await import(new URL('../../tools/test-quality/schema.mjs', import.meta.url));
const { governanceContentDigest } = await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
const { buildIndependentReview } = await import(new URL('../../tools/security/perception-character-v3-independent-review.mjs', import.meta.url));
const { requiredEvidenceVerifier: xssVerifier } = await import(new URL('../../tools/security/production-xss-evidence.mjs', import.meta.url));
const { requiredEvidenceVerifier: nativeVerifier } = await import(new URL('../../tools/test/native-test-receipt.mjs', import.meta.url));
const { describeJobEvidence } = await import(new URL('../../tools/release/required-evidence-owner-contract.mjs', import.meta.url));

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

test('canonical 22 authorities expose explicit owner APIs and exact canonical locator mappings', async () =>
{
    const catalog = loadCanonicalRequiredEvidenceCatalog();
    const registry = createDomainVerifierRegistry({ catalog, repositoryRoot });
    const locators = generateEvidenceLocationGovernance().registry;
    assert.equal(registry.entries.length, 22);
    for (const entry of catalog.entries)
    {
        const { verifier } = await loadDomainVerifier({ registry, catalog, authorityId: entry.authorityId, repositoryRoot });
        assert.equal(typeof verifier.describe, 'function');
        assert.equal(typeof verifier.verify, 'function');
        const matches = locators.entries.filter((item) => item.authorityId === entry.locatorBindingKey);
        assert.equal(matches.length, 1);
        assert.equal(matches[0].producerId, entry.canonicalOwner);
        assert.equal(matches[0].expectedCardinality, 'exact-one');
    }
});

test('CI description uses scheduler authority and never synthesizes absent business identity/class', async () =>
{
    const description = describeJobEvidence({ runId: 'github-run', schedulerRunId: 'scheduler-run', commit: 'a'.repeat(40) });
    assert.equal(description.identity.runId, 'scheduler-run');
    assert.equal(description.identity.namespace, undefined);
    assert.equal(description.identity.worktreeFingerprint, undefined);
    assert.equal(description.evidenceClass, undefined);
    const native = await nativeVerifier.describe({ source: { inputDigest: `sha256:${'b'.repeat(64)}` } });
    assert.equal(native.identity.worktreeFingerprint, undefined);
});

test('coverage API reuses real thresholds and kills low coverage and missing critical branch evidence', () =>
{
    const policy = fs.readFileSync(path.join(repositoryRoot, 'tests/coverage-policy.yml'), 'utf8');
    const summaries = {
        backend: { summary: { linecoverage: 100, branchcoverage: 100 },
            files: [{ path: 'src/backend/Infrastructure/Auth/AuthCookieService.cs', branchcoverage: 100 }] },
        frontend: { summary: { linecoverage: 100, branchcoverage: 100 } },
        changed: { summary: { linecoverage: 100 } }
    };
    assert.deepEqual(validateReleaseFinalCoverageSummaries(summaries, policy), []);
    const low = structuredClone(summaries);
    low.frontend.summary.branchcoverage = 0;
    assert(validateReleaseFinalCoverageSummaries(low, policy).some((error) => error.includes('frontend branch')));
    const missing = structuredClone(summaries);
    missing.backend.files = [];
    assert(validateReleaseFinalCoverageSummaries(missing, policy).some((error) => error.includes('critical backend')));
    assert.throws(() => validateReleaseFinalCoverageSummaries({}, policy));
});

test('flaky owner refuses release-critical quarantine instead of accepting an ok summary', () =>
{
    assert.deepEqual(validateRegistry({ version: 'fsusblog-flaky-v1', entries: [] }, { releaseFinal: true }), []);
    const errors = validateRegistry({ version: 'fsusblog-flaky-v1', entries: [{
        id: 'critical', suite: 'security', test: 'declared', issue: 2060,
        reason: 'controlled negative fixture', expires: '2099-01-01', allowedRetries: 1,
        owner: 'controlled', mode: 'retry-and-report', classification: 'known-flaky'
    }] }, { releaseFinal: true });
    assert(errors.some((error) => error.includes('forbids retry')));
    assert(errors.some((error) => error.includes('blocks critical')));
});

test('strict shard owner checks explicit plan membership, duplicate/missing shards and non-success', () =>
{
    const plan = { tiers: [
        { id: 'production', dependsOn: ['controlled'], ciJob: 'production' },
        { id: 'controlled', ciJob: 'controlled', requiresPlaywright: 'none', shardable: true, defaultShards: 2 }
    ] };
    const summaries = [1, 2].map((index) => ({ schema: 'fsusblog.ci.job-result.v1',
        jobId: `controlled-${index}-of-2`, status: 'success', tierIds: ['controlled'], artifacts: [],
        localReproduction: 'controlled fixture', commit: 'a'.repeat(40), runId: 'controlled', attempt: '1', durationMs: 1,
        stageDurationsMs: Object.fromEntries(['setup', 'restore', 'install', 'bootstrap', 'test', 'artifact', 'summary'].map((stage) => [stage, 0])) }));
    assert.deepEqual(validateStrictJobSummarySet(plan, summaries), []);
    assert(validateStrictJobSummarySet(plan, summaries.slice(1)).some((error) => error.includes('missing strict')));
    assert(validateStrictJobSummarySet(plan, [...summaries, summaries[0]]).some((error) => error.includes('duplicate')));
    assert(validateStrictJobSummarySet(plan, summaries.map((item) => ({ ...item, status: 'cancelled' }))).some((error) => error.includes('not successful')));
});

test('read-only conformance replay binds actual expectations to the canonical corpus and kills a resigned forged oracle', () =>
{
    const file = path.join(repositoryRoot, 'tests/fixtures/test-quality-corpus/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cases = manifest.fixtures.map((expected) => ({ ...expected,
        testId: expected.testId ?? `controlled:${expected.displayName}`,
        expectedTestId: expected.testId ?? `controlled:${expected.displayName}`,
        sourceSpan: { start: { line: expected.expectedLine } },
        actualOutcome: expected.expectedOutcome, actualRules: expected.expectedRules.toSorted(),
        expectedRules: expected.expectedRules.toSorted() }));
    const artifact = { schema: 'fsusblog.test-quality-conformance.v1', corpusVersion: manifest.version,
        manifestDigest: governanceContentDigest({ fixture: true }), cases, killedMutations: [] };
    // A forged digest alone is never accepted; this fixture is a negative
    // control, not a physical adapter/conformance execution receipt.
    artifact.contentDigest = contentDigest(artifact);
    assert.throws(() => verifyConformanceArtifact(repositoryRoot, artifact), /corpus mismatch/u);
});

test('security owners refuse header-only success and absent raw inputs without rerunning producers', async () =>
{
    assert.throws(() => buildIndependentReview({ implementation: { receiptFingerprint: 'forged' },
        poolManifest: {}, corpus: {}, benchmark: {}, migration: {} }), /fingerprint/u);
    await assert.rejects(xssVerifier.verify({ receipt: { status: 'success' },
        domainInputs: {}, repositoryRoot, context: { ownedRoots: [] } }), /explicit owner evidence/u);
});
