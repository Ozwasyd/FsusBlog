import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { productionFreshProducerInventory } = await import(new URL('../test-matrix/production-fresh-run-bound-outputs.mjs', import.meta.url));
const { parseMatrix } = await import(new URL('../test-matrix/parse-matrix.mjs', import.meta.url));
import { canonicalJson, sealContentDigest, sha256 } from './attempt-provenance.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const correctnessAttemptProducerSchema = 'fsusblog.correctness-attempt-producers.v1';
export const correctnessAttemptProducerFile = 'config/testing/correctness-attempt-producers.json';

const browserContractTierIds = new Set([
    'browser-contract',
    'production-xss-release'
]);

function evidenceClass(tier)
{
    return tier.evidenceClass ?? (tier.ciJob === 'browser-diagnostics' ? 'diagnostic' : 'correctness');
}

function producerDomain(id, { physical = false } = {})
{
    if (!physical && browserContractTierIds.has(id))
    {
        return 'browser-contract';
    }
    if (/(?:^|[-])(?:artifact|build|final|finalizer|image|projection|release|reliability|summary)(?:$|[-])/u.test(id))
    {
        return 'build-release-producers';
    }
    return 'test-producers';
}

function producerKind(id, domain)
{
    if (domain === 'browser-contract')
    {
        return 'browser-contract';
    }
    if (domain === 'build-release-producers')
    {
        if (/reliability/u.test(id))
        {
            return 'reliability';
        }
        if (/projection/u.test(id))
        {
            return 'projection';
        }
        if (/(?:final|summary)/u.test(id))
        {
            return 'finalizer';
        }
        return 'build';
    }
    if (/mutation/u.test(id))
    {
        return 'mutation';
    }
    if (/fuzz/u.test(id))
    {
        return 'fuzz';
    }
    if (/property/u.test(id))
    {
        return 'property';
    }
    if (/model/u.test(id))
    {
        return 'model';
    }
    if (/integration|runtime|contract/u.test(id))
    {
        return 'integration';
    }
    return 'unit';
}

function entry({ producerId, sourceAuthority, command, logicalTierIds, owner, physical = false, kindOverride = null, executionProducerId = null })
{
    const id = producerId.split(':').at(-1);
    const domain = producerDomain(id, { physical });
    return {
        producerId,
        domain,
        producerKind: kindOverride ?? producerKind(id, domain),
        sourceAuthority,
        canonicalCommand: command,
        logicalTierIds: [...logicalTierIds].sort(),
        policyId: 'correctness-first-attempt',
        allowedRetries: 0,
        firstFailureBlocksQualification: true,
        frameworkRetrySetting: 0,
        artifactOwner: owner,
        executionOwner: physical
            ? 'tools/test/bundles/run-bundle.mjs'
            : 'tools/run-test-matrix.mjs',
        attemptAdapter: 'tools/test/attempt-runner.mjs#runProducerAttempts',
        migrationState: 'migrated',
        qualificationEligible: true,
        externalAuthorityKinds: [
            'execution-envelope',
            'replay-plan',
            'temporal-context'
        ],
        authorityBindings: {
            executionEnvelope: physical
                ? 'tools/test/physical-execution-process-tree.mjs#runPhysicalExecution'
                : `config/testing/test-execution-envelope-applicability.json#producer:${executionProducerId ?? id}`,
            replayPlan: 'config/testing/replay-qualification-producers.json#contentDigest',
            temporalContext: 'tools/test/temporal-context.mjs#qualificationTemporalContext'
        }
    };
}

function matrixEntries(matrix)
{
    return matrix.tiers
        .filter((tier) => typeof tier.command === 'string' && tier.command.trim())
        .filter((tier) => evidenceClass(tier) !== 'diagnostic')
        .map((tier) => entry({
            producerId: `matrix:${tier.id}`,
            sourceAuthority: 'tests/matrix.yml',
            command: tier.command,
            logicalTierIds: [tier.id],
            owner: tier.owner ?? tier.ciJob ?? 'test-governance',
            kindOverride: ['model', 'property'].includes(tier.executionVariant)
                ? tier.executionVariant
                : null
        }));
}

function physicalEntries()
{
    const entries = [];
    for (const producerId of productionFreshProducerInventory.schedulerProducers)
    {
        entries.push(entry({
            producerId: `physical:scheduler:${producerId}`,
            sourceAuthority: 'tools/test-matrix/production-fresh-run-bound-outputs.mjs',
            command: `production-fresh scheduler producer ${producerId}`,
            logicalTierIds: [],
            owner: 'test-scheduler',
            physical: true
        }));
    }
    for (const [bundleId, producerIds] of Object.entries(productionFreshProducerInventory.bundles))
    {
        for (const producerId of producerIds)
        {
            entries.push(entry({
                producerId: `physical:${bundleId}:${producerId}`,
                sourceAuthority: 'tools/test-matrix/production-fresh-run-bound-outputs.mjs',
                command: `production-fresh bundle ${bundleId} producer ${producerId}`,
                logicalTierIds: [],
                owner: bundleId,
                physical: true
            }));
        }
    }
    return entries;
}

