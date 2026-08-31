import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { plan } from '../../tools/test-fixtures/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

test('security fixture ownership maps every capability to one producer and one canonical variant', () =>
{
    const ownership = readJson('config/testing/security-fixture-ownership.json');
    const capabilityCatalog = readJson('config/testing/fixture-capability-catalog.json');
    const producerCatalog = readJson('config/testing/fixture-producer-registry.json');
    const variants = readJson('config/testing/fixture-variant-catalog.json');
    const capabilities = capabilityCatalog.capabilities
        .filter((item) => item.ownerProducerId === 'security-state')
        .map((item) => item.id)
        .sort();
    assert.deepEqual(ownership.capabilities.map((item) => item.id), capabilities);
    const producer = producerCatalog.producers.find((item) => item.id === 'security-state');
    assert.deepEqual(producer.provides, capabilities);
    assert.deepEqual(producer.implementationPaths, ownership.implementationPaths);
    for (const capabilityId of capabilities)
    {
        assert.equal(variants.variants.filter((item) => item.capabilityId === capabilityId).length, 1);
    }
});

test('auth fixture source has no security-state ownership or security cleanup side effects', () =>
{
    const source = read('tests/frontend/support/session-fixtures.mjs');
    assert.match(source, /import \{ createHash, createHmac, randomBytes \} from 'node:crypto';/u);
    assert.match(source, /function signJwt[\s\S]*createHmac\('sha256', jwtSecret\)/u);
    assert.doesNotMatch(source, /producer security-state/u);
    assert.doesNotMatch(source, /(?:banreason|riskflags|anonymous_credential_status|anonymous_credential_issuance_audit|blacklist-user|runRedisCli)/u);
});

test('bootstrap and active lanes contain no default/global security reset', () =>
{
    const sources = [
        'tools/bootstrap-acceptance-env.sh',
        'tools/test/lanes/_suite-support.sh',
        'tools/test/run-mixed-performance-window.mjs'
    ].map(read).join('\n');
    assert.doesNotMatch(sources, /RESET_SECURITY_TEST_STATE|ResetSecurity(?:Runtime|Test)State|reset-security-runtime-state/u);
    assert.doesNotMatch(sources, /redis-cli[\s\S]{0,120}--scan[\s\S]{0,120}pow-risk/u);
    assert.doesNotMatch(sources, /DELETE\s+FROM\s+security_risk_event/iu);
});

test('none profile has zero security or other producer execution', () =>
{
    const none = plan({ profileId: 'none', profileSource: 'dev-cli' }, {
        runId: 'none-run',
        namespace: 'none-namespace'
    });
    assert.deepEqual(none.producers, []);
    assert.deepEqual(none.capabilities, []);
    assert.equal(none.requiresSecurityState, false);
});

test('clean is explicit and conflicts with every non-clean security capability', () =>
{
    const catalog = readJson('config/testing/fixture-capability-catalog.json');
    const security = catalog.capabilities.filter((item) => item.ownerProducerId === 'security-state');
    const clean = security.find((item) => item.id === 'security.clean');
    const nonClean = security.filter((item) => item.id !== 'security.clean').map((item) => item.id).sort();
    assert.deepEqual(clean.dependsOn, []);
    assert.deepEqual(clean.conflictsWith, nonClean);
    for (const capability of security.filter((item) => item.id !== 'security.clean'))
    {
        assert.deepEqual(capability.conflictsWith, ['security.clean']);
    }
});
