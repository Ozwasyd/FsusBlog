import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {computeStaticClientPayloadInventory, parsePositiveFiniteSafeBudget, resolveStaticPayloadBudgetExecution} = await import(new URL('../../tools/operations/static-client-payload-budget.mjs', import.meta.url));
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const authorityScript = path.join(repositoryRoot, 'tools/operations/static-client-payload-budget.mjs');
const assetScript = path.join(repositoryRoot, 'tests/frontend/checks/static/check-asset-size-budget.mjs');
const publishScript = path.join(repositoryRoot, 'tools/operations/check-publish-artifact-slimness.mjs');
const schemaPath = path.join(repositoryRoot, 'config/schemas/static-client-payload-budget.schema.json');
const canonicalPolicy = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'config/performance/static-client-payload-budget.v1.json'),
    'utf8'
));

function cleanBudgetEnvironment()
{
    const env = { ...process.env };
    for (const name of Object.keys(env))
    {
        if (name.startsWith('FSUSBLOG_ASSET_')
        || name.startsWith('FSUSBLOG_PUBLISH_')
        || name === 'FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE')
        {
            delete env[name];
        }
    }
    return env;
}

function runNode(args, options = {})
{
    return spawnSync(process.execPath, args, {
        cwd: options.cwd ?? repositoryRoot,
        env: options.env ?? cleanBudgetEnvironment(),
        encoding: 'utf8'
    });
}

