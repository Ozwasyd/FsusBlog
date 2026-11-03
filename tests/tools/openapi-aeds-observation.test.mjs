import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { digestCatalog, loadCatalog } = await import(new URL("../../tools/contracts/behavior-contract-catalog.mjs", import.meta.url));
const { digestValue } = await import(new URL("../../tools/fact-extractors/lib/canonicalize.mjs", import.meta.url));
const { buildOpenApiFromMatrix, committedOpenApiPath, operationsFromOpenApi, readJson, loadProtocol } = await import(new URL("../../tools/contracts/lib/openapi-contracts.mjs", import.meta.url));
const { observationBuildSourcePaths, observationContentDigest, openApiProjectionTextFromObservationFile, observationToFactObservations, validateObservationAgainstProtocol, writeGeneratedOpenApiProjection } = await import(new URL("../../tools/contracts/lib/openapi-observation.mjs", import.meta.url));
const { extract: extractOpenApi } = await import(new URL("../../tools/fact-extractors/openapi-aeds/extract.mjs", import.meta.url));
const { loadRegistry, validateOwnershipAgainstBehaviorCatalog, root } = await import(new URL("../../tools/fact-extractors/registry.mjs", import.meta.url));
const { buildIdentitySchema, digestPath, resolveContainedPath, sealSourceIdentity, validateBuildIdentity } = await import(new URL('../../tools/fact-extractors/identity.mjs', import.meta.url));
const { validateMinimalContractBuildReceipt } = await import(new URL('../../tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs', import.meta.url));
const { runExtractor } = await import(new URL('../../tools/fact-extractors/runner.mjs', import.meta.url));
const { createRuntimeRoleMinimalV3Fixture } = await import(new URL('./support/runtime-role-minimal-v3-fixture.mjs', import.meta.url));

const observationRelative = '.tmp/contracts/openapi/api-aeds-observation.json';
const observedOpenApiRelative = '.tmp/contracts/openapi/fsusblog.openapi.observed.json';
const buildReceiptRelative = '.tmp/contracts/openapi/build-receipt.json';

function sha256(buffer)
{
    return createHash('sha256').update(buffer).digest('hex');
}

function writeObservation(repositoryRoot, observation)
{
    const protocol = {
        schemaVersion: 1,
        header: { size: 16, magic: '0x53444541', version: 2 },
        frameTypes: [
            { name: 'Unknown', value: 0 },
            { name: 'ArticleDetail', value: 2 },
            { name: 'ArticleWriteRequest', value: 100 },
            { name: 'MutationId', value: 241 },
            { name: 'ApiError', value: 251 },
            { name: 'Reserved177', value: 177 }
        ],
        retiredFrameValues: [{ value: 40, reason: 'legacy-test' }]
    };
    const catalog = { schema: 'fixture-behavior-catalog', contracts: [] };
    const endpointContent = {
        schema: 'fsusblog.aeds-endpoint-contracts.v2',
        protocol: 'AEDS',
        aedsVersion: 2,
        operations: []
    };
    const endpointDigest = sha256(Buffer.from(JSON.stringify(endpointContent), 'utf8'));
    const writeJson = (relative, value) =>
    {
        const absolute = path.join(repositoryRoot, relative);
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
    };
    for (const relative of observationBuildSourcePaths)
    {
        const absolute = path.join(repositoryRoot, relative);
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, `fixture source: ${relative}\n`);
    }
    writeJson('src/shared/Contracts/Validation/aeds-protocol.json', protocol);
    writeJson('config/contracts/behavior-contracts.json', catalog);
    writeJson('src/shared/Contracts/Validation/aeds-endpoint-contracts.json', {
        ...endpointContent,
        contentDigest: endpointDigest
    });
    observation.errorAuthority.catalogDigest = digestCatalog(catalog);
    observation.endpointContractAuthority.contentDigest = endpointDigest;
    observation.observationDigest = observationContentDigest(observation);
    const absolute = path.join(repositoryRoot, observationRelative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    const text = `${JSON.stringify(observation, null, 2)}\n`;
    writeFileSync(absolute, text);
    writeJson(observedOpenApiRelative, { openapi: '3.1.0', paths: {} });
    const sourceDigests = Object.fromEntries(observationBuildSourcePaths.map((relative) => [
        relative,
        sha256(readFileSync(path.join(repositoryRoot, relative)))
    ]));
    const artifactDigest = sha256(Buffer.from(text, 'utf8'));
    const receiptBody = {
        schema: 'fsusblog.openapi-observation-build-receipt.v1',
        artifactId: 'openapi-aeds-observation',
        observationPath: observationRelative,
        openapiPath: observedOpenApiRelative,
        observationDigest: observation.observationDigest,
        artifactDigest,
        openapiDigest: sha256(readFileSync(path.join(repositoryRoot, observedOpenApiRelative))),
        sourceDigests,
        sourceDigest: digestValue(sourceDigests),
        contractDigest: endpointDigest,
        errorCatalogDigest: observation.errorAuthority.catalogDigest,
        generatorDigest: sourceDigests['tools/contracts/lib/openapi-observation.mjs'],
        protocolDigest: sourceDigests['src/shared/Contracts/Validation/aeds-protocol.json'],
        configuration: 'Release'
    };
    const fullIdentity = {
        artifactId: receiptBody.artifactId,
        receiptDigest: digestValue(receiptBody),
        artifactDigest,
        sourceDigest: receiptBody.sourceDigest,
        contractDigest: receiptBody.contractDigest,
        errorCatalogDigest: receiptBody.errorCatalogDigest,
        generatorDigest: receiptBody.generatorDigest,
        protocolDigest: receiptBody.protocolDigest
    };
    writeJson(buildReceiptRelative, { ...receiptBody, buildIdentity: fullIdentity });
    return {
        absolute,
        artifactDigest,
        buildIdentity: {
            artifactId: fullIdentity.artifactId,
            receiptDigest: fullIdentity.receiptDigest,
            artifactDigest: fullIdentity.artifactDigest
        },
        text
    };
}

function identityFor(_observation, artifactDigest, overrides = {})
{
    return {
        artifactId: 'openapi-aeds-observation',
        receiptDigest: 'b'.repeat(64),
        artifactDigest,
        ...overrides
    };
}

