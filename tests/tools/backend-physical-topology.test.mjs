import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { auditBackendPhysicalTopology } = await import(pathToFileURL(
    join(root, 'tools/architecture/check-backend-physical-topology.mjs')
).href);
const policy = JSON.parse(readFileSync(join(root, 'tests/governance/backend-physical-topology.json'), 'utf8'));
const expectedCanonicalPolicySha256 = '4678d34b767a80337485c89f63eaf505403964cae9efe32862970dd242c93e39';
const fixturePaths = [
    'src/backend/Infrastructure/Bootstrap',
    'src/backend/Services/Authoring',
    'src/backend/Modules/Endpoints',
    'src/backend/Infrastructure/Cache',
    'src/backend/Infrastructure/Security/AdaptivePowGovernor.cs',
    'src/backend/Services/NotificationStream',
    'src/backend/Infrastructure/SchemaMigration',
    'src/migration',
    'tests/governance/backend-physical-topology.json'
];

function createFixture()
{
    const temporary = mkdtempSync(join(tmpdir(), 'fsusblog-backend-topology-'));
    for (const path of fixturePaths)
    {
        const target = join(temporary, path);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(root, path), target, { recursive: true });
    }
    return temporary;
}

function mutate(path, transform)
{
    const source = readFileSync(path, 'utf8');
    writeFileSync(path, transform(source));
}

function auditFixture(temporary)
{
    return auditBackendPhysicalTopology({ root: temporary, policy });
}

function auditFixturePolicyFile(temporary)
{
    return auditBackendPhysicalTopology({ root: temporary });
}

function independentStableJson(value)
{
    if (value === null || typeof value !== 'object')
    {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map(independentStableJson).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${independentStableJson(value[key])}`).join(',')}}`;
}

async function withFixture(run)
{
    const temporary = createFixture();
    try
    {
        await run(temporary);
    }
    finally
    {
        rmSync(temporary, { recursive: true, force: true });
    }
}

test('current backend physical topology satisfies the unique static owner', () =>
{
    const report = auditBackendPhysicalTopology({ root, policy });
    assert.equal(report.status, 'success');
    assert.deepEqual(report.errors, []);
});

test('static lane and matrix own the physical-topology checker and evidence', () =>
{
    const lane = readFileSync(join(root, 'tools/test/lanes/static-governance.sh'), 'utf8');
    assert.match(lane, /backend-physical-topology StaticBackendPhysicalTopology/u);
    assert.match(lane, /backend-physical-topology\.json/u);

    const lifecycleRegistry = JSON.parse(readFileSync(
        join(root, 'tests/governance/test-lifecycle-registry.json'),
        'utf8'
    ));
    const owners = lifecycleRegistry.nodeTests.filter((entry) =>
        entry.file === 'tests/tools/backend-physical-topology.test.mjs'
        && entry.staticGovernance
    );
    assert.equal(owners.length, 1);
    assert.equal(owners[0].staticGovernance.physicalOwner, 'host:pure-file');

    const matrix = readFileSync(join(root, 'tests/matrix.yml'), 'utf8');
    assert.match(matrix, /backend-physical-topology-governance/u);
    assert.match(matrix, /tools\/architecture\/backend-physical-topology\/csharp-mask\.mjs/u);
    assert.match(matrix, /\.tmp\/release-evidence\/backend-physical-topology\.json/u);

    const workflow = readFileSync(join(root, '.github/workflows/quality-gate.yml'), 'utf8');
    assert.match(workflow, /\.tmp\/release-evidence\/backend-physical-topology\.json/u);
});

test('canonical policy authority has an independent stable fingerprint', () =>
{
    const actual = createHash('sha256').update(independentStableJson(policy)).digest('hex');
    assert.equal(actual, expectedCanonicalPolicySha256);
});

test('message-center ownership fails when a member moves to another partial', async () =>
{
    await withFixture((temporary) =>
    {
        const owner = join(temporary, policy.messageCenterPartials.directory, 'MessageCenterService.ConversationQuery.cs');
        mutate(owner, (source) => source.replace('GetAccountConversationsAsync(', 'MovedGetAccountConversationsAsync('));
        const wrongOwner = join(temporary, policy.messageCenterPartials.directory, 'MessageCenterService.ContentPolicy.cs');
        mutate(wrongOwner, (source) => source.replace(/\}\s*$/u, '    private Task GetAccountConversationsAsync() => Task.CompletedTask;\n}\n'));

        const report = auditFixture(temporary);
        assert.equal(report.status, 'failed');
        assert.ok(report.errors.some((error) => error.includes('owned member declaration is missing: GetAccountConversationsAsync')));
        assert.ok(report.errors.some((error) => error.includes('declared outside owner MessageCenterService.ConversationQuery.cs')));
    });
});

test('message-center responsibility files must remain partial', async () =>
{
    await withFixture((temporary) =>
    {
        const path = join(temporary, policy.messageCenterPartials.directory, 'MessageCenterService.ReadState.cs');
        mutate(path, (source) => source.replace('public sealed partial class MessageCenterService', 'public sealed class MessageCenterService'));

        const report = auditFixture(temporary);
        assert.ok(report.errors.some((error) => error.includes('must declare public sealed partial class MessageCenterService')));
    });
});

