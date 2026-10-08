import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { projectCrossSurfaceLocaleRisks, validateCrossSurfaceLocaleRisks } = await import(new URL('../browser-contract/cross-surface-locale-contract.mjs', import.meta.url));
const { createPublicShellFiniteInputOwner } = await import(new URL('../browser-contract/public-shell-finite-input-owner.mjs', import.meta.url));

const root = fileURLToPath(new URL('../../', import.meta.url));
const owner = await createPublicShellFiniteInputOwner(root);
const catalog = await owner.load('localeCatalog');
const descriptors = catalog.ENABLED_LOCALES;

test('risk rules cover current enabled descriptors once without browser or surface qualification', () =>
{
    const plan = projectCrossSurfaceLocaleRisks(descriptors);
    assert.deepEqual(plan.entries.map((entry) => entry.locale), descriptors.map((entry) => entry.code));
    assert.deepEqual([...new Set(plan.entries.map((entry) => entry.group))].sort(),
        ['baseline-latin', 'cjk', 'cyrillic-plural', 'long-latin']);
    assert.equal(plan.coverageStage, 'risk-rules-only');
    assert.equal(plan.qualificationEligible, false);
    assert.deepEqual(validateCrossSurfaceLocaleRisks(plan, descriptors), plan);
    assert.equal(projectCrossSurfaceLocaleRisks(structuredClone(descriptors)).contentDigest, plan.contentDigest);
});

for (const [name, mutate] of [
    ['missing locale', (value) => value.pop()],
    ['duplicate locale', (value) => value[1].code = value[0].code],
    ['disabled locale', (value) => value[0].status = 'disabled'],
    ['unknown script', (value) => value[0].script = 'unknown']
])
{
    test(`risk rules reject ${name}`, () =>
    {
        const input = structuredClone(descriptors);
        mutate(input);
        assert.throws(() => projectCrossSurfaceLocaleRisks(input), /cross-surface/u);
    });
}

for (const [name, mutate] of [
    ['wrong group', (value) => value.entries[0].group = 'baseline-latin'],
    ['missing selector narrow viewport', (value) => value.entries[0].selectorViewports.shift()],
    ['missing regional CJK extension', (value) => value.entries.find((entry) => entry.fontStages.length).viewports.shift()],
    ['missing zoom extension', (value) => value.entries.find((entry) => entry.zoomAt390.length > 1).zoomAt390.pop()],
    ['missing Cyrillic plural boundary', (value) => value.entries.find((entry) => entry.pluralCounts.length).pluralCounts.pop()],
    ['unbounded viewport', (value) => value.entries[0].viewports.push(4096)],
    ['second runner', (value) => value.runner = 'private-runner'],
    ['handwritten copy', (value) => value.entries[0].expectedCopy = 'wrong-copy'],
    ['digest tamper', (value) => value.contentDigest = `sha256:${'0'.repeat(64)}`]
])
{
    test(`risk validator rejects ${name}`, () =>
    {
        const plan = projectCrossSurfaceLocaleRisks(descriptors);
        mutate(plan);
        assert.throws(() => validateCrossSurfaceLocaleRisks(plan, descriptors), /cross-surface/u);
    });
}

test('metadata-only descriptor changes invalidate a previously sealed risk plan', () =>
{
    const plan = projectCrossSurfaceLocaleRisks(descriptors);
    const changed = structuredClone(descriptors);
    changed[0].nativeName += '-changed';
    assert.throws(() => validateCrossSurfaceLocaleRisks(plan, changed), /cross-surface/u);
});