// Synthetic bytes exercise the real receipt reader and runner, not compiled-host qualification.
function writeCanonicalObservation(repositoryRoot, observation)
{
    const legacy = writeObservation(repositoryRoot, observation);
    for (const relative of [
        'tools/fact-extractors/openapi-aeds/extract.mjs',
        'tools/fact-extractors/identity.mjs',
        'tools/fact-extractors/lib/canonicalize.mjs',
        'tools/contracts/behavior-contract-catalog.mjs',
        'tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs',
        'config/schemas/behavior-fact-extractor-registry.schema.json',
        'config/schemas/fact-observation-receipt.schema.json'
    ])
    {
        const target = path.join(repositoryRoot, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(path.join(root, relative), target);
    }
    writeFileSync(path.join(repositoryRoot, '.gitignore'), '.tmp/\n');
    const git = (...args) =>
    {
        const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    };
    git('init', '--quiet');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'isolated receipt unit fixture');
    const source = sealSourceIdentity(repositoryRoot);
    const receipt = createRuntimeRoleMinimalV3Fixture('canonical-openapi-unit', source);
    for (const artifact of Object.values(receipt.artifacts))
    {
        const project = path.join(repositoryRoot, artifact.project);
        mkdirSync(path.dirname(project), { recursive: true });
        writeFileSync(project, '<Project />\n');
    }
    const sourcePaths = [...new Set([
        ...observationBuildSourcePaths,
        ...Object.values(receipt.artifacts).map((artifact) => artifact.project),
        'tools/fact-extractors/identity.mjs',
        'tools/fact-extractors/lib/canonicalize.mjs',
        'tools/contracts/behavior-contract-catalog.mjs',
        'tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs'
    ])].sort();
    Object.assign(source, sealSourceIdentity(repositoryRoot));
    receipt.sourceCommit = source.sourceCommit;
    receipt.worktreeFingerprint = source.worktreeFingerprint;
    receipt.sourceClosureDigests = sourcePaths.map((relative) => ({ path: relative, digest: digestPath(repositoryRoot, relative) }));
    receipt.sourceDigest = digestValue(receipt.sourceClosureDigests);
    const oldKey = receipt.buildKey;
    receipt.buildKey = digestValue({ sourceIdentity: source, toolchain: receipt.toolchain, sourceClosureDigests: receipt.sourceClosureDigests });
    const replaceRoot = (value) => JSON.parse(JSON.stringify(value).replaceAll(oldKey, receipt.buildKey));
    receipt.buildRoot = replaceRoot(receipt.buildRoot);
    receipt.artifacts = replaceRoot(receipt.artifacts);
    const writeBytes = (relative, bytes) =>
    {
        const absolute = path.join(repositoryRoot, relative);
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, bytes);
        return sha256(Buffer.from(bytes));
    };
    for (const [artifactId, artifact] of Object.entries(receipt.artifacts))
    {
        artifact.projectDigest = digestPath(repositoryRoot, artifact.project);
        const bytes = artifactId === 'openapi-aeds-observation' ? legacy.text : '{"schema":"unit-fixture"}\n';
        artifact.artifactDigest = writeBytes(artifact.path, bytes);
        writeBytes(artifact.artifactPath, bytes);
        artifact.buildReceipt.artifactDigest = artifact.artifactDigest;
        if (artifact.assemblyPath)
        {
            artifact.assemblyDigest = writeBytes(artifact.assemblyPath, 'unit-fixture-assembly');
            artifact.deploymentArtifactDigest = writeBytes(artifact.deploymentArtifactPath, 'unit-fixture-deployment');
            Object.assign(artifact.buildReceipt, {
                sourceCommit: source.sourceCommit,
                worktreeFingerprint: source.worktreeFingerprint,
                projectDigest: artifact.projectDigest,
                assemblyDigest: artifact.assemblyDigest,
                deploymentArtifactDigest: artifact.deploymentArtifactDigest
            });
            artifact.buildReceipt.reproducibleBuild.assemblyDigest = artifact.assemblyDigest;
            artifact.buildReceipt.reproducibleBuild.sourceClosureDigest = digestValue(receipt.sourceClosureDigests);
        }
    }
    const artifact = receipt.artifacts['openapi-aeds-observation'];
    const projectionBytes = readFileSync(path.join(repositoryRoot, observedOpenApiRelative));
    Object.assign(artifact.buildReceipt, {
        openapiPath: `${receipt.buildRoot}/observations/fsusblog.openapi.observed.json`,
        openapiArtifactPath: observedOpenApiRelative,
        openapiDigest: writeBytes(`${receipt.buildRoot}/observations/fsusblog.openapi.observed.json`, projectionBytes)
    });
    receipt.contentDigest = null;
    receipt.contentDigest = digestValue(receipt);
    const receiptPath = `${receipt.buildRoot}/receipts/${receipt.runId}.json`;
    writeBytes(receiptPath, `${JSON.stringify(receipt)}\n`);
    const legacyReceipt = JSON.parse(readFileSync(path.join(repositoryRoot, buildReceiptRelative), 'utf8'));
    delete legacyReceipt.buildIdentity;
    legacyReceipt.sourceDigests = Object.fromEntries(observationBuildSourcePaths.map((relative) => [relative, digestPath(repositoryRoot, relative)]));
    legacyReceipt.sourceDigest = digestValue(legacyReceipt.sourceDigests);
    legacyReceipt.generatorDigest = legacyReceipt.sourceDigests['tools/contracts/lib/openapi-observation.mjs'];
    const legacyIdentity = {
        artifactId: legacyReceipt.artifactId,
        receiptDigest: digestValue(legacyReceipt),
        artifactDigest: legacyReceipt.artifactDigest,
        sourceDigest: legacyReceipt.sourceDigest,
        contractDigest: legacyReceipt.contractDigest,
        errorCatalogDigest: legacyReceipt.errorCatalogDigest,
        generatorDigest: legacyReceipt.generatorDigest,
        protocolDigest: legacyReceipt.protocolDigest
    };
    legacy.receipt = { ...legacyReceipt, buildIdentity: legacyIdentity };
    legacy.buildIdentity = { artifactId: legacyIdentity.artifactId, receiptDigest: legacyIdentity.receiptDigest, artifactDigest: legacyIdentity.artifactDigest };
    rmSync(path.join(repositoryRoot, buildReceiptRelative));
    return {
        receipt,
        legacy,
        context: {
            canonicalDigest: digestValue,
            minimalBuildServices: {
                buildIdentitySchema,
                digestPath,
                resolveContainedPath,
                validateBuildIdentity,
                validateMinimalContractBuildReceipt
            },
            repositoryRoot,
            ...source,
            buildReceiptPath: receiptPath,
            buildIdentity: {
                schema: 'fsusblog.build-identity.v1',
                artifactId: 'openapi-aeds-observation',
                receiptDigest: receipt.contentDigest,
                artifactDigest: artifact.artifactDigest,
                sourceDigests: receipt.sourceClosureDigests,
                sourceDigest: receipt.sourceDigest
            }
        }
    };
}

test('OpenAPI requires the runner canonical digest and seals its exact provider sources', (t) =>
{
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'openapi-capability-')));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const produced = writeObservation(directory, sampleObservation());
    const context = { repositoryRoot: directory, buildIdentity: produced.buildIdentity, canonicalDigest: digestValue };
    assert.equal(extractOpenApi(context).status, 'ok');
    const missing = extractOpenApi({ ...context, canonicalDigest: undefined });
    assert.equal(missing.status, 'failed');
    assert.match(missing.failureReasons.join('\n'), /runner-owned canonical digest/u);
    assert.deepEqual(missing.observations, {});
    for (const canonicalDigest of [null, 42, () => undefined, () => '0'.repeat(64)])
    {
        const incompatible = extractOpenApi({ ...context, canonicalDigest });
        assert.equal(incompatible.status, 'failed');
        assert.deepEqual(incompatible.observations, {});
    }
    assert.equal(digestValue(loadCatalog()), digestCatalog(loadCatalog()));
    for (const relative of ['tools/fact-extractors/runner.mjs', 'tools/fact-extractors/lib/canonicalize.mjs'])
    {
        assert.ok(observationBuildSourcePaths.includes(relative));
        const original = readFileSync(path.join(directory, relative));
        writeFileSync(path.join(directory, relative), `${original}\n// changed provider\n`);
        const changed = extractOpenApi(context);
        assert.equal(changed.status, 'failed');
        assert.match(changed.failureReasons.join('\n'), /source digest mismatch/u);
        assert.deepEqual(changed.observations, {});
        writeFileSync(path.join(directory, relative), original);
    }
});

test('OpenAPI refuses changed runner import resolution and resealed incomplete provider closure', (t) =>
{
    for (const mutation of ['runner-import', 'missing-runner', 'missing-canonicalizer', 'extra-provider'])
    {
        const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'openapi-provider-closure-')));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        writeObservation(directory, sampleObservation());
        const runnerRelative = 'tools/fact-extractors/runner.mjs';
        const canonicalizerRelative = 'tools/fact-extractors/lib/canonicalize.mjs';
        for (const relative of [runnerRelative, canonicalizerRelative])
        {
            cpSync(path.join(root, relative), path.join(directory, relative));
        }
        const buildIdentity = rewriteReceipt(directory, (receipt) =>
        {
            for (const relative of [runnerRelative, canonicalizerRelative])
            {
                receipt.sourceDigests[relative] = sha256(readFileSync(path.join(directory, relative)));
            }
            receipt.sourceDigest = digestValue(receipt.sourceDigests);
        });
        const context = { repositoryRoot: directory, buildIdentity, canonicalDigest: digestValue };
        assert.equal(extractOpenApi(context).status, 'ok', mutation);
        if (mutation === 'runner-import')
        {
            const runnerPath = path.join(directory, runnerRelative);
            const original = readFileSync(runnerPath, 'utf8');
            const changed = original.replace("from './lib/canonicalize.mjs'", "from './lib/alternate.mjs'");
            assert.notEqual(changed, original);
            cpSync(path.join(directory, canonicalizerRelative), path.join(directory, 'tools/fact-extractors/lib/alternate.mjs'));
            writeFileSync(runnerPath, changed);
        }
        else
        {
            context.buildIdentity = rewriteReceipt(directory, (receipt) =>
            {
                if (mutation === 'extra-provider')
                {
                    receipt.sourceDigests['tools/fact-extractors/lib/alternate.mjs'] = '0'.repeat(64);
                }
                else
                {
                    delete receipt.sourceDigests[mutation === 'missing-runner' ? runnerRelative : canonicalizerRelative];
                }
                receipt.sourceDigest = digestValue(receipt.sourceDigests);
            });
        }
        const result = extractOpenApi(context);
        assert.equal(result.status, 'failed', mutation);
        assert.match(result.failureReasons.join('\n'), mutation === 'runner-import' ? /source digest mismatch/u : /source set is invalid/u);
        assert.deepEqual(result.observations, {}, mutation);
        // Repeated consumption must preserve the refusal without accepting partial observations.
        assert.deepEqual(extractOpenApi(context), result, mutation);
    }
});

