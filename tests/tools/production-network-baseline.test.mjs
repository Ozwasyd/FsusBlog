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
    },
    {
        name: 'private guard only in a nested location',
        path: gatewayPath,
        before: 'location ^~ /_fsus/private-assets/ {\n            internal;',
        after: 'location ^~ /_fsus/private-assets/ {\n            location /_fsus/private-assets/nested/ {\n                internal;\n            }',
        failure: /private alias internal guard/u
    },
    {
        name: 'ticket log guard only in a nested location',
        path: gatewayPath,
        before: 'location ^~ /assets/private/ {\n            access_log off;',
        after: 'location ^~ /assets/private/ {\n            location /assets/private/nested/ {\n                access_log off;\n            }',
        failure: /ticket path access log disabled/u
    },
    {
        name: 'private alias only in a nested location',
        path: gatewayPath,
        before: '            alias /var/lib/fsusblog/storage/shared/assets/private/;',
        after: '            location /_fsus/private-assets/nested/ {\n                alias /var/lib/fsusblog/storage/shared/assets/private/;\n            }',
        failure: /private host-backed alias/u
    },
    {
        name: 'unrelated volume masking the wrong storage host root',
        path: composePath,
        before: '            device: /var/lib/fsusblog/storage\n    fsus-aot-cache:',
        after: '            device: /var/lib/fsusblog/other\n    unused-volume:\n        driver_opts:\n            device: /var/lib/fsusblog/storage\n    fsus-aot-cache:',
        failure: /shared storage host root/u
    },
    {
        name: 'extension masking the missing application storage mount',
        path: composePath,
        before: '- fsus-storage:/app/storage',
        after: '- fsus-aot-cache:/app/storage',
        additional: {
            before: 'services:',
            after: 'x-unused-mounts:\n    - fsus-storage:/app/storage\n\nservices:'
        },
        failure: /single shared app storage mount/u
    },
    {
        name: 'shared storage volume using a nonlocal driver',
        path: composePath,
        before: '        driver: local',
        after: '        driver: other',
        failure: /host-backed shared storage volume driver/u
    },
    {
        name: 'shared storage volume without the bind option',
        path: composePath,
        before: '            o: bind',
        after: '            o: other',
        failure: /host-backed shared storage volume bind option/u
    },
    {
        name: 'shared storage volume using a different type',
        path: composePath,
        before: '            type: none',
        after: '            type: other',
        failure: /host-backed shared storage volume type/u
    },
    {
        name: 'duplicate storage host root directives',
        path: composePath,
        before: '            device: /var/lib/fsusblog/storage',
        after: '            device: /var/lib/fsusblog/storage\n            device: /var/lib/fsusblog/storage',
        failure: /shared storage host root/u
    },
    {
        name: 'comment masking the application shared root',
        path: composePath,
        before: '- FSUSBLOG_SHARED_STORAGE_ROOT=/app/storage/shared',
        after: '- FSUSBLOG_SHARED_STORAGE_ROOT=/app/other # FSUSBLOG_SHARED_STORAGE_ROOT=/app/storage/shared',
        failure: /shared storage root outside WebRoot/u
    },
    {
        name: 'conflicting duplicate application shared root',
        path: composePath,
        before: '- FSUSBLOG_SHARED_STORAGE_ROOT=/app/storage/shared',
        after: '- FSUSBLOG_SHARED_STORAGE_ROOT=/app/storage/shared\n            - FSUSBLOG_SHARED_STORAGE_ROOT=/app/other',
        failure: /shared storage root outside WebRoot/u
    },
    {
        name: 'quoted conflicting duplicate application shared root',
        path: composePath,
        before: '- FSUSBLOG_SHARED_STORAGE_ROOT=/app/storage/shared',
        after: '- FSUSBLOG_SHARED_STORAGE_ROOT=/app/storage/shared\n            - "FSUSBLOG_SHARED_STORAGE_ROOT=/app/other"',
        failure: /shared storage root outside WebRoot/u
    },
    {
        name: 'conflicting duplicate application instance root',
        path: composePath,
        before: '- FSUSBLOG_INSTANCE_STORAGE_ROOT=/app/storage/instances',
        after: '- FSUSBLOG_INSTANCE_STORAGE_ROOT=/app/storage/instances\n            - FSUSBLOG_INSTANCE_STORAGE_ROOT=/app/other',
        failure: /instance storage root outside WebRoot/u
    },
    {
        name: 'conflicting storage mount destination',
        path: composePath,
        before: '- fsus-storage:/app/storage',
        after: '- fsus-storage:/app/storage\n            - fsus-aot-cache:/app/storage',
        failure: /single shared app storage mount/u
    },
    {
        name: 'quoted conflicting storage mount destination',
        path: composePath,
        before: '- fsus-storage:/app/storage',
        after: '- fsus-storage:/app/storage\n            - "fsus-aot-cache:/app/storage"',
        failure: /single shared app storage mount/u
    },
    {
        name: 'long syntax conflicting storage mount destination',
        path: composePath,
        before: '- fsus-storage:/app/storage',
        after: '- fsus-storage:/app/storage\n            - type: volume\n              source: fsus-aot-cache\n              target: /app/storage',
        failure: /single shared app storage mount/u
    },
    {
        name: 'conflicting duplicate storage device',
        path: composePath,
        before: '            device: /var/lib/fsusblog/storage',
        after: '            device: /var/lib/fsusblog/storage\n            device: /var/lib/fsusblog/other',
        failure: /shared storage host root/u
    },
    {
        name: 'additional public private-byte alias',
        path: gatewayPath,
        before: '        location / {',
        after: '        location /public-private-bytes/ {\n            alias /var/lib/fsusblog/storage/shared/assets/private/;\n        }\n\n        location / {',
        failure: /sole declared private physical alias/u
    },
    {
        name: 'additional storage root mapping',
        path: gatewayPath,
        before: '        location / {',
        after: '        location /public-storage/ {\n            root /var/lib/fsusblog/storage;\n        }\n\n        location / {',
        failure: /sole declared private physical alias/u
    },
    {
        name: 'nested ticket location overriding disabled logging',
        path: gatewayPath,
        before: 'location ^~ /assets/private/ {\n            access_log off;',
        after: 'location ^~ /assets/private/ {\n            access_log off;\n            location /assets/private/nested/ {\n                access_log /tmp/private-ticket.log combined;\n            }',
        failure: /ticket path access log disabled/u
    },
    {
        name: 'more specific ticket location overriding disabled logging',
        path: gatewayPath,
        before: '        location / {',
        after: '        location ^~ /assets/private/nested/ {\n            access_log /tmp/private-ticket.log combined;\n        }\n\n        location / {',
        failure: /ticket path access log disabled/u
    },
    {
        name: 'inline additional public private-byte alias',
        path: gatewayPath,
        before: '        location / {',
        after: '        location /public-private-bytes/ { alias /var/lib/fsusblog/storage/shared/assets/private/; }\n\n        location / {',
        failure: /sole declared private physical alias/u
    },
    {
        name: 'conflicting ticket access log directive',
        path: gatewayPath,
        before: 'location ^~ /assets/private/ {\n            access_log off;',
        after: 'location ^~ /assets/private/ {\n            access_log off;\n            access_log /tmp/private-ticket.log combined;',
        failure: /ticket path access log disabled/u
    },
    {
        name: 'unknown variable physical alias',
        path: gatewayPath,
        before: '        location / {',
        after: '        location /unknown-bytes/ {\n            alias /var/lib/fsusblog/storage/$unknown_asset_root;\n        }\n\n        location / {',
        failure: /sole declared private physical alias/u
    },
    {
        name: 'terminal dot segment private storage root',
        path: gatewayPath,
        before: '        location / {',
        after: '        location /shared/ { root /var/lib/fsusblog/storage/.; }\n\n        location / {',
        failure: /sole declared private physical alias/u
    },
    {
        name: 'intermediate dot segment private storage alias',
        path: gatewayPath,
        before: '        location / {',
        after: '        location /public-private-bytes/ { alias /var/lib/fsusblog/storage/./shared/assets/private/; }\n\n        location / {',
        failure: /sole declared private physical alias/u
    }
];