function reliabilityEntries(root)
{
    const catalog = JSON.parse(fs.readFileSync(
        path.join(root, 'config/testing/release-reliability-scenario-catalog.json'),
        'utf8'
    ));
    const scenarios = catalog.scenarios ?? catalog.entries ?? [];
    return scenarios.map((scenario) => entry({
        producerId: `reliability:${scenario.id}`,
        sourceAuthority: 'config/testing/release-reliability-scenario-catalog.json',
        command: `release reliability scenario ${scenario.id}`,
        logicalTierIds: ['release-reliability-fresh'],
        owner: 'release-reliability',
        executionProducerId: 'release-reliability-fresh'
    }));
}

function canonicalProducerEntries(root)
{
    const matrixFile = path.join(root, 'tests/matrix.yml');
    const matrix = parseMatrix(fs.readFileSync(matrixFile, 'utf8'));
    const entries = [
        ...matrixEntries(matrix),
        ...physicalEntries(),
        ...reliabilityEntries(root)
    ].sort((left, right) => left.producerId.localeCompare(right.producerId));
    const ids = entries.map((item) => item.producerId);
    if (new Set(ids).size !== ids.length)
    {
        throw new Error('correctness attempt producer inventory contains duplicate producer IDs');
    }
    return entries;
}

export function correctnessAttemptProducerIds(root = defaultRoot)
{
    return canonicalProducerEntries(root).map((item) => item.producerId);
}

export function buildCorrectnessAttemptProducerInventory(root = defaultRoot)
{
    const matrixFile = path.join(root, 'tests/matrix.yml');
    const reliabilityFile = path.join(root, 'config/testing/release-reliability-scenario-catalog.json');
    const entries = canonicalProducerEntries(root);
    return sealContentDigest({
        schema: correctnessAttemptProducerSchema,
        generatedBy: 'tools/test/generate-correctness-attempt-producers.mjs',
        sourceDigests: {
            'config/testing/release-reliability-scenario-catalog.json': sha256(fs.readFileSync(reliabilityFile)),
            'tests/matrix.yml': sha256(fs.readFileSync(matrixFile)),
            'tools/test-matrix/production-fresh-run-bound-outputs.mjs': sha256(fs.readFileSync(
                path.join(root, 'tools/test-matrix/production-fresh-run-bound-outputs.mjs')
            )),
            'config/testing/replay-qualification-producers.json': sha256(fs.readFileSync(
                path.join(root, 'config/testing/replay-qualification-producers.json')
            )),
            'config/testing/test-execution-envelope-applicability.json': sha256(fs.readFileSync(
                path.join(root, 'config/testing/test-execution-envelope-applicability.json')
            )),
            'tools/test/attempt-runner.mjs': sha256(fs.readFileSync(
                path.join(root, 'tools/test/attempt-runner.mjs')
            )),
            'tools/test/temporal-context.mjs': sha256(fs.readFileSync(
                path.join(root, 'tools/test/temporal-context.mjs')
            )),
            'tools/test/temporal-context-contract.mjs': sha256(fs.readFileSync(
                path.join(root, 'tools/test/temporal-context-contract.mjs')
            ))
        },
        entries
    });
}

export function validateCorrectnessAttemptProducerInventory(document, root = defaultRoot)
{
    const expected = buildCorrectnessAttemptProducerInventory(root);
    if (canonicalJson(document) !== canonicalJson(expected))
    {
        throw new Error('correctness attempt producer inventory differs from canonical authorities');
    }
    for (const item of document.entries)
    {
        if (item.policyId !== 'correctness-first-attempt'
            || item.allowedRetries !== 0
            || item.firstFailureBlocksQualification !== true
            || item.frameworkRetrySetting !== 0
            || item.migrationState !== 'migrated'
            || item.qualificationEligible !== true
            || item.externalAuthorityKinds.join(',') !== 'execution-envelope,replay-plan,temporal-context')
        {
            throw new Error(`${item.producerId} weakens first-attempt correctness policy`);
        }
        if (item.attemptAdapter !== 'tools/test/attempt-runner.mjs#runProducerAttempts'
            || !fs.existsSync(path.join(root, item.executionOwner))
            || item.authorityBindings.replayPlan
                !== 'config/testing/replay-qualification-producers.json#contentDigest'
            || item.authorityBindings.temporalContext
                !== 'tools/test/temporal-context.mjs#qualificationTemporalContext')
        {
            throw new Error(`${item.producerId} is not bound to the canonical attempt authorities`);
        }
    }
    return document;
}

export function inventoryByDomain(document)
{
    return new Map([
        'test-producers',
        'browser-contract',
        'build-release-producers'
    ].map((domain) => [
        domain,
        document.entries.filter((item) => item.domain === domain)
    ]));
}
