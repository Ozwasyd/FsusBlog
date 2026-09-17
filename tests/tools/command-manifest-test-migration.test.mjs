import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ledger = JSON.parse(fs.readFileSync(
    path.join(root, 'tests/governance/command-manifest-test-migration.json'),
    'utf8'
));

function titles(source)
{
    return [...source.matchAll(/\btest\(\s*(['"])(.*?)\1/gu)].map((match) => match[2]);
}

function idFor(file, title)
{
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-|-$/gu, '');
    return `node-test:${file}#${slug}`;
}

test('command-manifest migration ledger covers every historical test ID and resolves every replacement', () =>
{
    assert.equal(ledger.schema, 'fsusblog.command-manifest-test-migration.v1');
    assert.match(ledger.baselineCommit, /^[0-9a-f]{40}$/u);

    const replacementIds = new Set();
    for (const source of ledger.sources)
    {
        const historical = execFileSync('git', ['show', `${ledger.baselineCommit}:${source.path}`], {
            cwd: root,
            encoding: 'utf8'
        });
        assert.deepEqual(
            new Set(source.tests.map((entry) => entry.before)),
            new Set(titles(historical)),
            `${source.path} ledger must classify every historical test title exactly once`
        );
        for (const entry of source.tests)
        {
            assert.ok(['keep-static-contract', 'replace-source-mirror'].includes(entry.disposition));
            assert.ok(entry.replacementTestIds.length > 0, `${source.path}#${entry.before} needs a replacement`);
            entry.replacementTestIds.forEach((id) => replacementIds.add(id));
        }
    }

    for (const reduction of ledger.reductions)
    {
        const historicalTitles = new Set(titles(execFileSync(
            'git',
            ['show', `${ledger.baselineCommit}:${reduction.path}`],
            { cwd: root, encoding: 'utf8' }
        )));
        const currentTitles = new Set(titles(fs.readFileSync(path.join(root, reduction.path), 'utf8')));
        for (const entry of reduction.tests)
        {
            assert.ok(historicalTitles.has(entry.before), `unknown reduced test: ${reduction.path}#${entry.before}`);
            assert.equal(currentTitles.has(entry.before), false, `reduced test still exists: ${reduction.path}#${entry.before}`);
            assert.ok(entry.replacementTestIds.length > 0);
            entry.replacementTestIds.forEach((id) => replacementIds.add(id));
        }
    }

    const currentIds = new Set();
    for (const file of [
        'tests/tools/command-manifest-behavior.test.mjs',
        'tests/tools/local-static-governance.test.mjs',
        'tests/tools/privacy-zk-contract.test.mjs',
        'tests/tools/release-evidence-shell-contract.test.mjs',
        'tests/tools/supply-chain-audit-contract.test.mjs'
    ])
    {
        for (const title of titles(fs.readFileSync(path.join(root, file), 'utf8')))
        {
            currentIds.add(idFor(file, title));
        }
    }
    for (const replacementId of replacementIds)
    {
        assert.ok(currentIds.has(replacementId), `missing migration replacement: ${replacementId}`);
    }
});