test('canonical OpenAPI refuses missing validation capabilities and runner cache before extraction', async (t) =>
{
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'openapi-minimal-capability-')));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const { context } = writeCanonicalObservation(directory, sampleObservation());
    assert.equal(extractOpenApi(context).status, 'ok');
    for (const key of ['buildIdentitySchema', 'digestPath', 'resolveContainedPath',
        'validateBuildIdentity', 'validateMinimalContractBuildReceipt'])
    {
        const result = extractOpenApi({ ...context, minimalBuildServices: { ...context.minimalBuildServices, [key]: undefined } });
        assert.equal(result.status, 'failed', key);
        assert.match(result.failureReasons.join('\n'), /validation capability is missing/u);
        assert.deepEqual(result.observations, {});
    }
    const registry = structuredClone(loadRegistry());
    registry.extractors = registry.extractors.filter((extractor) => extractor.id === 'openapi-aeds-fact-extractor');
    registry.extractors[0].consumedInputs = context.buildIdentity.sourceDigests.map((source) => source.path);
    const options = {
        extractorId: 'openapi-aeds-fact-extractor',
        repositoryRoot: directory,
        registry,
        buildIdentity: context.buildIdentity,
        buildReceiptPath: context.buildReceiptPath,
        useCache: false
    };
    await assert.rejects(runExtractor(options), /uncached canonical minimal-build receipt validation/u);
    await assert.rejects(runExtractor({ ...options, minimalBuildReceiptValidator: validateMinimalContractBuildReceipt, useCache: true }),
        /uncached canonical minimal-build receipt validation/u);
});

test('canonical OpenAPI runner consumes the run-relative minimal receipt without a fixed sidecar', async (t) =>
{
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'openapi-canonical-runner-')));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const { context } = writeCanonicalObservation(directory, sampleObservation());
    const registry = structuredClone(loadRegistry());
    registry.extractors = registry.extractors.filter((extractor) => extractor.id === 'openapi-aeds-fact-extractor');
    registry.extractors[0].consumedInputs = context.buildIdentity.sourceDigests.map((source) => source.path);
    const { receipt } = await runExtractor({
        extractorId: 'openapi-aeds-fact-extractor',
        repositoryRoot: directory,
        registry,
        buildIdentity: context.buildIdentity,
        buildReceiptPath: context.buildReceiptPath,
        minimalBuildReceiptValidator: validateMinimalContractBuildReceipt,
        useCache: false
    });
    assert.equal(receipt.status, 'ok', JSON.stringify(receipt));
    assert.deepEqual(receipt.buildIdentity, context.buildIdentity);
    assert.equal(receipt.observations.operationCount, 2);
});

test('canonical OpenAPI rejects cached and published observation byte tampering independently', (t) =>
{
    for (const field of ['path', 'artifactPath'])
    {
        const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'openapi-canonical-observation-')));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const { context, receipt } = writeCanonicalObservation(directory, sampleObservation());
        const initial = extractOpenApi(context);
        assert.equal(initial.status, 'ok', initial.failureReasons.join('\n'));
        writeFileSync(path.join(directory, receipt.artifacts['openapi-aeds-observation'][field]), '{"tampered":true}\n');
        const result = extractOpenApi(context);
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /artifact digest mismatch/u);
    }
});

test('canonical OpenAPI rejects cached and published projection byte tampering independently', (t) =>
{
    for (const field of ['openapiPath', 'openapiArtifactPath'])
    {
        const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'openapi-canonical-projection-')));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const { context, receipt } = writeCanonicalObservation(directory, sampleObservation());
        const initial = extractOpenApi(context);
        assert.equal(initial.status, 'ok', initial.failureReasons.join('\n'));
        writeFileSync(path.join(directory, receipt.artifacts['openapi-aeds-observation'].buildReceipt[field]), '{"tampered":true}\n');
        const result = extractOpenApi(context);
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /projection.*digest mismatch/u);
    }
});

test('canonical OpenAPI preserves observation and current authority checks after artifact resealing', (t) =>
{
    for (const [mutate, expected] of [
        [(value) =>
        {
            value.observationDigest = '0'.repeat(64);
        }, /observationDigest/u],
        [(value) =>
        {
            value.endpointContractAuthority.contentDigest = '0'.repeat(64);
            value.observationDigest = observationContentDigest(value);
        }, /endpoint contract content digest/u],
        [(value) =>
        {
            value.errorAuthority.catalogDigest = '0'.repeat(64);
            value.observationDigest = observationContentDigest(value);
        }, /error authority catalog digest/u]
    ])
    {
        const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'openapi-canonical-resealed-')));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const { context, receipt } = writeCanonicalObservation(directory, sampleObservation());
        const artifact = receipt.artifacts['openapi-aeds-observation'];
        const observation = JSON.parse(readFileSync(path.join(directory, artifact.path), 'utf8'));
        mutate(observation);
        const bytes = `${JSON.stringify(observation)}\n`;
        for (const file of [artifact.path, artifact.artifactPath])
        {
            writeFileSync(path.join(directory, file), bytes);
        }
        artifact.artifactDigest = sha256(Buffer.from(bytes));
        artifact.buildReceipt.artifactDigest = artifact.artifactDigest;
        receipt.contentDigest = null;
        receipt.contentDigest = digestValue(receipt);
        writeFileSync(path.join(directory, context.buildReceiptPath), `${JSON.stringify(receipt)}\n`);
        context.buildIdentity.artifactDigest = artifact.artifactDigest;
        context.buildIdentity.receiptDigest = receipt.contentDigest;
        const result = extractOpenApi(context);
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), expected);
    }
});

test('canonical OpenAPI refuses receipt drift and unsafe paths without falling back to a valid legacy receipt', (t) =>
{
    for (const mutate of [
        (context) =>
        {
            context.buildReceiptPath = null;
        },
        (context) =>
        {
            context.buildReceiptPath = '../outside.json';
        },
        (context) =>
        {
            context.buildIdentity.receiptDigest = '0'.repeat(64);
        },
        (context) =>
        {
            context.sourceCommit = '0'.repeat(40);
        },
        (context) =>
        {
            context.worktreeFingerprint = '0'.repeat(64);
        },
        (context, directory) =>
        {
            const target = path.join(directory, `${context.buildReceiptPath}.link`);
            symlinkSync(path.join(directory, context.buildReceiptPath), target);
            context.buildReceiptPath += '.link';
        },
        (context, directory) =>
        {
            const target = `${context.buildReceiptPath}.another-run`;
            cpSync(path.join(directory, context.buildReceiptPath), path.join(directory, target));
            context.buildReceiptPath = target;
        }
    ])
    {
        const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'openapi-canonical-no-fallback-')));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const { context, legacy } = writeCanonicalObservation(directory, sampleObservation());
        // Recreate a genuine legacy unit receipt before presenting an invalid canonical context.
        writeFileSync(path.join(directory, buildReceiptRelative), `${JSON.stringify(legacy.receipt)}\n`);
        const standalone = extractOpenApi({ canonicalDigest: digestValue, repositoryRoot: directory, buildIdentity: legacy.buildIdentity });
        assert.equal(standalone.status, 'ok', standalone.failureReasons.join('\n'));
        mutate(context, directory);
        const result = extractOpenApi(context);
        assert.equal(result.status, 'failed');
        assert.deepEqual(result.observations, {});
    }
});

function rewriteReceipt(repositoryRoot, mutate)
{
    const absolute = path.join(repositoryRoot, buildReceiptRelative);
    const receipt = JSON.parse(readFileSync(absolute, 'utf8'));
    mutate(receipt);
    const body = { ...receipt };
    delete body.buildIdentity;
    receipt.buildIdentity = {
        artifactId: body.artifactId,
        receiptDigest: digestValue(body),
        artifactDigest: body.artifactDigest,
        sourceDigest: body.sourceDigest,
        contractDigest: body.contractDigest,
        errorCatalogDigest: body.errorCatalogDigest,
        generatorDigest: body.generatorDigest,
        protocolDigest: body.protocolDigest
    };
    writeFileSync(absolute, `${JSON.stringify(receipt, null, 2)}\n`);
    return {
        artifactId: receipt.buildIdentity.artifactId,
        receiptDigest: receipt.buildIdentity.receiptDigest,
        artifactDigest: receipt.buildIdentity.artifactDigest
    };
}

