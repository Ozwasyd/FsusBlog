import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { readLatestNpm, selectNpmRegistry } = await import(new URL('../../tools/governance/dependency-npm-registry.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('npm scope routing honors project config without changing the default registry', () =>
{
    const config = '@ozwasyd:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}';
    assert.equal(selectNpmRegistry('@ozwasyd/element-plus', [config]), 'https://npm.pkg.github.com');
    assert.equal(selectNpmRegistry('vue', [config]), 'https://registry.npmjs.org');
    assert.equal(selectNpmRegistry('@ozwasyd/element-plus', [config, '@ozwasyd:registry=https://registry.npmjs.org/']), 'https://registry.npmjs.org');
});

test('registry routing rejects credential URLs and unknown destinations', () =>
{
    for (const url of ['https://other.example/', 'https://user:secret@npm.pkg.github.com/', 'http://registry.npmjs.org/', '${UNKNOWN_REGISTRY}'])
    {
        assert.throws(() => selectNpmRegistry('vue', [`registry=${url}`]), /registry_url_invalid/);
    }
});

test('repository scoped npm package sends token only to its configured GitHub registry', async () =>
{
    for (const name of ['@ozwasyd/element-plus', 'vue'])
    {
        const result = await readLatestNpm({ id: 'example', packageName: name, files: ['src/frontend/package.json'] }, root, async (url, headers) =>
        {
            const scoped = name.startsWith('@ozwasyd/');
            assert.equal(new URL(url).origin, scoped ? 'https://npm.pkg.github.com' : 'https://registry.npmjs.org');
            assert.equal(headers.Authorization, scoped ? 'Bearer simulation-token' : undefined);
            return { name, 'dist-tags': { latest: '1.5.1' }, time: { '1.5.1': '2026-01-01T00:00:00Z' } };
        }, 'simulation-token');
        assert.equal(result.latestStable, '1.5.1');
    }
});

test('wrong package metadata is rejected before accepting the release', async () =>
{
    await assert.rejects(readLatestNpm({ id: 'example', packageName: 'vue' }, root, async () => ({ name: 'other' })), /identity_mismatch/);
});
