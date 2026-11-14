import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
    buildFixtureProfileMatrixInventory,
    FIXTURE_PROFILE_MATRIX_FILE,
    FIXTURE_PROFILE_MATRIX_SCHEMA,
    matrixFixturePrerequisites
} = await import(new URL('../test-matrix/fixture-profile-contract.mjs', import.meta.url));
const { parseMatrix } = await import(new URL('../test-matrix/parse-matrix.mjs', import.meta.url));

import {
    expandFixtureProfile,
    fixtureCatalogFiles,
    isFixtureMatrixConsumer,
    matrixConsumerObservationContent,
    observeFixtureConsumerSource,
    observeFixtureImplicitSource,
    readFixtureCatalogs,
    resolveFixtureVariants,
    scanFixtureSourceDeclarations
} from './fixture-catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const inventoryFile = fixtureCatalogFiles.inventory;
const fixtureProfileMatrixFile = FIXTURE_PROFILE_MATRIX_FILE;
const documentFile = process.env.FSUSBLOG_FIXTURE_DOCUMENT_FILE
    ? path.resolve(process.env.FSUSBLOG_FIXTURE_DOCUMENT_FILE)
    : path.join(root, 'docs/testing/fixture-capability-catalog.md');

function executionClass(tier)
{
    if (tier.resourceClass === 'browser')
    {
        return 'browser';
    }
    if (/^(?:backend-qps|data-scale|load|soak)/u.test(tier.id))
    {
        return 'load';
    }
    if (/^(?:csrf|security)/u.test(tier.id))
    {
        return 'security';
    }
    return 'runtime';
}

export function generateFixtureInventory({ repositoryRoot = root } = {})
{
    const catalogs = readFixtureCatalogs({
        capability: fixtureCatalogFiles.capability,
        profile: fixtureCatalogFiles.profile,
        producer: fixtureCatalogFiles.producer,
        variant: fixtureCatalogFiles.variant
    });
    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    const declarations = scanFixtureSourceDeclarations({ repositoryRoot });
    const ownerByCapability = new Map(catalogs.capability.capabilities.map((item) => [item.id, item.ownerProducerId]));
    const matrixConsumers = matrix.tiers.filter(isFixtureMatrixConsumer).map((tier) =>
    {
        const commandPath = String(tier.command ?? '').match(/\b(tools\/[a-zA-Z0-9_./-]+\.(?:mjs|sh))\b/u)?.[1] ?? String(tier.command ?? '');
        const content = matrixConsumerObservationContent(tier, { repositoryRoot });
        const requiredCapabilities = expandFixtureProfile(tier.fixtureProfile, catalogs).capabilities;
        const producerOwners = [...new Set(requiredCapabilities.map((id) => ownerByCapability.get(id)))].filter(Boolean).sort();
        const directFile = path.join(repositoryRoot, commandPath);
        const directContent = fs.existsSync(directFile) && fs.statSync(directFile).isFile()
            ? fs.readFileSync(directFile, 'utf8') : '';
        return {
            consumerId: `matrix:${tier.id}`,
            executionClass: tier.executionClass ?? executionClass(tier),
            source: commandPath,
            requiredBusinessFact: requiredCapabilities.join(', ') || 'none',
            implicitSource: observeFixtureImplicitSource(commandPath, content, { kind: 'matrix', tierId: tier.id }),
            currentFallback: observeFixtureConsumerSource(commandPath, content, { directContent, plannedProducerOwners: producerOwners }),
            profileId: tier.fixtureProfile,
            profileIds: [tier.fixtureProfile],
            requiredCapabilities,
            requiredVariantIds: resolveFixtureVariants(requiredCapabilities, tier.executionClass ?? executionClass(tier), catalogs),
            producerOwners,
            ...(Object.hasOwn(tier, 'fixturePrerequisites') ? { fixturePrerequisites: matrixFixturePrerequisites(tier) } : {})
        };
    });
    const sourceConsumers = declarations.consumers.map((declaration) =>
    {
        const content = fs.readFileSync(path.join(repositoryRoot, declaration.source), 'utf8');
        const profileIds = declaration.profileId === 'matrix'
            ? [...new Set(matrixConsumers.filter((consumer) =>
{
        return String(consumer.source).includes(declaration.source)
          || (declaration.source === 'tools/test/lanes/data-scale.sh' && /data-scale/u.test(consumer.consumerId));
      }).map((consumer) => consumer.profileId))].sort()
            : [declaration.profileId];
        if (profileIds.length === 0)
        {
            throw new Error(`fixture source declaration ${declaration.id} has no matrix profile binding`);
        }
        const requiredCapabilities = [...new Set(profileIds.flatMap((profileId) => expandFixtureProfile(profileId, catalogs).capabilities))].sort();
        const producerOwners = [...new Set(requiredCapabilities.map((id) => ownerByCapability.get(id)))].filter(Boolean).sort();
        const selectedExecutionClass = profileIds.flatMap((profileId) => catalogs.profile.profiles.find((item) => item.id === profileId)?.allowedExecutionClasses ?? [])[0] ?? 'runtime';
        return {
            consumerId: `source:${declaration.id}`,
            executionClass: selectedExecutionClass,
            source: declaration.source,
            requiredBusinessFact: requiredCapabilities.join(', ') || 'none',
            implicitSource: observeFixtureImplicitSource(declaration.source, content, { kind: 'source' }),
            currentFallback: observeFixtureConsumerSource(declaration.source, content, { plannedProducerOwners: producerOwners }),
            profileId: profileIds.length === 1 ? profileIds[0] : null,
            profileIds,
            requiredCapabilities,
            requiredVariantIds: resolveFixtureVariants(requiredCapabilities, selectedExecutionClass, catalogs),
            producerOwners
        };
    });
    return {
        schema: 'fsusblog.fixture-consumer-inventory.v1',
        generatedBy: 'tools/testing/generate-fixture-catalog-artifacts.mjs',
        consumers: [...matrixConsumers, ...sourceConsumers].sort((left, right) => left.consumerId.localeCompare(right.consumerId)),
        producerImplementations: declarations.producers
    };
}

