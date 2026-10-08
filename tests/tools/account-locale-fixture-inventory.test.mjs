import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { accountLocaleOwnershipPath, assertAccountLocaleOwnershipCurrent, deriveAccountLocaleOwnership, readAccountLocaleOwnershipSources } = await import(new URL('../../tools/test/account-locale-fixture-inventory.mjs', import.meta.url));
const { scanAccountAuthFixtureSources } = await import(new URL('../../tools/test/account-auth-fixture-source-scan.mjs', import.meta.url));
const sources = readAccountLocaleOwnershipSources();
const registryPath = 'config/testing/fixture-producer-registry.json';
const capabilitiesPath = 'config/testing/fixture-capability-catalog.json';
const consumersPath = 'config/testing/fixture-consumer-inventory.generated.json';
const owner = 'account-profile-preferences';
function changedJson(sourcePath, mutate)
{
    return sources.map((item) =>
    {
        if (item.path !== sourcePath)
        {
            return item;
        }
        const value = JSON.parse(item.source);
        mutate(value);
        return { ...item, source: JSON.stringify(value) };
    });
}

test('account source producer derives closed canonical mappings without runtime qualification', () =>
{
    const inventory = assertAccountLocaleOwnershipCurrent();
    assert.equal(inventory.capabilityOwners.length, 10);
    assert.equal(inventory.identityRoles.length, 11);
    assert.deepEqual(inventory.sourceApi.methods, ['CleanupAsync', 'PrepareAsync', 'VerifyAsync']);
    assert.equal(inventory.sourceApi.cleanupReturn, 'Task');
    assert.equal(inventory.qualification, false);
    assert.equal(inventory.notAuthoritative, true);
    assert.equal(inventory.profileBindings.length, 1);
    assert.deepEqual(inventory.consumers, []);
    const require = createRequire(new URL('../../tools/test-matrix/schema-validator/package.json', import.meta.url));
    const Ajv = require('ajv/dist/2020.js');
    const validate = new Ajv({ strict: true }).compile(JSON.parse(readFileSync(new URL('../../config/schemas/account-locale-fixture-ownership.schema.json', import.meta.url), 'utf8')));
    assert.equal(validate(inventory), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...inventory, cleanupVerified: true }), false);
});

const mutations = [
    ['duplicate producer', registryPath, (value) => value.producers.push(value.producers.find((item) => item.id === owner))],
    ['missing capability', registryPath, (value) => value.producers.find((item) => item.id === owner).provides.pop()],
    ['extra state domain', registryPath, (value) => value.producers.find((item) => item.id === owner).stateDomains.push('fake.device')],
    ['missing auth dependency', registryPath, (value) => value.producers.find((item) => item.id === owner).consumes.pop()],
    ['missing postcondition', registryPath, (value) => value.producers.find((item) => item.id === owner).receiptPostconditions.pop()],
    ['owner drift', capabilitiesPath, (value) =>
    {
        value.capabilities.find((item) => item.ownerProducerId === owner).ownerProducerId = 'auth-session';
    }],
    ['unknown verifier', capabilitiesPath, (value) =>
    {
        value.capabilities.find((item) => item.ownerProducerId === owner).postconditionIds = ['invented'];
    }],
    ['second implementation', consumersPath, (value) => value.producerImplementations.push({ producerId: owner, source: 'tools/fake.mjs' })],
    ['missing implementation', consumersPath, (value) =>
    {
        value.producerImplementations = value.producerImplementations.filter((item) => item.producerId !== owner);
    }]
];
for (const [name, sourcePath, mutate] of mutations)
{
    test(`source ownership rejects ${name}`, () => assert.throws(() => deriveAccountLocaleOwnership(changedJson(sourcePath, mutate))));
}

test('declared consumer capability and owner mapping is source derived and disagreement fails', () =>
{
    const consumer = { consumerId: 'account-test', source: 'tests/account.mjs', profileIds: ['account-profile-preferences'],
        requiredCapabilities: ['profile.public-handle.set'], producerOwners: [owner] };
    const modified = changedJson(consumersPath, (value) => value.consumers.push(consumer));
    const inventory = deriveAccountLocaleOwnership(modified);
    assert.deepEqual(inventory.consumers, [{ consumerId: consumer.consumerId, source: consumer.source, profileIds: consumer.profileIds,
        capabilityIds: consumer.requiredCapabilities, provenance: 'declared-canonical-consumer-inventory' }]);
    assert.equal(inventory.qualification, false);
    assert.throws(() => deriveAccountLocaleOwnership(changedJson(consumersPath, (value) => value.consumers.push({ ...consumer, producerOwners: ['auth-session'] }))));
    assert.throws(() => deriveAccountLocaleOwnership(changedJson(consumersPath, (value) => value.consumers.push(consumer, consumer))));
    assert.throws(() => deriveAccountLocaleOwnership(changedJson(consumersPath, (value) => value.consumers.push({ ...consumer, profileIds: ['auth-basic'] }))));
});

