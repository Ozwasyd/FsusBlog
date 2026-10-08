import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { inspectComposeModel, inspectGateway, inspectPolicyGeneration, parseGatewayDirectives } from './asset-security-static.mjs';
import { loadAssetSecurityContract } from './asset-security-contract.mjs';

const contract = loadAssetSecurityContract(fs.readFileSync(new URL('../../config/security/asset-security-contract.json', import.meta.url)));
const read = source => fs.readFileSync(new URL(`../../${source}`, import.meta.url));
const gateway = read(contract.gateway.source).toString();
const publicPolicy = JSON.parse(read(contract.policy.input));

test('actual gateway parses structurally and retains internal/private and dedicated/public boundaries', () =>
{
    assert.deepEqual(inspectGateway(contract, gateway).errors, []);
});
test('missing internal cannot become successful private sending', () =>
{
    assert.ok(inspectGateway(contract, gateway.replace('            internal;', '')).errors.some(error => error.startsWith('asset.private.internal:')));
});
test('unregistered alias and root fail independently of comments and quoted security headers', () =>
{
    for (const directive of ['alias /isolated/private/;', 'root /isolated/session/;'])
    {
        assert.ok(inspectGateway(contract, gateway + `\nserver { location /unregistered/ { ${directive} } }`).errors.some(error => error.startsWith('asset.static.exact-one:')));
    }
    assert.deepEqual(parseGatewayDirectives('# root /ignored;\nserver { add_header X-Test "root /quoted;"; }')[0].children[0].args, ['X-Test', 'root /quoted;']);
});
test('unclosed gateway syntax is rejected', () => assert.throws(() => parseGatewayDirectives('server { location / { alias /outside; }'), /unclosed/));
test('public dedicated branch cannot become default proxy', () =>
{
    assert.ok(inspectGateway(contract, gateway.replace(`location ^~ ${contract.gateway.publicLocation}`, 'location /other/')).errors.some(error => error.startsWith('asset.public.pipeline:')));
});
test('native structured mount model rejects webroot and nonpublic gateway roots', () =>
{
    assert.equal(inspectComposeModel({ services: { app: { volumes: [{ source: 'isolated-assets', target: '/app/wwwroot/uploads', type: 'volume' }] } } }, 'mutation.yml').errors.length, 1);
    assert.equal(inspectComposeModel({ services: { openresty: { volumes: [{ source: '/isolated/assets/private', target: '/private', type: 'bind', read_only: true }] } } }, 'mutation.yml').errors.length, 1);
    const safe = inspectComposeModel({ services: { app: { volumes: [{ source: 'isolated-storage', target: '/app/storage', type: 'volume' }] } } }, 'mutation.yml');
    assert.deepEqual(safe.errors, []);
    assert.equal(safe.mounts[0].mode, 'rw');
});
test('current policy outputs match and independently changed docs/config fail', () =>
{
    assert.deepEqual(inspectPolicyGeneration(contract, read).errors, []);
    for (const changed of contract.policy.outputs)
    {
        const modified = source => source === changed ? Buffer.from(read(source).toString().replace(source === contract.gateway.source ? `limit_req zone=fsus_public_asset_limit burst=${publicPolicy.gateway.burst}` : `${publicPolicy.kestrel.permitLimit} requests`, 'drift')) : read(source);
        assert.ok(inspectPolicyGeneration(contract, modified).errors.length > 0);
    }
});
