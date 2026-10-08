import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { digestCanonical, freezeDeep } = await import(new URL('../test-fixtures/receipt/canonical.mjs', import.meta.url));
const { POSTCONDITION_VERIFIERS } = await import(new URL('../test-fixtures/receipt/postconditions.mjs', import.meta.url));
const { maskCSharpTrivia } = await import(new URL('./csharp-source-mask.mjs', import.meta.url));
const parser = createRequire(new URL('../test-inventory/ts-ast-adapter/package.json', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const producerId = 'account-profile-preferences';
export const accountLocaleOwnershipPath = 'config/testing/account-locale-fixture-ownership.json';
const catalogPaths = [
    'config/testing/fixture-producer-registry.json',
    'config/testing/fixture-capability-catalog.json',
    'config/testing/fixture-profile-catalog.json',
    'config/testing/fixture-consumer-inventory.generated.json'
];
const supportPaths = [
    'tools/test/account-locale-fixture-inventory.mjs',
    'tools/test-fixtures/account-device-composition.mjs',
    'tools/test-fixtures/receipt/postconditions.mjs',
    'config/schemas/account-locale-fixture-ownership.schema.json'
];

function readSource(repositoryRoot, relativePath)
{
    if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)
        || relativePath.split(/[\\/]/u).some((part) => part === '..' || part === '' || part === '.'))
    {
        throw new Error('account inventory source path is not repository relative');
    }
    let absolute = repositoryRoot;
    for (const part of relativePath.split('/'))
    {
        absolute = path.join(absolute, part);
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        {
            throw new Error('account inventory source is not regular');
        }
    }
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
    {
        throw new Error('account inventory source is not bounded');
    }
    return readFileSync(absolute, 'utf8');
}

function identityRoles(source, sourcePath)
{
    const ts = parser('typescript');
    if (ts.version !== '6.0.3')
    {
        throw new Error('account inventory requires the pinned source parser');
    }
    const tree = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
    const declarations = [];
    function visit(node)
    {
        if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'identityRoles')
        {
            const call = node.initializer;
            if (!call || !ts.isCallExpression(call) || call.expression.getText(tree) !== 'Object.freeze'
                || call.arguments.length !== 1 || !ts.isArrayLiteralExpression(call.arguments[0])
                || call.arguments[0].elements.some((item) => !ts.isStringLiteral(item)))
            {
                throw new Error('account identity roles cannot be derived from the producer');
            }
            declarations.push(call.arguments[0].elements.map((item) => item.text));
        }
        ts.forEachChild(node, visit);
    }
    visit(tree);
    if (tree.parseDiagnostics.length || declarations.length !== 1
        || new Set(declarations[0]).size !== declarations[0].length || declarations[0].length === 0)
    {
        throw new Error('account identity role declaration is not unique');
    }
    return declarations[0].sort();
}