function sampleObservation(overrides = {})
{
    const emptyBounds = () => ({
        minimum: null, maximum: null, minLength: null, maxLength: null,
        minItems: null, maxItems: null, minProperties: null, maxProperties: null
    });
    const typed = (operation) =>
    {
        const body = operation.requestFrame != null;
        const properties = body
            ? {
                metadata: {
                    name: 'metadata', type: 'object', required: false, nullable: true,
                    format: null, schemaRef: 'clr://FsusBlog.Shared.Contracts.ArticleMetadata',
                    itemType: null, itemSchemaRef: null, item: null, enumValues: [], bounds: emptyBounds()
                },
                title: {
                    name: 'title', type: 'string', required: true, nullable: false,
                    format: null, schemaRef: null, itemType: null, itemSchemaRef: null, item: null,
                    enumValues: [], bounds: { ...emptyBounds(), minLength: 1, maxLength: 200 }
                }
            }
            : {};
        const definitions = body
            ? {
                'FsusBlog.Shared.Contracts.ArticleMetadata': {
                    typeIdentity: 'FsusBlog.Shared.Contracts.ArticleMetadata',
                    requiredFields: ['category'],
                    properties: {
                        category: {
                            name: 'category', type: 'string', required: true, nullable: false,
                            format: null, schemaRef: null, itemType: null, itemSchemaRef: null, item: null,
                            enumValues: [], bounds: emptyBounds()
                        }
                    },
                    oneOf: [], discriminator: null, bounds: {}
                }
            }
            : {};
        const statuses = operation.publicErrorStatuses;
        const request = {
            direction: 'request',
            source: body ? 'aeds-frame-body' : 'none',
            schemaRef: body ? `aeds://request-schema/${operation.operationId}` : null,
            encoding: body ? 'binary-layout' : 'none',
            required: body,
            nullable: false,
            requiredFields: body ? ['title'] : [],
            parameters: body ? [
                {
                    name: 'X-Fsus-Pow-Proof', direction: 'request', source: 'header',
                    schemaRef: 'header://string', required: true, nullable: false,
                    bounds: emptyBounds(),
                    evidence: ['compiled-endpoint-filter:RequiresPowFilter']
                },
                {
                    name: 'dryRun', direction: 'request', source: 'query',
                    schemaRef: 'query://boolean', required: false, nullable: false,
                    bounds: emptyBounds(),
                    evidence: ['compiled-handler-parameter:dryRun']
                }
            ] : [
                {
                    name: 'id', direction: 'request', source: 'path',
                    schemaRef: 'path://int', required: true, nullable: false,
                    bounds: emptyBounds(),
                    evidence: ['compiled-route-template:id']
                }
            ],
            properties,
            definitions,
            oneOf: [],
            discriminator: null,
            bounds: body ? { title: properties.title.bounds } : {},
            fieldSetState: body ? 'closed' : 'not-applicable',
            boundsState: body ? 'closed' : 'not-applicable',
            unionState: body ? 'none' : 'not-applicable',
            schemaDigest: null,
            sourceTypes: body ? ['FsusBlog.Shared.Contracts.ArticleWriteRequest'] : [],
            readerIdentities: body ? ['FsusBlog.Server.Infrastructure.Binary.IBinaryEndpointRequestContext.ReadFrameAsync'] : []
        };
        if (body)
        {
            request.schemaDigest = sha256(Buffer.from(JSON.stringify({
                direction: request.direction,
                schemaRef: request.schemaRef,
                requestFrame: operation.requestFrame,
                encoding: request.encoding,
                parameters: request.parameters,
                requiredFields: request.requiredFields,
                properties: request.properties,
                definitions: request.definitions,
                oneOf: request.oneOf,
                discriminator: request.discriminator,
                bounds: request.bounds,
                sourceTypes: request.sourceTypes,
                readerIdentities: request.readerIdentities
            })));
        }
        return {
            ...operation,
            request,
            responses: [
                {
                    status: operation.successStatus, kind: 'success', schemaRef: `aeds://frame/${operation.responseFrame}`,
                    contentType: 'application/octet-stream', resultPlacement: 'aeds.frame.payload', nullable: false,
                    publicErrorRef: null
                },
                ...statuses.map((status) => ({
                    status, kind: 'error', schemaRef: 'aeds://frame/ApiError',
                    contentType: 'application/octet-stream', resultPlacement: 'aeds.frame.payload', nullable: false,
                    publicErrorRef: `configuration-error-security-policy:error-transport-mappings:${status}`
                }))
            ],
            publicErrorRefs: statuses.map((status) => `configuration-error-security-policy:error-transport-mappings:${status}`),
            publicErrorStatusEvidence: Object.fromEntries(statuses.map((status) => [String(status), [`compiled-test:${status}`]])),
            publicErrorRefState: 'operation-status-authority-bound',
            errorAuthorityBehaviorId: 'configuration-error-security-policy',
            resultPlacement: 'aeds.frame.payload',
            protocolState: 'active-aeds-only'
        };
    };
    return {
        schema: 'fsusblog.api-aeds-observation.v5',
        protocol: 'AEDS',
        aedsVersion: 2,
        operationCount: 2,
        operationKeys: [
            'GET /api/binary/article/{id}.aeds',
            'POST /api/binary/admin/article'
        ],
        observationDigest: 'a'.repeat(64),
        protocolStates: {
            supportedVersions: [2], activeFrameIds: ['ApiError', 'ArticleDetail', 'ArticleWriteRequest', 'MutationId'],
            retiredFrameValues: [40], migrationOnlyFrameIds: ['Reserved177'], aedsOnly: true
        },
        errorAuthority: {
            behaviorId: 'configuration-error-security-policy',
            catalogDigest: 'c'.repeat(64),
            documentPath: 'docs/api/schemas-and-errors.md',
            factIds: ['facts.error-codes.domain.active', 'facts.error-codes.transport-mapping']
        },
        endpointContractAuthority: {
            schema: 'fsusblog.aeds-endpoint-contracts.v2',
            documentPath: 'src/shared/Contracts/Validation/aeds-endpoint-contracts.json',
            contentDigest: 'd'.repeat(64)
        },
        operations: [
            typed({
                method: 'GET',
                path: '/api/binary/article/{id}.aeds',
                operationId: 'binary_get_article_id_aeds',
                protocol: 'AEDS',
                aedsVersion: 2,
                requestFrame: null,
                responseFrame: 'ArticleDetail',
                errorFrame: 'ApiError',
                auth: 'anonymous',
                permission: 'none',
                pow: false,
                rateLimit: 'public_read',
                cache: 'public-read',
                successStatus: 200,
                publicErrorStatuses: [404, 406, 500]
            }),
            typed({
                method: 'POST',
                path: '/api/binary/admin/article',
                operationId: 'binary_post_admin_article',
                protocol: 'AEDS',
                aedsVersion: 2,
                requestFrame: 'ArticleWriteRequest',
                responseFrame: 'MutationId',
                errorFrame: 'ApiError',
                auth: 'admin',
                permission: 'article.write',
                pow: true,
                rateLimit: 'fixed_ip',
                cache: 'no-store',
                successStatus: 200,
                publicErrorStatuses: [400, 401, 403, 406, 415, 500]
            })
        ],
        ...overrides
    };
}

test('registry owns binary-api-aeds-contract via openapi-aeds-fact-extractor', () =>
{
    const registry = loadRegistry();
    const result = validateOwnershipAgainstBehaviorCatalog(registry, loadCatalog(), root);
    assert.equal(result.behaviorOwners.get('binary-api-aeds-contract'), 'openapi-aeds-fact-extractor');
    const extractor = registry.extractors.find((entry) => entry.id === 'openapi-aeds-fact-extractor');
    assert.equal(extractor.kind, 'compiled-assembly');
    assert.equal(extractor.hermeticPolicy, 'exact-build-receipt');
    assert.equal(extractor.requiredBuildArtifact, 'openapi-aeds-observation');
});

