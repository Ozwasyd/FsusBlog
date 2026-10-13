import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { mapCanonicalQueryExpectedModel } = await import(new URL('../../tools/data-scale/query-expected-model.mjs', import.meta.url));
const { computeSha256 } = await import(new URL('../../tools/data-scale/runtime-plan.mjs', import.meta.url));

const root = fileURLToPath(new URL('../..', import.meta.url));

test('original canonical factory/verifier/visibility export mapped read expectations with refusal controls', () =>
{
    const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const directory = path.join(root, '.tmp/query-matrix-expected-controls', randomUUID());
    const command = spawnSync('dotnet', [path.join(root, 'tools/data-scale/query-plan-collector/bin/Release/net10.0/QueryPlanCollector.dll'),
        '--expected-controls', directory, sourceCommit], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    assert.equal(command.status, 0, command.stderr);
    const control = JSON.parse(fs.readFileSync(path.join(directory, 'controls.json')));
    assert.equal(control.sourceCommit, sourceCommit);
    assert.equal(control.qualification, 'not-performed');
    assert.equal(control.results.length, 8);
    for (const tier of ['scale-xs', 'scale-s'])
    {
        const articles = JSON.parse(fs.readFileSync(path.join(directory, `${tier}.json`)));
        assert.equal(articles.publicArticles.length > 0, true);
        if (tier === 'scale-xs')
        {
            assert.equal(articles.publicArticles.length, 1);
        }
        const comments = { sourceCommit, businessEpochUtc: articles.businessEpochUtc, dataScaleRunId: 'expected-control',
            fixtureGeneration: 'controlled-map', seedReceiptDigest: articles.seedReceiptDigest, visibleComments: [] };
        const canaries = {};
        const model = { tier, articlePlanDigest: articles.planDigest, articleGraphDigest: articles.graphDigest,
            publicArticles: articles.publicArticles, visibleComments: [], categories: articles.categories, tags: articles.tags, canaries };
        const binding = { sourceCommit, businessEpochUtc: articles.businessEpochUtc, dataScaleRunId: comments.dataScaleRunId,
            fixtureGeneration: comments.fixtureGeneration, seedReceiptDigest: comments.seedReceiptDigest, expectedModelDigest: computeSha256(model) };
        assert.deepEqual(mapCanonicalQueryExpectedModel({ articles, comments, canaries, binding }), model);
        assert.throws(() => mapCanonicalQueryExpectedModel({ articles: { ...articles, sourceCommit: 'a'.repeat(40) }, comments, canaries, binding }));
        assert.throws(() => mapCanonicalQueryExpectedModel({ articles: { ...articles, dataScaleRunId: 'other-run' }, comments, canaries, binding }));
        assert.throws(() => mapCanonicalQueryExpectedModel({ articles: { ...articles, fixtureGeneration: 'other-generation' }, comments, canaries, binding }));
        assert.throws(() => mapCanonicalQueryExpectedModel({ articles: { ...articles, seedReceiptDigest: computeSha256('other-seed') }, comments, canaries, binding }));
        assert.throws(() => mapCanonicalQueryExpectedModel({ articles, comments: { ...comments, fixtureGeneration: 'different' }, canaries, binding }));
        assert.throws(() => mapCanonicalQueryExpectedModel({ articles, comments, canaries: { commentArticleId: 999 }, binding }));
    }
});