for (const refusal of refusals)
{
    test(`production network baseline rejects ${refusal.name}`, (t) =>
    {
        const root = fixture(t);
        replace(root, refusal.path, refusal.before, refusal.after);
        if (refusal.additional)
        {
            replace(root, refusal.path, refusal.additional.before, refusal.additional.after);
        }
        const result = run(root);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, refusal.failure);
    });
}

test('production network baseline ignores braces in location comments', (t) =>
{
    const root = fixture(t);
    replace(root, gatewayPath,
        'location ^~ /_fsus/private-assets/ {\n            internal;',
        'location ^~ /_fsus/private-assets/ {\n            # } { do not change active location nesting\n            internal;');
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
});

test('production network baseline permits unrelated literal public asset mappings', (t) =>
{
    const root = fixture(t);
    replace(root, gatewayPath, '        location / {',
        '        location /public-assets/ {\n            alias /var/lib/fsusblog/public/;\n        }\n\n        location / {');
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
});

const additionalMountSyntaxes = [
    {
        name: 'short',
        render: (target) => `            - fsus-aot-cache:${target}`
    },
    {
        name: 'quoted',
        render: (target) => `            - "fsus-aot-cache:${target}:ro"`
    },
    {
        name: 'long',
        render: (target) => `            - type: volume\n              source: fsus-aot-cache\n              target: ${target}`
    }
];

