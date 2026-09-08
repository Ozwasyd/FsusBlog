import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { scanArticleScalePlanGovernance } = await import(pathToFileURL(path.join(
    root,
    'tools/test/check-article-scale-plan-governance.mjs'
)).href);
const fixture = JSON.parse(fs.readFileSync(
    path.join(root, 'tests/fixtures/governance/article-scale-plan-governance.json'),
    'utf8'
));

test('article scale plan static governance accepts the canonical contract-only owner', () =>
{
    const result = scanArticleScalePlanGovernance(root);

    assert.equal(result.status, 'verified', JSON.stringify(result.violations, null, 2));
    assert.equal(result.canonicalPlan, 'src/backend/Services/Fixtures/DataScale/ArticleScalePlan.cs');
    assert.ok(result.scannedBackendFiles > 0);
    assert.deepEqual(result.violations, []);
});

test('article scale plan static governance kills every scoped mutation class', () =>
{
    assert.equal(fixture.schema, 'fsusblog.article-scale-plan-governance-mutations.v1');
    assert.ok(
        fixture.mutations.filter((mutation) => !mutation.path.startsWith(
            'src/backend/Services/Fixtures/DataScale/'
        )).length >= 3,
        'repo-level mutations must exercise paths outside the canonical owner root'
    );
    assert.deepEqual(
        fixture.mutations.map((mutation) => mutation.id),
        [
            'status-modulo',
            'simplified-graph',
            'sentinel-hash',
            'manual-derived-state',
            'second-plan-schema',
            'second-plan-type'
        ]
    );
    for (const mutation of fixture.mutations)
    {
        const result = scanArticleScalePlanGovernance(root, {
            overlays: new Map([[mutation.path, mutation.source]])
        });

        assert.equal(result.status, 'failed', mutation.id);
        assert.ok(
            result.violations.some((violation) => violation.ruleId === mutation.expectedRuleId),
            `${mutation.id}: ${JSON.stringify(result.violations)}`
        );
    }
});