test('message-center facade rejects responsibility methods and 500 physical lines', async () =>
{
    await withFixture((temporary) =>
    {
        const path = join(temporary, policy.messageCenterPartials.directory, policy.messageCenterPartials.facade);
        mutate(path, (source) =>
        {
            const withMember = source.replace(/\}\s*$/u, '    public Task DeliverAsync() => Task.CompletedTask;\n}\n');
            const lineCount = withMember.endsWith('\n') ? withMember.match(/\n/gu)?.length ?? 0 : (withMember.match(/\n/gu)?.length ?? 0) + 1;
            return `${withMember}${'// topology line budget\n'.repeat(Math.max(0, 500 - lineCount))}`;
        });

        const report = auditFixture(temporary);
        assert.ok(report.errors.some((error) => error.includes('facade must not own DeliverAsync')));
        assert.ok(report.errors.some((error) => error.includes('required < 500')));
    });
});

test('comments and strings cannot create false physical dependencies', async () =>
{
    await withFixture((temporary) =>
    {
        const path = join(temporary, 'src/backend/Infrastructure/Cache/CachePolicy.cs');
        mutate(path, (source) => `${source}\n// IUnifiedCache AuthoringWorkflowService\ninternal static class TopologyTextFixture { private const string Value = "IUnifiedCache AuthoringWorkflowService"; }\n`);
        assert.deepEqual(auditFixture(temporary).errors, []);
    });
});

test('interpolated C# expressions remain code while escaped braces and nested strings remain payload', async () =>
{
    await withFixture((temporary) =>
    {
        const path = join(temporary, policy.bootstrapComposition.composition.path);
        const original = readFileSync(path, 'utf8');
        const executableVariants = [
            'internal static string NormalInterpolation() => $"{TypedResults.Ok()}";',
            'internal static string DollarAtInterpolation() => $@"{TypedResults.Ok()}";',
            'internal static string AtDollarInterpolation() => @$"{TypedResults.Ok()}";',
            'internal static string RawInterpolation() => $"""{TypedResults.Ok()}""";',
            'internal static string NestedInterpolation() => $"{Wrap(new Holder { Value = TypedResults.Ok(), Text = "TypedResults.Ok()" })}";',
            'internal static string TripleNormalInterpolation() => $"{{{TypedResults.Ok()}}}";',
            'internal static string TripleVerbatimInterpolation() => $@"{{{TypedResults.Ok()}}}";',
            'internal static string TripleRawInterpolation() => $$"""{{{TypedResults.Ok()}}}""";',
            'internal static void AstralPrefixInterpolation() { _ = "😀😀😀😀😀😀😀"; TypedResults.Ok(); }'
        ];
        for (const variant of executableVariants)
        {
            writeFileSync(path, `${original}\n${variant}\n`);
            const report = auditFixture(temporary);
            assert.ok(report.errors.some((error) => error.includes('forbidden code token is present: TypedResults.')), variant);
        }

        writeFileSync(path, `${original}\ninternal static string Escaped() => $"{{TypedResults.Ok()}}";\ninternal static string RawEscaped() => $"""{{TypedResults.Ok()}}""";\n`);
        assert.ok(!auditFixture(temporary).errors.some((error) => error.includes('TypedResults.')));
    });
});

test('canonical policy fingerprint rejects weakened forbidden tokens, owners, and members', async () =>
{
    await withFixture((temporary) =>
    {
        const path = join(temporary, 'tests/governance/backend-physical-topology.json');
        const mutations = [
            (document) => document.bootstrapComposition.composition.forbiddenTokens.pop(),
            (document) => delete document.messageCenterPartials.owners['MessageCenterService.ContentPolicy.cs'],
            (document) => document.messageCenterPartials.owners['MessageCenterService.ContentPolicy.cs'].pop()
        ];
        for (const mutatePolicy of mutations)
        {
            const weakened = structuredClone(policy);
            mutatePolicy(weakened);
            writeFileSync(path, `${JSON.stringify(weakened, null, 2)}\n`);
            assert.throws(() => auditFixturePolicyFile(temporary), /policy fingerprint mismatch/u);
        }
    });
});

test('canonical policy fingerprint ignores object key order and rejects custom object behavior', () =>
{
    const reordered = Object.fromEntries(Object.entries(policy).reverse());
    assert.equal(auditBackendPhysicalTopology({ root, policy: reordered }).status, 'success');

    const withToJson = structuredClone(policy);
    Object.defineProperty(withToJson, 'toJSON', { value: () => policy });
    assert.throws(
        () => auditBackendPhysicalTopology({ root, policy: withToJson }),
        /plain JSON objects without toJSON/u);

    const inherited = structuredClone(policy);
    Object.setPrototypeOf(inherited, { weakened: true });
    assert.throws(
        () => auditBackendPhysicalTopology({ root, policy: inherited }),
        /plain JSON objects without toJSON/u);

    const nestedToJson = structuredClone(policy);
    Object.defineProperty(
        nestedToJson.bootstrapComposition.composition.forbiddenTokens,
        'toJSON',
        { value: () => policy.bootstrapComposition.composition.forbiddenTokens });
    assert.throws(
        () => auditBackendPhysicalTopology({ root, policy: nestedToJson }),
        /ordinary JSON prototype without toJSON/u);
});

