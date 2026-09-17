using System.Net;
using System.Security.Claims;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Implementations;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class RuntimeCacheEvidenceHotFeaturedFrameIntegrationTests(
    PostgresSchemaMigrationFixture postgres,
    PublicHotDeliveryRedisFixture redis) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    private const string EvidenceSecret = "runtime-cache-hot-featured-frame-secret";

    [Fact]
    public async Task AdminWholeFrameRoutes_ExposeOneColdBuildAndAtomicPublicationPerIdentity()
    {
        string connectionString = await CreateFixtureAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        connection.RegisterProfiler(static () =>
            CacheCoordinationObservation.Current?.RedisProfile
            ?? RuntimeCacheEvidenceObservation.Current?.RedisProfile!);
        string prefix = $"runtime-cache-hot-featured:{Guid.CreateVersion7():N}:";
        var scope = new TestKeyScope(prefix);
        var policies = new CachePolicyRegistry();
        using var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(
            new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(
            singleFlight,
            cache,
            policies,
            NullLogger<CacheMissCoordinator>.Instance);
        var version = new FixedHotVersion(1);
        Assert.Equal(1, await cache.IncrementAsync(
            CachePolicyId.AdminStats,
            IHotArticlesCacheVersionProvider.AuthorityCounterIdentity));
        ArticleEndpointService articles = CreateEndpoint(
            new ArticleCoreService(CreateProductionReader(db, coordinator, scope, connection)),
            cache,
            coordinator,
            version);

        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = "Test"
        });
        builder.Configuration[RuntimeCacheEvidenceMiddleware.SecretConfigurationKey] = EvidenceSecret;
        builder.Configuration["AllowedHosts"] = "127.0.0.1;localhost";
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        EndpointContractApplication.AddContractServices(builder);
        builder.Services.RemoveAll<IArticleEndpointService>();
        builder.Services.RemoveAll<IAedsEncoder>();
        builder.Services.RemoveAll<RuntimeCacheEvidenceStore>();
        builder.Services.AddSingleton<IArticleEndpointService>(articles);
        builder.Services.AddSingleton<IAedsEncoder, AedsEncoder>();
        builder.Services.AddSingleton<RuntimeCacheEvidenceStore>();

        WebApplication app = builder.Build();
        app.UseRouting();
        app.UseMiddleware<RuntimeCacheEvidenceMiddleware>();
        app.Use(async (context, next) =>
        {
            if (context.Request.Headers.ContainsKey("X-Test-Admin"))
            {
                context.User = new ClaimsPrincipal(new ClaimsIdentity(
                [
                    new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                    new Claim("admin_id", "1851"),
                    new Claim("admin_sid", "runtime-cache-hot-featured"),
                    new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
                ],
                authenticationType: "runtime-cache-hot-featured-test"));
            }
            await next();
        });
        app.UseAuthorization();
        app.MapBinaryEndpoints();
        app.MapRuntimeCacheEvidenceEndpoints();
        await app.StartAsync();
        try
        {
            string address = app.Services.GetRequiredService<Microsoft.AspNetCore.Hosting.Server.IServer>()
                .Features.Get<IServerAddressesFeature>()!
                .Addresses.Single();
            using var client = new HttpClient(new HttpClientHandler { UseProxy = false })
            {
                BaseAddress = new Uri(address),
                Timeout = TimeSpan.FromSeconds(30)
            };

            JsonElement[] hot = await ObserveIdentityAsync(client, "hot", 49);
            JsonElement[] featured = await ObserveIdentityAsync(client, "featured", 9);

            AssertIdentityEvidence(hot, "article-hot-frame");
            AssertIdentityEvidence(featured, "article-featured-frame");
        }
        finally
        {
            await app.StopAsync();
            await app.DisposeAsync();
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    private static async Task<JsonElement[]> ObserveIdentityAsync(
        HttpClient client,
        string kind,
        int size)
        => await Task.WhenAll(Enumerable.Range(0, 24).Select(index =>
            ObserveRequestAsync(
                client,
                $"/api/binary/admin/article/{kind}?size={size}&runtime-cache-evidence={index + 1}",
                $"hot-featured-{kind}-{index + 1:D3}")));

    private static async Task<JsonElement> ObserveRequestAsync(
        HttpClient client,
        string path,
        string requestId)
    {
        using (var request = new HttpRequestMessage(HttpMethod.Get, path))
        {
            request.Headers.TryAddWithoutValidation("X-Test-Admin", "1");
            request.Headers.TryAddWithoutValidation(
                RuntimeCacheEvidenceMiddleware.RequestIdHeader,
                requestId);
            request.Headers.TryAddWithoutValidation(
                RuntimeCacheEvidenceMiddleware.SecretHeader,
                EvidenceSecret);
            using HttpResponseMessage response = await client.SendAsync(request);
            response.EnsureSuccessStatusCode();
        }

        using var observationRequest = new HttpRequestMessage(
            HttpMethod.Get,
            $"/_fsus/testing/runtime-cache/observations/{requestId}");
        observationRequest.Headers.TryAddWithoutValidation(
            RuntimeCacheEvidenceMiddleware.SecretHeader,
            EvidenceSecret);
        using HttpResponseMessage observationResponse = await client.SendAsync(observationRequest);
        observationResponse.EnsureSuccessStatusCode();
        await using Stream payload = await observationResponse.Content.ReadAsStreamAsync();
        using JsonDocument document = await JsonDocument.ParseAsync(payload);
        return document.RootElement.Clone();
    }

    private static void AssertIdentityEvidence(
        IReadOnlyList<JsonElement> observations,
        string family)
    {
        Assert.All(observations, observation =>
        {
            Assert.StartsWith("/api/binary/admin/article/", observation.GetProperty("path").GetString(), StringComparison.Ordinal);
            Assert.NotEqual("l0-allow", observation.GetProperty("layerSource").GetString());
        });
        Assert.Single(observations.Select(observation =>
            observation.GetProperty("payloadDigest").GetString()).Distinct(StringComparer.Ordinal));
        Assert.InRange(observations.Sum(observation =>
            observation.GetProperty("databaseCommandCount").GetInt32()), 0, 1);

        (JsonElement Request, JsonElement Event)[] allEvents = observations
            .SelectMany(observation => observation.GetProperty("cacheEvents")
                .EnumerateArray()
                .Select(cacheEvent => (observation, cacheEvent)))
            .ToArray();
        (JsonElement Request, JsonElement Event) build = Assert.Single(allEvents, item => string.Equals(
            item.Event.GetProperty("outcome").GetString(),
            "built",
            StringComparison.Ordinal));
        Assert.Equal("cache-miss-singleflight", build.Event.GetProperty("family").GetString());
        Assert.Matches(
            "^sha256:[a-f0-9]{64}$",
            build.Event.GetProperty("identityDigest").GetString());
        (JsonElement Request, JsonElement Event) publication = Assert.Single(allEvents, item =>
            string.Equals(item.Event.GetProperty("family").GetString(), family, StringComparison.Ordinal) &&
            string.Equals(
            item.Event.GetProperty("outcome").GetString(),
            "published",
            StringComparison.Ordinal));
        Assert.Contains(
            publication.Request.GetProperty("redisCommands").EnumerateArray(),
            command => command.GetString() is "EVAL" or "EVALSHA");
    }

    private async Task<string> CreateFixtureAsync()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(postgres);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Category),
            typeof(Article),
            typeof(ArticleRevision),
            typeof(ArticlePublicationRecord),
            typeof(ArticleRightsSnapshot));
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO category(id, name, description) VALUES (1, 'runtime-cache-category', NULL);
            INSERT INTO article_revision(
                id, article_id, revision_no, title, summary, cover_image_url, categoryid,
                tag_ids, content_block_id, markdown_content, diff_summary,
                created_by_admin_principal_id, rollback_source_revision_id, rollback_reason, created_at)
            SELECT value, value, 1, 'article ' || value::text, 'summary', '/cover-' || value::text || '.webp', 1,
                '', value, '# body', '', 1, NULL, NULL, '2026-07-20T00:00:00Z'
            FROM generate_series(1, 50) AS value;
            INSERT INTO article_rights_snapshot(
                id, article_id, article_revision_id, revision_no, article_rights_policy_id,
                enabled, license_type, copy_policy, max_excerpt_chars, allow_code_copy,
                show_public_badge, proof_binding_enabled, policy_hash, content_canonical_hash, created_at)
            VALUES (
                1, 1, 1, 1, 1,
                true, 'all-rights-reserved', 'append-attribution', 300, true,
                true, true, 'policy-hash', 'content-hash', '2026-07-20T00:00:00Z');
            INSERT INTO article_publication(
                id, article_id, publication_no, article_revision_id, revision_no,
                rights_snapshot_id, responsibility_snapshot_id, transition_kind, published_at, created_at)
            SELECT value, value, 1, value, 1, 1, NULL, 'publish',
                '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z'
            FROM generate_series(1, 50) AS value;
            INSERT INTO article(
                id, title, summary, coverimageurl, categoryid, views, createtime,
                metadata_updated_at, status, scheduled_publish_at, published_at,
                last_published_at, public_updated_at, current_revision_id,
                current_publication_id, pending_publication_at, archived_at, deleted_at, isdeleted)
            SELECT value, 'article ' || value::text, 'summary', NULL, 1, 1000 - value,
                '2026-07-20T00:00:00Z'::timestamptz - (value * interval '1 second'),
                '2026-07-20T00:00:00Z', 2, NULL, '2026-07-20T00:00:00Z',
                '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', value, value,
                NULL, NULL, NULL, false
            FROM generate_series(1, 50) AS value;
            """);
        return connectionString;
    }

    private static ArticleEndpointService CreateEndpoint(
        IArticleCoreService core,
        UnifiedCache cache,
        ICacheMissCoordinator coordinator,
        IHotArticlesCacheVersionProvider version)
        => new(
            core,
            Substitute.For<IArticleMutationCommandService>(),
            cache,
            cache,
            coordinator,
            Substitute.For<IArticleDetailAedsArtifactStore>(),
            Substitute.For<IPublicArticleProjectionStore>(),
            Substitute.For<IArticleDetailAedsArtifactBackfillScheduler>(),
            version,
            new ArticleListCursorCodec(new EphemeralDataProtectionProvider(), TimeProvider.System));

    private static ArticleService CreateProductionReader(
        SqlSugarClient db,
        ICacheMissCoordinator coordinator,
        IRuntimeKeyScope scope,
        IConnectionMultiplexer redisConnection)
        => new(
            _db: db,
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisOperations: RedisOperationExecutor.ForTestConnection(redisConnection),
            _cacheReader: Substitute.For<ICacheTypedReader>(),
            _cacheWriter: Substitute.For<ICacheRawWriter>(),
            _stringReader: Substitute.For<ICacheStringReader>(),
            _stringWriter: Substitute.For<ICacheStringWriter>(),
            _cacheMissCoordinator: coordinator,
            _dbConcurrencyGate: new ImmediateDbConcurrencyGate(),
            _runtimeKeyScope: scope,
            _httpContextAccessor: Substitute.For<IHttpContextAccessor>(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationFence: Substitute.For<IArticlePublicMutationFence>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
            _publicationValidator: Substitute.For<IArticlePublicationValidator>(),
            _articleBodyRepairQueue: new ArticleBodyRepairQueue(),
            _articleListCursorCodec: new ArticleListCursorCodec(new EphemeralDataProtectionProvider(), TimeProvider.System));

    private sealed class TestKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;

        public string PrefixKey(string key) => string.Concat(prefix, key);
    }

    private sealed class FixedHotVersion(long version) : IHotArticlesCacheVersionProvider
    {
        public long CurrentHotArticlesVersion => version;

        public string BuildVersionedHotArticlesIdentity(string identity) => identity;
    }

    private sealed class ImmediateDbConcurrencyGate : IDbConcurrencyGate
    {
        public Task<T> ExecuteAsync<T>(
            string operation,
            Func<CancellationToken, Task<T>> action,
            Func<CancellationToken, Task<T>> onTimeout,
            CancellationToken cancellationToken = default)
            => action(cancellationToken);

        public DbConcurrencyGateSnapshot GetSnapshot() => new(1, 0, 0);
    }
}
