import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scriptPath = 'tools/security/check-production-network-baseline.sh';
const composePath = 'ops/docker/docker-compose.production.yml';
const gatewayPath = 'ops/gateway/production-openresty.conf';
const fixturePaths = [
    scriptPath,
    composePath,
    gatewayPath,
    'ops/gateway/active-upstream.conf.example',
    'config/examples/.env.production.example'
];

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-network-baseline-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const relativePath of fixturePaths)
    {
        const target = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(repositoryRoot, relativePath), target);
    }
    return root;
}

function replace(root, relativePath, before, after)
{
    const target = path.join(root, relativePath);
    const source = fs.readFileSync(target, 'utf8');
    assert.ok(source.includes(before), `missing fixture fragment in ${relativePath}`);
    fs.writeFileSync(target, source.replace(before, after));
}

function run(root)
{
    return spawnSync('bash', [path.join(root, scriptPath)], {
        encoding: 'utf8',
        env: { ...process.env, FSUSBLOG_SKIP_PRODUCTION_EXPOSURE_TOOL_TEST: '1' },
        timeout: 10_000
    });
}

test('production network baseline accepts the current private asset topology', (t) =>
{
    const result = run(fixture(t));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[production-network-baseline\] ok/u);
});

const refusals = [
    {
        name: 'unmounted shared storage',
        path: composePath,
        before: '- fsus-storage:/app/storage',
        after: '- fsus-storage:/app/other',
        failure: /single shared app storage mount/u
    },
    {
        name: 'wrong host storage root',
        path: composePath,
        before: 'device: /var/lib/fsusblog/storage',
        after: 'device: /var/lib/fsusblog/other',
        failure: /shared storage host root/u
    },
    {
        name: 'missing host-backed volume declaration',
        path: composePath,
        before: '    fsus-storage:\n        name:',
        after: '    fsus-other:\n        name:',
        failure: /host-backed shared storage volume/u
    },
    {
        name: 'direct private directory mount',
        path: composePath,
        before: '- fsus-storage:/app/storage',
        after: '- fsus-storage:/app/storage\n            - /host/private:/app/storage/shared/assets/private',
        failure: /direct private asset directory mount/u
    },
    {
        name: 'ticket path access logging',
        path: gatewayPath,
        before: 'location ^~ /assets/private/ {\n            access_log off;',
        after: 'location ^~ /assets/private/ {\n            access_log on;',
        failure: /ticket path access log disabled/u
    },
    {
        name: 'public private-byte alias',
        path: gatewayPath,
        before: 'location ^~ /_fsus/private-assets/ {\n            internal;',
        after: 'location ^~ /_fsus/private-assets/ {\n            # internal; outside an active directive',
        failure: /private alias internal guard/u
    },
    {
        name: 'wrong private-byte alias root',
        path: gatewayPath,
        before: 'alias /var/lib/fsusblog/storage/shared/assets/private/;',
        after: 'alias /var/lib/fsusblog/other/assets/private/;',
        failure: /private host-backed alias/u
    },
    {
        name: 'gateway application-root leak',
        path: gatewayPath,
        before: 'location ^~ /_fsus/private-assets/ {',
        after: 'location ^~ /_fsus/private-assets/ {\n            # PrivateAssetRoot is forbidden',
        failure: /application private root exposure in gateway/u
    },
    {
        name: 'duplicate private-byte alias location',
        path: gatewayPath,
        before: '        location / {',
        after: '        location ^~ /_fsus/private-assets/ {\n            internal;\n            alias /var/lib/fsusblog/storage/shared/assets/private/;\n        }\n\n        location / {',
        failure: /unique location \^~ \/_fsus\/private-assets\/ \{ location/u
    }
];

for (const refusal of refusals)
{
    test(`production network baseline rejects ${refusal.name}`, (t) =>
    {
        const root = fixture(t);
        replace(root, refusal.path, refusal.before, refusal.after);
        const result = run(root);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, refusal.failure);
    });
}