export function renderFixtureCatalogDocument(catalogs)
{
    const validityRows = catalogs.variant.validityClasses.map((item) => `| \`${item.id}\` | ${item.semantics} |`);
    const rows = catalogs.profile.profiles.slice().sort((left, right) => left.id.localeCompare(right.id)).map((profile) =>
    {
        const capabilities = expandFixtureProfile(profile.id, catalogs).capabilities;
        const executionClass = profile.allowedExecutionClasses[0] ?? null;
        const variants = executionClass == null ? [] : resolveFixtureVariants(capabilities, executionClass, catalogs);
        return `| \`${profile.id}\` | ${capabilities.length ? capabilities.map((id) => `\`${id}\``).join('<br>') : 'none'} | ${variants.length ? variants.map((id) => `\`${id}\``).join('<br>') : 'none'} | \`${profile.allowedExecutionClasses.join('`, `')}\` | ${profile.isDestructive ? 'yes' : 'no'} | ${profile.requiresFreshNamespace ? 'yes' : 'no'} |`;
    });
    return `# Fixture capability catalog

> Generated by \`tools/testing/generate-fixture-catalog-artifacts.mjs\`; do not edit this table.

The machine authorities are \`config/testing/fixture-capability-catalog.json\`, \`fixture-profile-catalog.json\`, \`fixture-producer-registry.json\`, and \`fixture-variant-catalog.json\`. State access remains exclusively in \`runtime-state-domain-registry.json\`.

The runtime equivalent is the immutable \`fsusblog.fixture-variant-plan.v1\` projection. Each producer receives an immutable \`fsusblog.fixture-producer-variant-plan.v1\` slice whose own digest is bound to the complete plan digest; producer outputs and receipts must exact-match that slice and may not add defaults.

| Validity class | Catalog semantics |
| --- | --- |
${validityRows.join('\n')}

| Profile | Expanded capabilities | Resolved fixture variants | Execution classes | Destructive | Fresh namespace |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
}

export function generateFixtureProfileMatrixInventory({ repositoryRoot = root } = {})
{
    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    const inventory = buildFixtureProfileMatrixInventory(matrix);
    if (inventory.schema !== FIXTURE_PROFILE_MATRIX_SCHEMA)
    {
        throw new Error(`fixture profile matrix schema mismatch: ${inventory.schema}`);
    }
    return inventory;
}

export function detectGeneratedArtifactDrift(expected, actual)
{
    return [...expected].filter(([file, content]) => actual.get(file) !== content).map(([file]) => file);
}

function write(file, content)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const check = process.argv.includes('--check');
    const catalogs = readFixtureCatalogs({
        capability: fixtureCatalogFiles.capability,
        profile: fixtureCatalogFiles.profile,
        producer: fixtureCatalogFiles.producer,
        variant: fixtureCatalogFiles.variant
    });
    const expected = new Map([
        [inventoryFile, `${JSON.stringify(generateFixtureInventory(), null, 4)}\n`],
        [fixtureProfileMatrixFile, `${JSON.stringify(generateFixtureProfileMatrixInventory(), null, 4)}\n`],
        [documentFile, renderFixtureCatalogDocument(catalogs)]
    ]);
    const actual = new Map([...expected].map(([file]) => [file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null]));
    const drift = detectGeneratedArtifactDrift(expected, actual);
    if (check && drift.length)
    {
        process.stderr.write(`fixture catalog generated artifacts drift: ${drift.map((file) => path.relative(root, file)).join(', ')}\n`);
        process.exit(1);
    }
    if (!check)
    {
        for (const [file, content] of expected)
        {
            write(file, content);
        }
    }
}
