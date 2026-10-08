import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { scanDataScaleLegacyWrites } = await import(
    new URL('../../tools/governance/check-data-scale-legacy-writes.mjs', import.meta.url)
);

function fixture(context)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-scale-legacy-writes-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'tools/data-scale'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools/data-scale/seed.sh'), '#!/usr/bin/env bash\n');
    fs.writeFileSync(path.join(root, 'tools/data-scale/cleanup.sh'), '#!/usr/bin/env bash\n');
    return root;
}

test('residual diagnostic allows observations without implying runtime acceptance', (context) =>
{
    const root = fixture(context);
    fs.appendFileSync(path.join(root, 'tools/data-scale/seed.sh'), 'redis-cli GET version\nSELECT count(*) FROM article;\n');
    const result = scanDataScaleLegacyWrites(root);
    assert.equal(result.status, 'clear');
    assert.deepEqual(result.violations, []);
    assert.equal(result.sources.length, 2);
    assert.ok(result.sources.every((source) => /^sha256:[a-f0-9]{64}$/u.test(source.digest)));
    assert.equal(Object.hasOwn(result, 'terminalReceipt'), false);
});

for (const [rule, mutation] of [
    ['private-article-write', 'INSERT INTO article_revision(article_id) VALUES (1);'],
    ['private-article-write', 'UPDATE article SET status = 2;'],
    ['status-modulo', 'WHEN gs % 20 = 0 THEN 4'],
    ['manual-derived-write', 'INSERT INTO article_public_taxonomy_projection(article_id) VALUES (1);'],
    ['manual-redis-write', 'docker exec "$redis_container" redis-cli INCR version'],
    ['guessed-owned-article-rows', "SELECT id FROM article WHERE title LIKE (SELECT prefix || ':article:%');"],
    ['sentinel-hash', "SELECT 'recompute' AS policy_hash;"],
    ['private-policy-hash', "SELECT sha256(convert_to('data-scale-policy:' || id, 'UTF8'));"],
    ['private-article-write', 'insert\ninto "article_rights_snapshot"(article_id) VALUES (1);']
])
{
    test(`residual diagnostic rejects ${rule}: ${mutation}`, (context) =>
    {
        const root = fixture(context);
        fs.appendFileSync(path.join(root, 'tools/data-scale/seed.sh'), `\n${mutation}\n`);
        const result = scanDataScaleLegacyWrites(root);
        assert.equal(result.status, 'failed');
        assert.ok(result.violations.some((violation) => violation.rule === rule && violation.line === 3));
    });
}

test('scan includes newly introduced scale scripts rather than only seed', (context) =>
{
    const root = fixture(context);
    fs.mkdirSync(path.join(root, 'tests/tools/scale/nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests/tools/scale/nested/fallback.sql'), 'DELETE FROM article;\n');
    const result = scanDataScaleLegacyWrites(root);
    assert.equal(result.status, 'failed');
    assert.ok(result.violations.some((violation) => violation.file === 'tests/tools/scale/nested/fallback.sql'));
});

test('missing active entry and linked source fail closed', (context) =>
{
    const root = fixture(context);
    fs.rmSync(path.join(root, 'tools/data-scale/cleanup.sh'));
    assert.ok(scanDataScaleLegacyWrites(root).violations.some((violation) => violation.rule === 'missing-entry'));
    fs.symlinkSync(path.join(root, 'tools/data-scale/seed.sh'), path.join(root, 'tools/data-scale/linked.sh'));
    assert.throws(() => scanDataScaleLegacyWrites(root), /data_scale_scan_symlink_refused/u);
});

test('source byte drift changes the bound diagnostic digest', (context) =>
{
    const root = fixture(context);
    const before = scanDataScaleLegacyWrites(root);
    fs.appendFileSync(path.join(root, 'tools/data-scale/seed.sh'), '# changed source\n');
    const after = scanDataScaleLegacyWrites(root);
    assert.notDeepEqual(before.sources, after.sources);
});