test('role parser excludes comments and refuses computed/duplicate identity declarations', () =>
{
    const producerPath = sources.find((item) => item.path.endsWith('account-profile-preference-producer.mjs')).path;
    const modify = (transform) => sources.map((item) => item.path === producerPath ? { ...item, source: transform(item.source) } : item);
    assert.deepEqual(deriveAccountLocaleOwnership(modify((source) => source + '\n// const identityRoles = Object.freeze(["fake"]);\n')).identityRoles,
        deriveAccountLocaleOwnership(sources).identityRoles);
    assert.throws(() => deriveAccountLocaleOwnership(modify((source) => source.replace("'profile-set'", 'computedRole'))));
    assert.throws(() => deriveAccountLocaleOwnership([...sources, sources[0]]));
    assert.throws(() => deriveAccountLocaleOwnership(sources.slice(1)));
});

test('void cleanup source contract cannot become a receipt-returning fake authority', () =>
{
    const modified = sources.map((item) => item.path.endsWith('AccountProfilePreferenceFixtureService.cs')
        ? { ...item, source: item.source.replace('Task CleanupAsync(', 'Task<FakeReceipt> CleanupAsync(') } : item);
    assert.throws(() => deriveAccountLocaleOwnership(modified));
});

test('runtime guard refuses source drift, inventory tampering and symlink before any mutation', () =>
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fsusblog-account-inventory-'));
    try
    {
        for (const item of sources)
        {
            const absolute = path.join(directory, item.path);
            mkdirSync(path.dirname(absolute), { recursive: true });
            writeFileSync(absolute, item.source);
        }
        const inventoryPath = path.join(directory, accountLocaleOwnershipPath);
        const inventory = deriveAccountLocaleOwnership(sources);
        writeFileSync(inventoryPath, JSON.stringify(inventory));
        assert.deepEqual(assertAccountLocaleOwnershipCurrent(directory), inventory);
        writeFileSync(inventoryPath, JSON.stringify({ ...inventory, qualification: true }));
        assert.throws(() => assertAccountLocaleOwnershipCurrent(directory), /inventory verification failed/u);
        writeFileSync(inventoryPath, JSON.stringify(inventory));
        writeFileSync(inventoryPath, '{privateKey: "private-parser-first-failure"}');
        assert.throws(() => assertAccountLocaleOwnershipCurrent(directory), (error) =>
        {
            assert.equal(error.message, 'account locale ownership inventory verification failed');
            assert.equal(JSON.stringify(error).includes('private-parser-first-failure'), false);
            assert.ok(error.cause instanceof Error);
            assert.match(error.verificationFailureDigest, /^sha256:[a-f0-9]{64}$/u);
            return true;
        });
        writeFileSync(inventoryPath, JSON.stringify(inventory));
        const sourcePath = path.join(directory, sources[0].path);
        writeFileSync(sourcePath, sources[0].source + '\n');
        assert.throws(() => assertAccountLocaleOwnershipCurrent(directory), /inventory verification failed/u);
        rmSync(sourcePath);
        symlinkSync('/etc/hostname', sourcePath);
        assert.throws(() => assertAccountLocaleOwnershipCurrent(directory), /inventory verification failed/u);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('scanner retains active code separately from documentation and test fixture literals', () =>
{
    const report = scanAccountAuthFixtureSources('account-locale', [
        { path: 'src/direct.ts', source: 'localStorage.setItem("locale", value);' },
        { path: 'docs/example.md', source: 'localStorage.setItem("locale", value);' },
        { path: 'tests/tools/negative.test.mjs', source: 'const negative = "localStorage.setItem(locale, value)";' }
    ]);
    assert.ok(report.violations.some((item) => item.sourceCategory === 'active-source' && item.syntaxContext === 'executable-expression'));
    assert.ok(report.violations.some((item) => item.sourceCategory === 'documentation'));
    assert.ok(report.violations.some((item) => item.sourceCategory === 'test-source' && item.syntaxContext === 'literal-data'));
    assert.equal('activeLegacyCount' in report, false);
    assert.equal('status' in report, false);
});