for (const syntax of additionalMountSyntaxes)
{
    for (const target of [
        '/app',
        '/app/storage/shared',
        '/app/storage/shared/assets',
        '/app/storage/shared/assets/private',
        '/app/storage/shared/assets/private/nested',
        '/app//storage/shared/./assets',
        '/app/storage/unrelated/../shared'
    ])
    {
        test(`production network baseline rejects ${syntax.name} mount shadow at ${target}`, (t) =>
        {
            const root = fixture(t);
            replace(root, composePath, '- fsus-storage:/app/storage',
                `- fsus-storage:/app/storage\n${syntax.render(target)}`);
            const result = run(root);
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.match(result.stderr, /private storage mount shadow/u);
        });
    }

    test(`production network baseline permits ${syntax.name} unrelated storage mount`, (t) =>
    {
        const root = fixture(t);
        replace(root, composePath, '- fsus-storage:/app/storage',
            `- fsus-storage:/app/storage\n${syntax.render('/app/storage/shared/public-assets')}`);
        const result = run(root);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /\[production-network-baseline\] ok/u);
    });
}

for (const key of ['target ', '"target"', "'target'"])
{
    for (const target of ['/app/storage/shared', '/app/storage/shared/public-assets'])
    {
        const shadowsPrivateRoot = target === '/app/storage/shared';
        test(`production network baseline ${shadowsPrivateRoot ? 'rejects' : 'permits'} long ${key} mount at ${target}`, (t) =>
        {
            const root = fixture(t);
            replace(root, composePath, '- fsus-storage:/app/storage',
                `- fsus-storage:/app/storage\n            - type: volume\n              source: fsus-aot-cache\n              ${key}: ${target}`);
            const result = run(root);
            assert.equal(result.status, shadowsPrivateRoot ? 1 : 0, result.stdout + result.stderr);
            if (shadowsPrivateRoot)
            {
                assert.match(result.stderr, /private storage mount shadow/u);
            }
            else
            {
                assert.match(result.stdout, /\[production-network-baseline\] ok/u);
            }
        });
    }
}

test('production network baseline rejects unknown long mount key syntax', (t) =>
{
    const root = fixture(t);
    replace(root, composePath, '- fsus-storage:/app/storage',
        '- fsus-storage:/app/storage\n            - type: volume\n              source: fsus-aot-cache\n              ? target\n              : /app/storage/shared');
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /private storage mount shadow/u);
});