test('legacy schema registry wildcard rejects a responsibility partial', async () =>
{
    await withFixture((temporary) =>
    {
        const path = join(temporary, policy.schemaMigrationLayout.directory, 'SchemaMigrationRegistry.Legacy.cs');
        writeFileSync(path, 'internal sealed class LegacySchemaRegistry {}\n');
        const report = auditFixture(temporary);
        assert.ok(report.errors.some((error) => error.includes('legacy schema registry partial must not exist')));
    });
});

test('precise runtime owner, cache field, coordinator, and facade constructor contracts fail closed', async () =>
{
    await withFixture((temporary) =>
    {
        const publicRuntime = join(temporary, 'src/backend/Infrastructure/Bootstrap/PublicWebRuntime.cs');
        mutate(publicRuntime, (source) => source.replace('ReportHttp3TransportStartup', 'MovedHttp3TransportStartup'));
        const composition = join(temporary, policy.bootstrapComposition.composition.path);
        mutate(composition, (source) => source.replace(
            'PublicWebRuntime.ReportHttp3TransportStartup',
            'FakePublicWebRuntime.ReportHttp3TransportStartup'));
        const governor = join(temporary, 'src/backend/Infrastructure/Security/AdaptivePowGovernor.cs');
        mutate(governor, (source) => source.replace('private readonly ICacheStringReader _cache;', 'private readonly ICacheStringReader cacheReader;'));
        const coordinator = join(temporary, 'src/backend/Infrastructure/Cache/CacheMissCoordinator.cs');
        mutate(coordinator, (source) => source.replace('ICacheSingleFlightCoordinator singleFlightCoordinator,', 'ICacheSingleFlightCoordinator coordinator,'));
        const facade = join(temporary, policy.messageCenterPartials.directory, policy.messageCenterPartials.facade);
        mutate(facade, (source) => source.replace('public sealed partial class MessageCenterService(', 'public sealed partial class MessageCenterService'));

        const report = auditFixture(temporary);
        assert.ok(report.errors.some((error) => error.includes('required code identifier is missing: ReportHttp3TransportStartup')));
        assert.ok(report.errors.some((error) => error.includes('required qualified code symbol is missing: PublicWebRuntime.ReportHttp3TransportStartup')));
        assert.ok(report.errors.some((error) => error.includes('required code token is missing: private readonly ICacheStringReader _cache;')));
        assert.ok(report.errors.some((error) => error.includes('required code token is missing: ICacheSingleFlightCoordinator singleFlightCoordinator,')));
        assert.ok(report.errors.some((error) => error.includes('with its primary constructor')));
    });
});

test('retired cache identifiers and directional dependency reversals fail closed', async () =>
{
    await withFixture((temporary) =>
    {
        const retired = join(temporary, 'src/backend/Infrastructure/Cache/CachePolicy.cs');
        mutate(retired, (source) => `${source}\ninternal interface IUnifiedCache {}\n`);
        const direction = join(temporary, 'src/backend/Infrastructure/Cache/CachePorts.cs');
        mutate(direction, (source) => `${source}\ninternal StackExchange.Redis.IDatabase? ForbiddenDatabase;\n`);

        const report = auditFixture(temporary);
        assert.ok(report.errors.some((error) => error.includes('retired cache identifier is present: IUnifiedCache')));
        assert.ok(report.errors.some((error) => error.includes('forbidden code token is present: StackExchange.Redis')));
    });
});

test('bootstrap execution, authoring sibling coupling, and schema aggregation fail closed', async () =>
{
    await withFixture((temporary) =>
    {
        const composition = join(temporary, policy.bootstrapComposition.composition.path);
        mutate(composition, (source) => `${source}\ninternal static object ForbiddenMaterialization() => TypedResults.Ok();\n`);
        const authoring = join(temporary, policy.authoringModules.serviceRoot, 'AuthoringAnalyticsReadService.cs');
        mutate(authoring, (source) => `${source}\ninternal sealed class ForbiddenSiblingDependency { private AuthoringAssetLibraryService? _service; }\n`);
        const registry = join(temporary, policy.schemaMigrationLayout.directory, policy.schemaMigrationLayout.registry);
        mutate(registry, (source) => `${source}\ninternal static void BuildLegacyDescriptors() {}\n`);

        const report = auditFixture(temporary);
        assert.ok(report.errors.some((error) => error.includes('forbidden code token is present: TypedResults.')));
        assert.ok(report.errors.some((error) => error.includes('references sibling AuthoringAssetLibraryService')));
        assert.ok(report.errors.some((error) => error.includes('must not contain Build* aggregation')));
    });
});
