import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadAssetSecurityContract } from './asset-security-contract.mjs';

const bytes = fs.readFileSync(new URL('../../config/security/asset-security-contract.json', import.meta.url));

test('sole input validates and keeps policy values in the public policy owner', () =>
{
    const contract = loadAssetSecurityContract(bytes);
    assert.equal(contract.schemaVersion, 1);
    assert.equal('permitLimit' in contract.policy, false);
    assert.equal('headers' in contract.policy, false);
    assert.equal(contract.identity.canonicalTables.includes(contract.identity.referenceTable), true);
});

for (const [name, change] of [
    ['private mapping', value => value.staticMappings[0].rootClassification = 'private'],
    ['session mapping', value => value.staticMappings[0].rootClassification = 'session'],
    ['commit mapping', value => value.staticMappings[0].rootClassification = 'commit'],
    ['duplicate mapping', value => value.staticMappings.push({ ...value.staticMappings[0], id: 'duplicate' })],
    ['duplicate root', value => value.roots[1].property = value.roots[0].property],
    ['missing root class', value => value.roots[1].classification = value.roots[0].classification],
    ['missing reference owner', value => value.identity.referenceTable = 'unregistered_reference_table'],
    ['second rate policy', value => value.policy.permitLimit = 1],
    ['path escape', value => value.assetServiceSources[0] = 'src/../../../outside'],
    ['missing owner', value => value.staticMappings[0].source = 'src/backend/nonexistent.cs'],
    ['extra field', value => value.unregistered = true]
])
{
    test(`input rejects ${name}`, () =>
    {
        const contract = JSON.parse(bytes);
        change(contract);
        assert.throws(() => loadAssetSecurityContract(Buffer.from(JSON.stringify(contract))), /asset_security_contract_invalid/);
    });
}