function writePolicy(file, baseline)
{
    const policy = structuredClone(canonicalPolicy);
    policy.baseline = baseline;
    fs.writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`);
}

test('inventory checker binds client-dist root, byte-order records, count, bytes, and same-size content digest', (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-static-payload-inventory-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const dist = path.join(directory, 'dist');
    fs.mkdirSync(path.join(dist, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'z.txt'), 'ab');
    fs.writeFileSync(path.join(dist, 'nested', 'é.txt'), 'cd');

    const inventory = computeStaticClientPayloadInventory(dist);
    assert.equal(inventory.root, 'client-dist');
    assert.equal(inventory.pathOrder, 'posix-relative-utf8-byte-ascending');
    assert.equal(inventory.recordFormat, 'path-utf8 NUL size-base10-ascii NUL content-sha256-lowerhex LF');
    assert.equal(inventory.fileCount, 2);
    assert.equal(inventory.totalBytes, 4);

    const policyPath = path.join(directory, 'policy.json');
    writePolicy(policyPath, inventory);
    const accepted = runNode([authorityScript, '--root', dist, '--check', '--policy', policyPath, '--schema', schemaPath]);
    assert.equal(accepted.status, 0, accepted.stderr);

    fs.writeFileSync(path.join(dist, 'z.txt'), 'zz');
    const tampered = runNode([authorityScript, '--root', dist, '--check', '--policy', policyPath, '--schema', schemaPath]);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /inventorySha256 mismatch/u);
});

test('canonical schema validation rejects invalid config and a schema that admits closed-contract mutations', (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-static-payload-schema-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const invalidPolicy = structuredClone(canonicalPolicy);
    invalidPolicy.baseline.fileCount = 0;
    const invalidPolicyPath = path.join(directory, 'invalid-policy.json');
    fs.writeFileSync(invalidPolicyPath, `${JSON.stringify(invalidPolicy)}\n`);
    const invalidConfig = runNode([
        authorityScript,
        '--validate-config',
        '--policy', invalidPolicyPath,
        '--schema', schemaPath
    ]);
    assert.notEqual(invalidConfig.status, 0);
    assert.match(invalidConfig.stderr, /violates its schema/u);

    const laxSchemaPath = path.join(directory, 'lax-schema.json');
    fs.writeFileSync(laxSchemaPath, `${JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object'
    })}\n`);
    const invalidSchema = runNode([
        authorityScript,
        '--validate-config',
        '--schema', laxSchemaPath
    ]);
    assert.notEqual(invalidSchema.status, 0);
    assert.match(invalidSchema.stderr, /accepted a required negative mutation/u);
});

test('budget parsing rejects empty, nonnumeric, infinite, nonpositive, fractional, and unsafe values', () =>
{
    for (const invalid of ['', 'not-a-number', 'Infinity', '0', '-1', '1.5', '9007199254740992'])
    {
        assert.throws(
            () => parsePositiveFiniteSafeBudget(invalid, 'TEST_BUDGET'),
            /positive finite safe/u
        );
    }
    assert.throws(
        () => parsePositiveFiniteSafeBudget('0.5', 'TEST_MIB', { multiplier: 1024 * 1024 }),
        /positive finite safe integer/u
    );
    assert.equal(parsePositiveFiniteSafeBudget('2', 'TEST_MIB', { multiplier: 1024 * 1024 }), 2 * 1024 * 1024);
});

test('overrides require explicit diagnostic mode and diagnostic evidence is ineligible for qualification', () =>
{
    assert.throws(
        () => resolveStaticPayloadBudgetExecution({ TEST_BUDGET: '1' }, ['TEST_BUDGET']),
        /require FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE=diagnostic/u
    );
    assert.throws(
        () => resolveStaticPayloadBudgetExecution({
            FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE: 'authoritative',
            TEST_BUDGET: '1'
        }, ['TEST_BUDGET']),
        /require FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE=diagnostic/u
    );
    assert.deepEqual(resolveStaticPayloadBudgetExecution({
        FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE: 'diagnostic',
        TEST_BUDGET: '1'
    }, ['TEST_BUDGET']), {
        mode: 'diagnostic',
        overrideApplied: true,
        overrideKeys: ['TEST_BUDGET'],
        qualificationEligible: false
    });
});

test('both gates fail closed on malformed overrides without writing null-success evidence', (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-static-payload-invalid-override-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const dist = path.join(directory, 'dist');
    fs.mkdirSync(dist);

    for (const [index, invalid] of ['', 'not-a-number', 'Infinity', '0', '-1', '1.5', '9007199254740992'].entries())
    {
        const evidenceDir = path.join(directory, `asset-${index}`);
        const assetEnv = cleanBudgetEnvironment();
        Object.assign(assetEnv, {
            FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE: 'diagnostic',
            FSUSBLOG_ASSET_TOTAL_BUDGET_BYTES: invalid,
            FSUSBLOG_FRONTEND_DIST_ROOT: dist,
            FSUSBLOG_FRONTEND_OUTPUT_ROOT: evidenceDir
        });
        const asset = runNode([assetScript], {
            cwd: path.join(repositoryRoot, 'src/frontend'),
            env: assetEnv
        });
        assert.notEqual(asset.status, 0);
        assert.equal(fs.existsSync(path.join(evidenceDir, 'asset-size-budget.json')), false);

        const publishEnv = cleanBudgetEnvironment();
        Object.assign(publishEnv, {
            FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE: 'diagnostic',
            FSUSBLOG_PUBLISH_WWWROOT_MAX_MIB: invalid
        });
        const publish = runNode([publishScript, '--self-test'], { env: publishEnv });
        assert.notEqual(publish.status, 0);
    }
});

test('diagnostic asset override is marked ineligible while authoritative gate paths reject overrides', (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-static-payload-mode-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const dist = path.join(directory, 'dist');
    const evidenceDir = path.join(directory, 'evidence');
    fs.mkdirSync(dist);
    const diagnosticEnv = cleanBudgetEnvironment();
    Object.assign(diagnosticEnv, {
        FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE: 'diagnostic',
        FSUSBLOG_ASSET_TOTAL_BUDGET_BYTES: '1',
        FSUSBLOG_FRONTEND_DIST_ROOT: dist,
        FSUSBLOG_FRONTEND_OUTPUT_ROOT: evidenceDir
    });
    const diagnostic = runNode([assetScript], {
        cwd: path.join(repositoryRoot, 'src/frontend'),
        env: diagnosticEnv
    });
    assert.equal(diagnostic.status, 0, diagnostic.stderr);
    const evidence = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'asset-size-budget.json'), 'utf8'));
    assert.equal(evidence.budgetAuthority.overrideApplied, true);
    assert.equal(evidence.budgetAuthority.qualificationEligible, false);

    const authoritativeEnv = cleanBudgetEnvironment();
    Object.assign(authoritativeEnv, {
        FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE: 'authoritative',
        FSUSBLOG_PUBLISH_WWWROOT_MAX_MIB: '81'
    });
    const authoritative = runNode([publishScript, '--self-test'], { env: authoritativeEnv });
    assert.notEqual(authoritative.status, 0);

    const authoritativeAssetEnv = cleanBudgetEnvironment();
    Object.assign(authoritativeAssetEnv, {
        FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE: 'authoritative',
        FSUSBLOG_ASSET_TOTAL_BUDGET_BYTES: '1',
        FSUSBLOG_FRONTEND_DIST_ROOT: dist,
        FSUSBLOG_FRONTEND_OUTPUT_ROOT: evidenceDir
    });
    const authoritativeAsset = runNode([assetScript], {
        cwd: path.join(repositoryRoot, 'src/frontend'),
        env: authoritativeAssetEnv
    });
    assert.notEqual(authoritativeAsset.status, 0);

    const diagnosticPublishOut = path.join(directory, 'publish-summary.json');
    const diagnosticPublishEnv = cleanBudgetEnvironment();
    Object.assign(diagnosticPublishEnv, {
        FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE: 'diagnostic',
        FSUSBLOG_PUBLISH_MAX_FILE_COUNT: '1'
    });
    const diagnosticPublish = runNode([
        publishScript,
        '--publish-dir', path.join(directory, 'missing-publish'),
        '--out', diagnosticPublishOut
    ], { env: diagnosticPublishEnv });
    assert.equal(diagnosticPublish.status, 0, diagnosticPublish.stderr);
    const publishEvidence = JSON.parse(fs.readFileSync(diagnosticPublishOut, 'utf8'));
    assert.equal(publishEvidence.budgetAuthority.overrideApplied, true);
    assert.equal(publishEvidence.budgetAuthority.qualificationEligible, false);

    const releaseLane = fs.readFileSync(path.join(repositoryRoot, 'tools/test/lanes/release-evidence.sh'), 'utf8');
    const suiteSupport = fs.readFileSync(path.join(repositoryRoot, 'tools/test/lanes/_suite-support.sh'), 'utf8');
    const productionBundle = fs.readFileSync(path.join(repositoryRoot, 'tools/test/bundles/run-bundle.mjs'), 'utf8');
    assert.match(releaseLane, /FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE=authoritative[\s\\]+.*check-publish-artifact-slimness/u);
    assert.match(suiteSupport, /FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE=authoritative[\s\S]{0,200}run-command-manifest/u);
    assert.match(productionBundle, /FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE=authoritative node tools\/test\/local-static-governance\.mjs/u);
});

test('frontend and publish gates enforce the baseline file-count ceiling', (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-static-payload-file-count-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const dist = path.join(directory, 'dist');
    const evidenceDir = path.join(directory, 'evidence');
    fs.mkdirSync(dist);
    for (let index = 0; index <= canonicalPolicy.baseline.fileCount; index += 1)
    {
        fs.writeFileSync(path.join(dist, String(index)), '');
    }
    const assetEnv = cleanBudgetEnvironment();
    Object.assign(assetEnv, {
        FSUSBLOG_FRONTEND_DIST_ROOT: dist,
        FSUSBLOG_FRONTEND_OUTPUT_ROOT: evidenceDir
    });
    const asset = runNode([assetScript], {
        cwd: path.join(repositoryRoot, 'src/frontend'),
        env: assetEnv
    });
    assert.notEqual(asset.status, 0);
    const evidence = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'asset-size-budget.json'), 'utf8'));
    assert.ok(evidence.violations.some((violation) => violation.budgetFileCount === canonicalPolicy.baseline.fileCount));

    const publish = runNode([publishScript, '--self-test']);
    assert.equal(publish.status, 0, publish.stderr);
});
