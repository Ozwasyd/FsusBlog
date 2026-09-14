import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const { extractCurrentVersion } = await import(new URL('../../tools/governance/dependency-freshness.mjs', import.meta.url));
function fixture(t, { range = '^1.0.0', locked = '1.2.0', lockRange = range } = {})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-npm-current-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { example: range } }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { dependencies: { example: lockRange } }, 'node_modules/example': { version: locked } }
    }));
    const item = { id: 'example', manager: 'npm', packageName: 'example', files: ['package.json', 'package-lock.json'], fieldPaths: ['/dependencies/example'] };
    return { root, item };
}

test('current npm identity is locked resolution, not range lower bound or wildcard', t =>
{
    for (const range of ['^1.0.0', '~1.2.0', '*'])
    {
        const { root, item } = fixture(t, { range });
        assert.equal(extractCurrentVersion(root, item, {}), '1.2.0');
    }
});

test('manifest drift and missing lock identity fail rather than using an allowed range', t =>
{
    const drift = fixture(t, { lockRange: '^0.9.0' });
    assert.throws(() => extractCurrentVersion(drift.root, drift.item, {}), /manifest-drift/);
    const missing = fixture(t, { locked: '' });
    assert.throws(() => extractCurrentVersion(missing.root, missing.item, {}), /version-missing/);
    const unowned = fixture(t);
    unowned.item.files = ['package.json'];
    assert.throws(() => extractCurrentVersion(unowned.root, unowned.item, {}), /lockfile-not-owned/);
});

test('packageManager is a tool pin, and every declared source must agree', t =>
{
    const { root } = fixture(t);
    for (const [file, version] of [['package.json', '11.0.0'], ['other/package.json', '11.1.0']])
    {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), JSON.stringify({ packageManager: `npm@${version}` }));
    }
    const item = { id: 'runtime-npm', manager: 'npm', packageName: 'npm', files: ['package.json'], fieldPaths: ['/packageManager'] };
    assert.equal(extractCurrentVersion(root, item, {}), '11.0.0');
    item.files.push('other/package.json');
    assert.throws(() => extractCurrentVersion(root, item, {}), /current-versions-disagree/);
});

test('override resolutions use the selected parent and do not require overrides in lock root metadata', t =>
{
    const { root, item } = fixture(t);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ overrides: { parent: { example: '^2.0.0' } } }));
    const lock = { lockfileVersion: 3, packages: {
        '': {}, 'node_modules/parent': { version: '1.0.0' },
        'node_modules/example': { version: '1.2.0' },
        'node_modules/parent/node_modules/example': { version: '2.1.0' }
    } };
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
    item.fieldPaths = ['/overrides/parent/example'];
    assert.equal(extractCurrentVersion(root, item, {}), '2.1.0');
    delete lock.packages['node_modules/parent/node_modules/example'];
    lock.packages['node_modules/example'].version = '2.2.0';
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
    assert.equal(extractCurrentVersion(root, item, {}), '2.2.0');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ overrides: { example: '^2.0.0' } }));
    item.fieldPaths = ['/overrides/example'];
    lock.packages['node_modules/parent/node_modules/example'] = { version: '2.1.0' };
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
    assert.throws(() => extractCurrentVersion(root, item, {}), /current-versions-disagree/);
});