/** Source ownership facts only; no device/AOT or cleanup qualification is issued. */
export function deriveAccountLocaleOwnership(sources)
{
    const byPath = new Map(sources.map((item) => [item.path, item.source]));
    if (byPath.size !== sources.length || sources.some((item) => typeof item.source !== 'string'))
    {
        throw new Error('account inventory requires unique source inputs');
    }
    const json = (sourcePath) => JSON.parse(byPath.get(sourcePath));
    const registry = json(catalogPaths[0]);
    const owned = registry.producers.filter((item) => item.id === producerId);
    if (owned.length !== 1)
    {
        throw new Error('account inventory canonical producer is not unique');
    }
    const producer = owned[0];
    const requiredPaths = [...catalogPaths, ...supportPaths, ...producer.implementationPaths].sort();
    if (requiredPaths.length !== byPath.size || requiredPaths.some((sourcePath) => !byPath.has(sourcePath))
        || new Set(requiredPaths).size !== requiredPaths.length)
    {
        throw new Error('account inventory source closure is not exact');
    }
    const capabilities = json(catalogPaths[1]).capabilities.filter((item) => item.ownerProducerId === producerId);
    const capabilityIds = capabilities.map((item) => item.id).sort();
    const equal = (left, right) => digestCanonical(left) === digestCanonical(right);
    if (!equal(capabilityIds, producer.provides) || capabilityIds.length === 0
        || capabilities.some((item) => !/^(?:profile\.|preferences\.)/u.test(item.id))
        || !equal([...new Set(capabilities.flatMap((item) => item.stateDomains))].sort(), producer.stateDomains)
        || !equal([...new Set(capabilities.flatMap((item) => item.dependsOn))].sort(), producer.consumes)
        || !equal([...new Set(capabilities.flatMap((item) => item.postconditionIds))].sort(), producer.receiptPostconditions)
        || capabilities.some((item) => item.postconditionIds.some((id) => typeof POSTCONDITION_VERIFIERS[id] !== 'function')))
    {
        throw new Error('account catalog ownership or verifier mapping is not exact');
    }
    const consumerInventory = json(catalogPaths[3]);
    const implementationPaths = consumerInventory.producerImplementations
        .filter((item) => item.producerId === producerId).map((item) => item.source).sort();
    if (!equal(implementationPaths, [...producer.implementationPaths].sort()))
    {
        throw new Error('account producer implementation inventory disagrees with registry');
    }
    const producerPath = producer.implementationPaths.find((sourcePath) => sourcePath.endsWith('account-profile-preference-producer.mjs'));
    const servicePath = producer.implementationPaths.find((sourcePath) => sourcePath.endsWith('AccountProfilePreferenceFixtureService.cs'));
    const endpointPath = producer.implementationPaths.find((sourcePath) => sourcePath.endsWith('LocalAccountProfilePreferenceFixtureEndpoints.cs'));
    if (!producerPath || !servicePath || !endpointPath)
    {
        throw new Error('account canonical source API is unavailable');
    }
    const service = maskCSharpTrivia(byPath.get(servicePath));
    const contract = service.match(/interface IAccountProfilePreferenceFixtureService\s*\{([^}]+)\}/u)?.[1];
    const methods = [...String(contract).matchAll(/\b(PrepareAsync|VerifyAsync|CleanupAsync)\s*\(/gu)].map((item) => item[1]).sort();
    if (!equal(methods, ['CleanupAsync', 'PrepareAsync', 'VerifyAsync'])
        || !/\bTask\s+CleanupAsync\s*\(/u.test(contract)
        || methods.some((method) => !new RegExp(`\\.\\s*${method}\\s*\\(`, 'u').test(maskCSharpTrivia(byPath.get(endpointPath)))))
    {
        throw new Error('account prepare/verify/void-cleanup API source binding is unavailable');
    }
    const ownedIds = new Set(capabilityIds);
    const profiles = json(catalogPaths[2]).profiles;
    if (new Set(capabilityIds).size !== capabilityIds.length
        || new Set(profiles.map((item) => item.id)).size !== profiles.length)
    {
        throw new Error('account capability or profile identity is duplicated');
    }
    const consumers = consumerInventory.consumers.filter((item) => item.requiredCapabilities.some((id) => ownedIds.has(id)))
        .map((item) => ({ consumerId: item.consumerId, source: item.source, profileIds: item.profileIds,
            capabilityIds: item.requiredCapabilities.filter((id) => ownedIds.has(id)), provenance: 'declared-canonical-consumer-inventory' }));
    if (new Set(consumers.map((item) => item.consumerId)).size !== consumers.length
        || consumers.some((item) => !Array.isArray(item.profileIds) || item.profileIds.length === 0
            || item.profileIds.some((id) => !profiles.some((profile) => profile.id === id
                && item.capabilityIds.every((capability) => profile.capabilities.includes(capability))))
            || !consumerInventory.consumers.find((candidate) => candidate.consumerId === item.consumerId).producerOwners.includes(producerId)))
    {
        throw new Error('account declared consumer ownership is inconsistent');
    }
    return freezeDeep({ schema: 'fsusblog.account-locale-fixture-ownership.v1', generatedBy: 'tools/test/account-locale-fixture-inventory.mjs',
        notAuthoritative: true, qualification: false, producerId, strategy: producer.strategy,
        sourceInputs: requiredPaths.map((sourcePath) => ({ path: sourcePath, digest: digestCanonical(byPath.get(sourcePath)) })),
        capabilityOwners: capabilities.map((item) => ({ capabilityId: item.id, ownerProducerId: item.ownerProducerId,
            stateDomains: item.stateDomains, dependsOn: item.dependsOn, postconditionIds: item.postconditionIds })),
        identityRoles: identityRoles(byPath.get(producerPath), producerPath), implementationPaths,
        sourceApi: { interface: 'IAccountProfilePreferenceFixtureService', implementation: servicePath,
            gateway: endpointPath, methods, cleanupReturn: 'Task' },
        profileBindings: profiles.filter((item) => item.capabilities.some((id) => ownedIds.has(id)))
            .map((item) => ({ profileId: item.id, capabilityIds: item.capabilities.filter((id) => ownedIds.has(id)) })),
        consumers, unresolvedAuthorities: ['canonical-cleanup-completion-readback', 'verified-device-and-public-aot'] });
}

export function readAccountLocaleOwnershipSources(repositoryRoot = root)
{
    if (!lstatSync(repositoryRoot).isDirectory() || lstatSync(repositoryRoot).isSymbolicLink())
    {
        throw new Error('account inventory requires a regular repository root');
    }
    const registry = JSON.parse(readSource(repositoryRoot, catalogPaths[0]));
    const producers = registry.producers.filter((item) => item.id === producerId);
    if (producers.length !== 1)
    {
        throw new Error('account canonical producer is not unique');
    }
    return [...catalogPaths, ...supportPaths, ...producers[0].implementationPaths].sort()
        .map((sourcePath) => ({ path: sourcePath, source: readSource(repositoryRoot, sourcePath) }));
}

export function assertAccountLocaleOwnershipCurrent(repositoryRoot = root)
{
    try
    {
        const expected = deriveAccountLocaleOwnership(readAccountLocaleOwnershipSources(repositoryRoot));
        const actual = JSON.parse(readSource(repositoryRoot, accountLocaleOwnershipPath));
        if (digestCanonical(actual) !== digestCanonical(expected))
        {
            throw new Error('account locale ownership inventory is stale or noncanonical');
        }
        return expected;
    }
    catch (error)
    {
        const failure = new Error('account locale ownership inventory verification failed', { cause: error });
        failure.verificationFailureDigest = digestCanonical({ stage: 'source-ownership', message: String(error?.message ?? error) });
        throw failure;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    if (process.argv.slice(2).join(' ') === '--write')
    {
        const inventory = deriveAccountLocaleOwnership(readAccountLocaleOwnershipSources());
        // This exact domain output is generated only by this source producer.
        try
        {
            readSource(root, accountLocaleOwnershipPath);
        }
        catch (error)
        {
            if (error.code !== 'ENOENT')
            {
                throw error;
            }
        }
        writeFileSync(path.join(root, accountLocaleOwnershipPath), `${JSON.stringify(inventory, null, 4)}\n`);
    }
    else if (process.argv.length === 2)
    {
        process.stdout.write(`${JSON.stringify(assertAccountLocaleOwnershipCurrent())}\n`);
    }
    else
    {
        throw new Error('account ownership producer accepts only --write or check');
    }
}
