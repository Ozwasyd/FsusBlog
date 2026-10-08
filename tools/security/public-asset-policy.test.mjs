import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { generatePublicAssetPolicy, renderPublicAssetGateway } from './public-asset-policy.mjs';

const bytes = fs.readFileSync(new URL('../../config/security/public-asset-delivery.json', import.meta.url));
const config = fs.readFileSync(new URL('../../ops/gateway/production-openresty.conf', import.meta.url), 'utf8');

test('generated gateway uses policy, is repeatable, and changes with actual policy input', () =>
{
    const original = generatePublicAssetPolicy(bytes);
    assert.equal(renderPublicAssetGateway(config, original), config);
    const changed = JSON.parse(bytes);
    changed.gateway.requestsPerSecond++;
    const updated = generatePublicAssetPolicy(Buffer.from(JSON.stringify(changed)));
    assert.notEqual(original.inputSha256, updated.inputSha256);
    assert.match(updated.zones, new RegExp(`rate=${changed.gateway.requestsPerSecond}r/s`));
    assert.notEqual(renderPublicAssetGateway(config, updated), config);
    assert.match(updated.location, /proxy_pass http:\/\/fsusblog_kestrel/);
    assert.doesNotMatch(updated.location, /alias|root |valid_referers/);
});

for (const [name, change] of [
    ['negative rate', policy => policy.gateway.requestsPerSecond = -1],
    ['zero bandwidth', policy => policy.gateway.rateBytesPerSecond = 0],
    ['large burst', policy => policy.gateway.burst = 1001],
    ['unknown MIME', policy => policy.mediaTypes['.png'] = 'text/html'],
    ['queue', policy => policy.kestrel.queueLimit = 1],
    ['extra key', policy => policy.unknown = true]
])
{
    test(`policy schema rejects ${name}`, () =>
    {
        const policy = JSON.parse(bytes);
        change(policy);
        assert.throws(() => generatePublicAssetPolicy(Buffer.from(JSON.stringify(policy))), /public_asset_delivery_policy_invalid/);
    });
}