test('compiled C# observation self-test executes real loader, merger, and request observer negatives', {
    timeout: 120_000
}, () =>
{
    const result = spawnSync('dotnet', [
        'run',
        '--project',
        'tools/contracts/FsusBlog.OpenApiObservation/FsusBlog.OpenApiObservation.csproj',
        '-c',
        'Release',
        '--',
        '--self-test'
    ], {
        cwd: root,
        encoding: 'utf8',
        env: process.env
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /self-test.*ok/iu);
});

test('pre-3177 normal producer isolates only the exact owned JSON routes and emits the AEDS observation', {
    timeout: 120_000
}, () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-production-census-'));
    try
    {
        const result = spawnSync('dotnet', [
            'run',
            '--project',
            'tools/contracts/FsusBlog.OpenApiObservation/FsusBlog.OpenApiObservation.csproj',
            '-c',
            'Release',
            '--no-build',
            '--',
            '--output',
            path.join(directory, 'observation.json'),
            '--repository-root',
            root
        ], {
            cwd: root,
            encoding: 'utf8',
            env: process.env
        });
        const diagnostic = `${result.stdout}\n${result.stderr}`;
        assert.equal(result.status, 0, diagnostic);
        assert.match(diagnostic, /pre-#3177 known non-AEDS routes excluded count=8:/u);
        const observation = readJson(path.join(directory, 'observation.json'));
        assert.ok(observation.operations.some((operation) =>
            operation.operationId === 'binary_get_article_articleId_int_related_aeds'
            && operation.responseFrame === 'ArticleRelatedReading'));
        assert.ok(observation.operations.every((operation) =>
            !operation.path.startsWith('/api/binary/author/ops/fonts/')
            && !operation.path.startsWith('/api/binary/author/ops/themes/')));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('checked-in OpenAPI projection declares compiled observation authority', () =>
{
    const openapi = readJson(committedOpenApiPath);
    assert.equal(openapi['x-fsus-contract-source']?.observation, 'compiled-endpoint-metadata');
    assert.equal(openapi['x-fsus-contract-source']?.matrix, undefined);
    assert.ok(openapi['x-fsus-observation-digest']);
    const operations = operationsFromOpenApi(openapi);
    assert.ok(operations.length >= 200);
    for (const op of operations)
    {
        assert.equal(op.operation['x-fsus-protocol'], 'AEDS');
        assert.ok(op.operationId, `${op.key} missing operationId`);
    }
});

test('public article-list operations retain the compiled optional query contract', () =>
{
    const openapi = readJson(committedOpenApiPath);
    const paths = [
        '/api/binary/article/list/archive/{page:int}/{size:int}.aeds',
        '/api/binary/article/list/category/{categoryId:int}/{page:int}/{size:int}.aeds',
        '/api/binary/article/list/home/{page:int}/{size:int}.aeds',
        '/api/binary/article/list/tag/{tagId:int}/{page:int}/{size:int}.aeds'
    ];

    for (const route of paths)
    {
        const parameters = openapi.paths[route].get['x-fsus-request-contract'].Parameters;
        assert.deepEqual(
            parameters
                .filter((parameter) => parameter.Source === 'query')
                .map((parameter) => ({
                    Name: parameter.Name,
                    SchemaRef: parameter.SchemaRef,
                    Required: parameter.Required,
                    Nullable: parameter.Nullable
                })),
            [
                { Name: 'cursor', SchemaRef: 'query://string', Required: false, Nullable: true },
                { Name: 'keyword', SchemaRef: 'query://string', Required: false, Nullable: true },
                { Name: 'sort', SchemaRef: 'query://string', Required: false, Nullable: true }
            ],
            route
        );
    }
});

test('buildOpenApiFromMatrix is retired and cannot re-enter as authority', () =>
{
    assert.throws(() => buildOpenApiFromMatrix(), /retired|compiled endpoint observation/iu);
});

test('1) deleting an endpoint while retaining OpenAPI fails observation validation set equality helpers', () =>
{
    const observation = sampleObservation();
    observation.operations = observation.operations.filter((op) => op.method !== 'POST');
    observation.operationCount = 1;
    observation.operationKeys = ['GET /api/binary/article/{id}.aeds'];
    // Projection retains POST — bidirectional set compare must surface drift.
    const openapi = readJson(committedOpenApiPath);
    const projectionKeys = new Set(
        operationsFromOpenApi(openapi).map((op) => `${op.method} ${op.fullPath}`)
    );
    const observedKeys = new Set(observation.operationKeys);
    const missing = [...projectionKeys].filter((key) => !observedKeys.has(key));
    assert.ok(missing.length > 0);
});

test('2) missing operationId fails extractor', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'));
    try
    {
        const observation = sampleObservation();
        observation.operations[0].operationId = '';
        const sealed = writeObservation(directory, observation);
        const result = extractOpenApi({ canonicalDigest: digestValue,
            repositoryRoot: directory,
            buildIdentity: sealed.buildIdentity
        });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /missing operationId|duplicate/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('3) auth drift is visible in observation map fields', () =>
{
    const observation = sampleObservation();
    observation.operations[1].auth = 'user';
    const facts = observationToFactObservations(observation);
    assert.equal(facts.operations.binary_post_admin_article.auth, 'user');
    assert.notEqual(facts.operations.binary_post_admin_article.auth, 'admin');
});

test('4) rate-limit and cache metadata are required observation fields', () =>
{
    const observation = sampleObservation();
    delete observation.operations[0].rateLimit;
    const errors = validateObservationAgainstProtocol(observation, loadProtocol());
    assert.ok(errors.some((error) => /rateLimit/u.test(error)));
});

test('5) response frame must exist in aeds-protocol.json', () =>
{
    const observation = sampleObservation();
    observation.operations[0].responseFrame = 'NotARealFrame';
    const errors = validateObservationAgainstProtocol(observation, loadProtocol());
    assert.ok(errors.some((error) => /NotARealFrame/u.test(error)));
});

test('6) source regex is not used for qualification in binary-contract-matrix source', () =>
{
    const source = readFileSync(
        path.join(root, 'tests/frontend/checks/runtime/binary-contract-matrix.mjs'),
        'utf8'
    );
    assert.doesNotMatch(source, /extractBackendBinaryRoutesFromSource\s*\(/u);
    assert.match(source, /source-regex non-qualifying|MUST NOT participate/u);
});

test('7) ambient bin/Debug identity is refused by extractor', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'));
    try
    {
        const observation = sampleObservation();
        const sealed = writeObservation(directory, observation);
        const result = extractOpenApi({ canonicalDigest: digestValue,
            repositoryRoot: directory,
            buildIdentity: identityFor(observation, sealed.artifactDigest, {
                path: 'src/backend/bin/Debug/net10.0/FsusBlog.Server.dll'
            })
        });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /bin\/Debug|bin\/Release|ambient/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('8) reverse generation markers from checked-in OpenAPI fail closed', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'));
    try
    {
        const observation = sampleObservation({
            source: 'checked-in-openapi',
            generatedFromCheckedInOpenApi: true
        });
        const sealed = writeObservation(directory, observation);
        const result = extractOpenApi({ canonicalDigest: digestValue,
            repositoryRoot: directory,
            buildIdentity: sealed.buildIdentity
        });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /reverse-generated|checked-in OpenAPI/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('9) duplicate method/path fails extractor', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'));
    try
    {
        const observation = sampleObservation();
        observation.operations.push({ ...observation.operations[0], operationId: 'binary_get_article_id_aeds_dup' });
        observation.operationCount = 3;
        const sealed = writeObservation(directory, observation);
        const result = extractOpenApi({ canonicalDigest: digestValue,
            repositoryRoot: directory,
            buildIdentity: sealed.buildIdentity
        });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /duplicate method\/path/u);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('extractor accepts sealed observation and emits operation map', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'));
    try
    {
        const observation = sampleObservation();
        const sealed = writeObservation(directory, observation);
        const result = extractOpenApi({ canonicalDigest: digestValue,
            repositoryRoot: directory,
            buildIdentity: sealed.buildIdentity
        });
        assert.equal(result.status, 'ok');
        assert.equal(result.observations.operationCount, 2);
        assert.equal(result.observations.operations.binary_post_admin_article.auth, 'admin');
        assert.equal(result.observations.operations.binary_post_admin_article.pow, true);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

function writeMinimalBuildObservation(repositoryRoot, observation)
{
    return writeCanonicalObservation(repositoryRoot, observation).context;
}

test('canonical minimal build observation uses its exact source and artifact receipt without a standalone receipt', (t) =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-minimal-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const context = writeMinimalBuildObservation(directory, sampleObservation());
    const result = extractOpenApi(context);
    assert.equal(result.status, 'ok', result.failureReasons?.join('; '));
    assert.equal(result.observations.operationCount, 2);
    assert.equal(result.observations.operations.binary_post_admin_article.pow, true);
    for (const changed of [
        { buildReceiptPath: undefined },
        { buildReceiptPath: '.tmp/missing-build-receipt.json' },
        { sourceCommit: 'c'.repeat(40) },
        { worktreeFingerprint: 'd'.repeat(64) },
        { buildIdentity: { ...context.buildIdentity, receiptDigest: '0'.repeat(64) } },
        { buildIdentity: { ...context.buildIdentity, artifactDigest: '0'.repeat(64) } }
    ])
    {
        assert.equal(extractOpenApi({ ...context, ...changed }).status, 'failed', JSON.stringify(changed));
    }
});

test('canonical minimal build rejects independently changed source and published observation bytes', (t) =>
{
    for (const target of [observationBuildSourcePaths[0], observationRelative])
    {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-minimal-tamper-'));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const context = writeMinimalBuildObservation(directory, sampleObservation());
        const absolute = path.join(directory, target);
        writeFileSync(absolute, `${readFileSync(absolute, 'utf8')}\nchanged`);
        assert.equal(extractOpenApi(context).status, 'failed', target);
    }
});

test('canonical minimal build cannot bless an invalid inner observation digest by resealing outer identities', (t) =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-minimal-inner-digest-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const context = writeMinimalBuildObservation(directory, sampleObservation());
    const receiptPath = path.join(directory, context.buildReceiptPath);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const observation = JSON.parse(readFileSync(path.join(directory, observationRelative), 'utf8'));
    observation.observationDigest = '0'.repeat(64);
    const bytes = JSON.stringify(observation);
    const artifact = receipt.artifacts['openapi-aeds-observation'];
    for (const file of [artifact.path, artifact.artifactPath])
    {
        writeFileSync(path.join(directory, file), bytes);
    }
    artifact.artifactDigest = sha256(bytes);
    artifact.buildReceipt.artifactDigest = artifact.artifactDigest;
    receipt.contentDigest = digestValue({ ...receipt, contentDigest: null });
    writeFileSync(receiptPath, JSON.stringify(receipt));
    context.buildIdentity.artifactDigest = artifact.artifactDigest;
    context.buildIdentity.receiptDigest = receipt.contentDigest;
    const result = extractOpenApi(context);
    assert.equal(result.status, 'failed');
    assert.ok(result.failureReasons.some((reason) => reason.includes('observationDigest')));
});

test('stale artifact digest (yesterday Debug swap) fails', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'));
    try
    {
        const observation = sampleObservation();
        const sealed = writeObservation(directory, observation);
        const result = extractOpenApi({ canonicalDigest: digestValue,
            repositoryRoot: directory,
            buildIdentity: { ...sealed.buildIdentity, artifactDigest: '0'.repeat(64) }
        });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /digest mismatch|stale|unbound|canonical OpenAPI build receipt/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('arbitrary lowercase sha256 identity cannot select an unreceipted artifact', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-arbitrary-identity-'));
    try
    {
        const observation = sampleObservation();
        const sealed = writeObservation(directory, observation);
        const result = extractOpenApi({ canonicalDigest: digestValue,
            repositoryRoot: directory,
            buildIdentity: identityFor(observation, sealed.artifactDigest)
        });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /canonical OpenAPI build receipt/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('canonical receipt self-digest and recomputed aggregate source digest fail closed independently', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-receipt-self-digest-'));
    try
    {
        const observation = sampleObservation();
        const sealed = writeObservation(directory, observation);
        const receiptPath = path.join(directory, buildReceiptRelative);
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        receipt.buildIdentity.receiptDigest = 'f'.repeat(64);
        writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
        const selfDigest = extractOpenApi({ canonicalDigest: digestValue,
            repositoryRoot: directory,
            buildIdentity: { ...sealed.buildIdentity, receiptDigest: 'f'.repeat(64) }
        });
        assert.equal(selfDigest.status, 'failed');
        assert.match(selfDigest.failureReasons.join('\n'), /receipt self-digest mismatch/iu);

        writeObservation(directory, observation);
        const forgedIdentity = rewriteReceipt(directory, (value) =>
        {
            value.sourceDigest = 'e'.repeat(64);
        });
        const aggregate = extractOpenApi({ canonicalDigest: digestValue, repositoryRoot: directory, buildIdentity: forgedIdentity });
        assert.equal(aggregate.status, 'failed');
        assert.match(aggregate.failureReasons.join('\n'), /aggregate source digest mismatch/iu);

        const sourceSealed = writeObservation(directory, observation);
        const compiledObserver = path.join(
            directory,
            'tools/contracts/FsusBlog.OpenApiObservation/CompiledEndpointContractObserver.cs'
        );
        writeFileSync(compiledObserver, `${readFileSync(compiledObserver, 'utf8')}tampered\n`);
        const sourceDrift = extractOpenApi({ canonicalDigest: digestValue, repositoryRoot: directory, buildIdentity: sourceSealed.buildIdentity });
        assert.equal(sourceDrift.status, 'failed');
        assert.match(sourceDrift.failureReasons.join('\n'), /CompiledEndpointContractObserver\.cs/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('receipt cannot self-select contract, error, generator, protocol, or artifact digests', () =>
{
    const cases = [
        ['contractDigest', /contract digest mismatch/iu],
        ['errorCatalogDigest', /error authority digest mismatch/iu],
        ['generatorDigest', /generator digest mismatch/iu],
        ['protocolDigest', /protocol digest mismatch/iu],
        ['artifactDigest', /observation artifact digest mismatch/iu],
        ['openapiDigest', /observed OpenAPI artifact digest mismatch/iu]
    ];
    for (const [field, expected] of cases)
    {
        const directory = mkdtempSync(path.join(os.tmpdir(), `openapi-receipt-${field}-`));
        try
        {
            writeObservation(directory, sampleObservation());
            const identity = rewriteReceipt(directory, (receipt) =>
            {
                receipt[field] = '0'.repeat(64);
            });
            const result = extractOpenApi({ canonicalDigest: digestValue, repositoryRoot: directory, buildIdentity: identity });
            assert.equal(result.status, 'failed', field);
            assert.match(result.failureReasons.join('\n'), expected, field);
        }
        finally
        {
            rmSync(directory, { recursive: true, force: true });
        }
    }
});

test('observationDigest is recomputed from sealed content, not trusted from artifact or receipt', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-observation-digest-'));
    try
    {
        const observation = sampleObservation();
        writeObservation(directory, observation);
        const artifactPath = path.join(directory, observationRelative);
        const document = JSON.parse(readFileSync(artifactPath, 'utf8'));
        document.observationDigest = '0'.repeat(64);
        const text = `${JSON.stringify(document, null, 2)}\n`;
        writeFileSync(artifactPath, text);
        const identity = rewriteReceipt(directory, (receipt) =>
        {
            receipt.observationDigest = document.observationDigest;
            receipt.artifactDigest = sha256(Buffer.from(text, 'utf8'));
        });
        const result = extractOpenApi({ canonicalDigest: digestValue, repositoryRoot: directory, buildIdentity: identity });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /observationDigest does not match current observation content/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('typed request, response, protocol, and error authority counterexamples fail closed', () =>
{
    const cases = [
        ['missing request', (value) =>
        {
            delete value.operations[0].request;
        }, /request contract/iu],
        ['request direction drift', (value) =>
        {
            value.operations[0].request.direction = 'response';
        }, /request direction|request contract/iu],
        ['incorrect request required', (value) =>
        {
            value.operations[0].request.required = true;
        }, /request direction|request contract/iu],
        ['incorrect request nullable', (value) =>
        {
            value.operations[1].request.nullable = true;
        }, /request contract/iu],
        ['property nullable drift', (value) =>
        {
            value.operations[1].request.properties.title.nullable = true;
        }, /request contract/iu],
        ['missing nested definition', (value) =>
        {
            delete value.operations[1].request.definitions['FsusBlog.Shared.Contracts.ArticleMetadata'];
        }, /request contract/iu],
        ['nested required drift', (value) =>
        {
            value.operations[1].request.definitions['FsusBlog.Shared.Contracts.ArticleMetadata'].requiredFields = [];
        }, /request contract/iu],
        ['missing required field', (value) =>
        {
            value.operations[1].request.requiredFields = [];
        }, /request contract/iu],
        ['schema digest stale', (value) =>
        {
            value.operations[1].request.schemaDigest = '0'.repeat(64);
        }, /request contract/iu],
        ['invented request field bounds', (value) =>
        {
            value.operations[1].request.boundsState = 'frame-contract';
        }, /request contract/iu],
        ['bounds loss', (value) =>
        {
            value.operations[1].request.properties.title.bounds.maxLength = null;
        }, /request contract/iu],
        ['bounds projection drift', (value) =>
        {
            value.operations[1].request.bounds = {};
        }, /request contract/iu],
        ['invented request union', (value) =>
        {
            value.operations[1].request.unionState = 'one-of';
            value.operations[1].request.oneOf = ['Missing'];
        }, /request contract/iu],
        ['discriminator without union', (value) =>
        {
            value.operations[1].request.discriminator = '$type';
        }, /request contract/iu],
        ['invented request required field', (value) =>
        {
            value.operations[1].request.requiredFields.push('frame');
        }, /request contract/iu],
        ['request direction swap', (value) =>
        {
            value.operations[1].request.source = 'none';
        }, /request contract/iu],
        ['parameter direction swap', (value) =>
        {
            value.operations[1].request.parameters[0].direction = 'response';
        }, /request contract/iu],
        ['parameter source conflict', (value) =>
        {
            value.operations[1].request.parameters[0].source = 'query';
        }, /request contract/iu],
        ['missing query parameter', (value) =>
        {
            value.operations[1].request.parameters.pop();
        }, /request contract/iu],
        ['duplicate request parameter', (value) =>
        {
            value.operations[1].request.parameters.push({ ...value.operations[1].request.parameters[0] });
        }, /request contract/iu],
        ['parameter bounds missing', (value) =>
        {
            delete value.operations[1].request.parameters[0].bounds;
        }, /request contract/iu],
        ['parameter bounds invalid', (value) =>
        {
            value.operations[1].request.parameters[0].bounds.minLength = -1;
        }, /request contract/iu],
        ['parameter evidence missing', (value) =>
        {
            value.operations[1].request.parameters[0].evidence = [];
        }, /request contract/iu],
        ['duplicate source type', (value) =>
        {
            value.operations[1].request.sourceTypes.push(value.operations[1].request.sourceTypes[0]);
        }, /request contract/iu],
        ['missing error response', (value) =>
        {
            value.operations[0].responses.pop();
        }, /response contracts/iu],
        ['success status drift', (value) =>
        {
            value.operations[0].responses[0].status = 201;
        }, /response contracts/iu],
        ['content type drift', (value) =>
        {
            value.operations[0].responses[0].contentType = 'application/json';
        }, /response contracts/iu],
        ['response schema drift', (value) =>
        {
            value.operations[0].responses[0].schemaRef = 'aeds://frame/ApiError';
        }, /response contracts/iu],
        ['result placement drift', (value) =>
        {
            value.operations[0].responses[0].resultPlacement = 'json.body';
        }, /response contracts/iu],
        ['duplicate response', (value) =>
        {
            value.operations[0].responses.push({ ...value.operations[0].responses[0] });
        }, /response contracts/iu],
        ['extra public status', (value) =>
        {
            value.operations[0].publicErrorStatuses.push(503);
        }, /response contracts/iu],
        ['missing status evidence', (value) =>
        {
            delete value.operations[0].publicErrorStatusEvidence['404'];
        }, /response contracts/iu],
        ['unmapped status ref', (value) =>
        {
            value.operations[0].publicErrorRefs[0] = 'configuration-error-security-policy:error-transport-mappings:999';
        }, /response contracts/iu],
        ['generic error placeholder', (value) =>
        {
            value.operations[0].publicErrorRefs[0] = 'configuration-error-security-policy:error-transport-mappings:ApiError';
        }, /response contracts/iu],
        ['active migration overlap', (value) =>
        {
            value.protocolStates.migrationOnlyFrameIds.push('ArticleDetail');
        }, /protocol states/iu],
        ['reserved frame in active partition', (value) =>
        {
            value.protocolStates.activeFrameIds.push('Reserved178');
        }, /protocol states/iu],
        ['non-reserved migration frame', (value) =>
        {
            value.protocolStates.migrationOnlyFrameIds.push('MigrationFrame');
        }, /protocol states/iu],
        ['duplicate retired protocol value', (value) =>
        {
            value.protocolStates.retiredFrameValues.push(40);
        }, /protocol states/iu],
        ['missing migration partition', (value) =>
        {
            delete value.protocolStates.migrationOnlyFrameIds;
        }, /protocol states/iu],
        ['error behavior drift', (value) =>
        {
            value.operations[0].errorAuthorityBehaviorId = 'binary-api-aeds-contract';
        }, /public errors/iu],
        ['invented operation error allow-list', (value) =>
        {
            value.operations[0].publicErrorRefState = 'operation-allow-list';
        }, /public errors/iu],
        ['duplicate public error ref', (value) =>
        {
            value.operations[0].publicErrorRefs.push(value.operations[0].publicErrorRefs[0]);
        }, /response contracts/iu],
        ['premature enumerable status authority', (value) =>
        {
            value.errorAuthority.statusMappingKeys = [400, 500];
        }, /error authority binding/iu],
        ['duplicate authority fact', (value) =>
        {
            value.errorAuthority.factIds.push(value.errorAuthority.factIds[0]);
        }, /error authority binding/iu],
        ['endpoint contract authority drift', (value) =>
        {
            value.endpointContractAuthority.schema = 'fsusblog.aeds-endpoint-contracts.v1';
        }, /endpoint contract authority/iu]
    ];

    for (const [name, mutate, expected] of cases)
    {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-typed-negative-'));
        try
        {
            const observation = sampleObservation();
            mutate(observation);
            const sealed = writeObservation(directory, observation);
            const result = extractOpenApi({ canonicalDigest: digestValue,
                repositoryRoot: directory,
                buildIdentity: sealed.buildIdentity
            });
            assert.equal(result.status, 'failed', name);
            assert.match(result.failureReasons.join('\n'), expected, name);
        }
        finally
        {
            rmSync(directory, { recursive: true, force: true });
        }
        const canonicalDirectory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'openapi-canonical-typed-negative-')));
        try
        {
            const observation = sampleObservation();
            mutate(observation);
            const { context } = writeCanonicalObservation(canonicalDirectory, observation);
            const result = extractOpenApi(context);
            assert.equal(result.status, 'failed', `canonical ${name}`);
            assert.match(result.failureReasons.join('\n'), expected, `canonical ${name}`);
        }
        finally
        {
            rmSync(canonicalDirectory, { recursive: true, force: true });
        }
    }
});

function resealRequestFixture(operation)
{
    const request = operation.request;
    request.schemaDigest = sha256(Buffer.from(JSON.stringify({
        direction: request.direction,
        schemaRef: request.schemaRef,
        requestFrame: operation.requestFrame,
        encoding: request.encoding,
        parameters: request.parameters,
        requiredFields: request.requiredFields,
        properties: request.properties,
        definitions: request.definitions,
        oneOf: request.oneOf,
        discriminator: request.discriminator,
        bounds: request.bounds,
        sourceTypes: request.sourceTypes,
        readerIdentities: request.readerIdentities
    })));
}

function sampleContainerObservation()
{
    const observation = sampleObservation();
    const bounds = () => ({
        minimum: null, maximum: null, minLength: null, maxLength: null,
        minItems: null, maxItems: null, minProperties: null, maxProperties: null
    });
    const value = (type, nullable, overrides = {}) => ({
        type, nullable, format: null, schemaRef: null, item: null, enumValues: [], bounds: bounds(), ...overrides
    });
    const container = (name, type, item, format = null) => ({
        name, type, required: true, nullable: false, format, schemaRef: null,
        itemType: item.type, itemSchemaRef: item.schemaRef, item, enumValues: [], bounds: bounds()
    });
    const request = observation.operations[1].request;
    request.properties = {
        ...request.properties,
        commentIds: container('commentIds', 'array', value('string', false)),
        choices: container('choices', 'array', value('enum', false, { enumValues: ['First', 'Second'] })),
        map: container('map', 'object', value('array', false, { item: value('string', true) }), 'string-keyed-map'),
        objects: container('objects', 'array', value('object', true, {
            schemaRef: 'clr://FsusBlog.Shared.Contracts.ArticleMetadata'
        })),
        tagIds: container('tagIds', 'array', value('integer', false, {
            bounds: { ...bounds(), minimum: '-2147483648', maximum: '2147483647' }
        }))
    };
    request.properties = Object.fromEntries(Object.entries(request.properties).sort(([left], [right]) => left.localeCompare(right)));
    request.requiredFields = Object.values(request.properties).filter((property) => property.required)
        .map((property) => property.name).sort();
    resealRequestFixture(observation.operations[1]);
    return observation;
}

test('v5 retains recursive element nullability, primitive bounds, enums, and object refs in fact projection', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-container-positive-'));
    try
    {
        const observation = sampleContainerObservation();
        const sealed = writeObservation(directory, observation);
        const protocol = readJson(path.join(directory, 'src/shared/Contracts/Validation/aeds-protocol.json'));
        assert.deepEqual(validateObservationAgainstProtocol(observation, protocol), []);
        const result = extractOpenApi({ repositoryRoot: directory, buildIdentity: sealed.buildIdentity, canonicalDigest: digestValue });
        assert.equal(result.status, 'ok', result.failureReasons?.join('\n'));
        const properties = result.observations.operations.binary_post_admin_article.request.properties;
        const field = (name) => properties[`field_${Buffer.from(name).toString('hex')}`];
        assert.deepEqual(field('tagIds').item, {
            type: 'integer', nullable: false, bounds: { minimum: '-2147483648', maximum: '2147483647' }
        });
        assert.deepEqual(field('commentIds').item, { type: 'string', nullable: false });
        assert.deepEqual(field('map').item, { type: 'array', nullable: false, item: { type: 'string', nullable: true } });
        assert.deepEqual(field('choices').item.enumValues, ['First', 'Second']);
        assert.equal(field('objects').item.schemaRef, 'clr://FsusBlog.Shared.Contracts.ArticleMetadata');
        assert.equal(field('objects').item.nullable, true);
        const originalDigest = observationContentDigest(observation);
        observation.operations[1].request.properties.map.item.item.nullable = false;
        assert.notEqual(observationContentDigest(observation), originalDigest, 'recursive nullable is inside observation identity');
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('v5 refuses legacy or incomplete and conflicting element facts even with resealed outer receipts', () =>
{
    const cases = [
        ['legacy v4', (value) =>
        {
            value.schema = 'fsusblog.api-aeds-observation.v4';
        }],
        ['missing item', (_value, properties) =>
        {
            delete properties.tagIds.item;
        }],
        ['unknown nullable', (_value, properties) =>
        {
            properties.commentIds.item.nullable = 'unknown';
        }],
        ['missing nullable', (_value, properties) =>
        {
            delete properties.commentIds.item.nullable;
        }],
        ['missing bounds', (_value, properties) =>
        {
            delete properties.tagIds.item.bounds;
        }],
        ['missing range member', (_value, properties) =>
        {
            delete properties.tagIds.item.bounds.maximum;
        }],
        ['unknown range member', (_value, properties) =>
        {
            properties.tagIds.item.bounds.invented = 1;
        }],
        ['item type conflict', (_value, properties) =>
        {
            properties.tagIds.itemType = 'string';
        }],
        ['item ref conflict', (_value, properties) =>
        {
            properties.objects.itemSchemaRef = null;
        }],
        ['missing definition', (value) =>
        {
            delete value.operations[1].request.definitions['FsusBlog.Shared.Contracts.ArticleMetadata'];
        }],
        ['primitive schema ref', (_value, properties) =>
        {
            properties.tagIds.item.schemaRef = properties.objects.item.schemaRef;
        }],
        ['missing nested item', (_value, properties) =>
        {
            properties.map.item.item = null;
        }],
        ['unknown nested nullable', (_value, properties) =>
        {
            properties.map.item.item.nullable = null;
        }],
        ['primitive with item', (_value, properties) =>
        {
            properties.commentIds.item.item = properties.tagIds.item;
        }],
        ['empty enum values', (_value, properties) =>
        {
            properties.choices.item.enumValues = [];
        }],
        ['duplicate enum value', (_value, properties) =>
        {
            properties.choices.item.enumValues.push('Second');
        }],
        ['extra element key', (_value, properties) =>
        {
            properties.tagIds.item.required = true;
        }],
        ['unknown element type', (_value, properties) =>
        {
            properties.tagIds.item.type = 'opaque';
        }]
    ];
    for (const [name, mutate] of cases)
    {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-container-negative-'));
        try
        {
            const observation = sampleContainerObservation();
            mutate(observation, observation.operations[1].request.properties);
            resealRequestFixture(observation.operations[1]);
            const sealed = writeObservation(directory, observation);
            const protocol = readJson(path.join(directory, 'src/shared/Contracts/Validation/aeds-protocol.json'));
            assert.ok(validateObservationAgainstProtocol(observation, protocol).length > 0, name);
            const result = extractOpenApi({ repositoryRoot: directory, buildIdentity: sealed.buildIdentity, canonicalDigest: digestValue });
            assert.equal(result.status, 'failed', name);
            assert.match(result.failureReasons.join('\n'), /request contract|observation schema/iu, name);
        }
        finally
        {
            rmSync(directory, { recursive: true, force: true });
        }
    }
});

test('element nullable and numeric bounds drift invalidates the original request schema seal', () =>
{
    for (const mutate of [
        (properties) =>
        {
            properties.commentIds.item.nullable = true;
        },
        (properties) =>
        {
            properties.tagIds.item.bounds.maximum = null;
        }
    ])
    {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-element-seal-negative-'));
        try
        {
            const observation = sampleContainerObservation();
            mutate(observation.operations[1].request.properties);
            const sealed = writeObservation(directory, observation);
            const result = extractOpenApi({ repositoryRoot: directory, buildIdentity: sealed.buildIdentity, canonicalDigest: digestValue });
            assert.equal(result.status, 'failed');
            assert.match(result.failureReasons.join('\n'), /request contract/iu);
        }
        finally
        {
            rmSync(directory, { recursive: true, force: true });
        }
    }
});

test('current error authority catalog digest and sealed artifact bytes are independently bound', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-authority-digest-'));
    try
    {
        const observation = sampleObservation();
        const sealed = writeObservation(directory, observation);
        const identity = sealed.buildIdentity;
        assert.equal(extractOpenApi({ canonicalDigest: digestValue, repositoryRoot: directory, buildIdentity: identity }).status, 'ok');

        const catalogPath = path.join(directory, 'config/contracts/behavior-contracts.json');
        writeFileSync(catalogPath, '  { "schema": "fixture-behavior-catalog", "contracts": [] }\n');
        const byteDrift = extractOpenApi({ canonicalDigest: digestValue, repositoryRoot: directory, buildIdentity: identity });
        assert.equal(byteDrift.status, 'failed');
        assert.match(byteDrift.failureReasons.join('\n'), /source digest mismatch.*behavior-contracts/iu);

        writeFileSync(catalogPath, '{"schema":"tampered"}\n');
        const authorityDrift = extractOpenApi({ canonicalDigest: digestValue, repositoryRoot: directory, buildIdentity: identity });
        assert.equal(authorityDrift.status, 'failed');
        assert.match(authorityDrift.failureReasons.join('\n'), /error authority digest|source digest/iu);

        const endpointPath = path.join(directory, 'src/shared/Contracts/Validation/aeds-endpoint-contracts.json');
        writeFileSync(endpointPath, '{"schema":"tampered"}\n');
        const endpointDrift = extractOpenApi({ canonicalDigest: digestValue, repositoryRoot: directory, buildIdentity: identity });
        assert.equal(endpointDrift.status, 'failed');
        assert.match(endpointDrift.failureReasons.join('\n'), /contract digest|source digest/iu);

        writeFileSync(sealed.absolute, `${sealed.text} `);
        const artifactTamper = extractOpenApi({ canonicalDigest: digestValue, repositoryRoot: directory, buildIdentity: identity });
        assert.equal(artifactTamper.status, 'failed');
        assert.match(artifactTamper.failureReasons.join('\n'), /artifact digest mismatch/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('second OpenAPI authority search for matrix generator is retired', () =>
{
    const openapiContracts = readFileSync(
        path.join(root, 'tools/contracts/lib/openapi-contracts.mjs'),
        'utf8'
    );
    assert.match(openapiContracts, /buildOpenApiFromMatrix is retired/u);
    const exportScript = readFileSync(path.join(root, 'tools/contracts/export-openapi.sh'), 'utf8');
    assert.doesNotMatch(exportScript, /OpenApiGenerateDocumentsOnBuild=true/u);
    assert.match(exportScript, /check-openapi-sync\.mjs/u);
    assert.doesNotMatch(exportScript, /FSUSBLOG_OPENAPI_ALLOW_SNAPSHOT_FALLBACK/u);
});

test('generated OpenAPI materialization uses the canonical projection serializer', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-projection-'));
    try
    {
        const observed = path.join(directory, 'observed.json');
        const generated = path.join(directory, 'generated.json');
        writeFileSync(
            observed,
            '{"openapi":"3.1.0","paths":{},"x-fsus-source-identity":"HTTP =\\u003E handler"}\n'
        );

        const expected = openApiProjectionTextFromObservationFile(observed);
        writeGeneratedOpenApiProjection(observed, generated);

        assert.equal(readFileSync(generated, 'utf8'), expected);
        assert.match(expected, /HTTP => handler/u);
        assert.doesNotMatch(expected, /\\\\u003E/u);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});
