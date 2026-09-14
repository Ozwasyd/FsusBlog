using System.Net;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Tests.Fixtures;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class RuntimeCacheEvidenceDatabaseAttributionIntegrationTests(
    PostgresSchemaMigrationFixture postgres)
{
    [Fact]
    public async Task RealKestrel_AttributesSqlSugarAndDirectNpgsqlCommandsToTheirRequests()
    {
        string database = await postgres.CreateDatabaseAsync();
        string connectionString = postgres.BuildDatabaseConnectionString(database);
        await using DatabaseEvidenceKestrelHost host = await DatabaseEvidenceKestrelHost.StartAsync(
            connectionString);

        Assert.Contains("Kestrel", host.ServerIdentity, StringComparison.Ordinal);

        JsonElement direct = await host.ObserveAsync("direct-request-0001", "/direct-npgsql");
        AssertCompleteSingleCommand(
            direct,
            RuntimeCacheEvidenceObservation.FingerprintSql("SELECT 42 WHERE 1 = @value"));

        JsonElement sqlSugar = await host.ObserveAsync("sqlsugar-request-0001", "/sqlsugar");
        AssertCompleteSingleCommand(
            sqlSugar,
            RuntimeCacheEvidenceObservation.FingerprintSql("SELECT 43"));
    }

    [Fact]
    public async Task RealKestrel_ExposesAuthenticatedRuntimeMemorySnapshot()
    {
        string database = await postgres.CreateDatabaseAsync();
        await using DatabaseEvidenceKestrelHost host = await DatabaseEvidenceKestrelHost.StartAsync(
            postgres.BuildDatabaseConnectionString(database));

        JsonElement snapshot = await host.RuntimeSnapshotAsync();

        Assert.Equal(Environment.ProcessId, snapshot.GetProperty("processId").GetInt32());
        Assert.True(snapshot.GetProperty("totalAllocatedBytes").GetInt64() > 0);
        Assert.True(snapshot.GetProperty("residentBytes").GetInt64() > 0);
        Assert.Equal(0, snapshot.GetProperty("activeKeyedEntries").GetInt32());
        JsonElement sitemap = snapshot.GetProperty("sitemap");
        Assert.Equal(0, sitemap.GetProperty("generation").GetInt64());
        Assert.Equal(0, sitemap.GetProperty("artifactCount").GetInt32());
        Assert.Equal(0, sitemap.GetProperty("residentBytes").GetInt64());
        Assert.Equal(0, sitemap.GetProperty("buildCount").GetInt64());
        Assert.Equal(JsonValueKind.Array, snapshot.GetProperty("policies").ValueKind);
    }

    private static void AssertCompleteSingleCommand(JsonElement observation, string expectedFingerprint)
    {
        Assert.Equal("complete", observation.GetProperty("databaseObservationStatus").GetString());
        Assert.True(observation.GetProperty("databaseAttributionComplete").GetBoolean());
        Assert.Equal(1, observation.GetProperty("databaseCommandCount").GetInt32());
        Assert.Equal(0, observation.GetProperty("databaseDroppedCommandCount").GetInt32());
        Assert.Equal(0, observation.GetProperty("databaseLateCommandCount").GetInt32());
        JsonElement.ArrayEnumerator fingerprints = observation
            .GetProperty("databaseFingerprints")
            .EnumerateArray();
        Assert.True(fingerprints.MoveNext());
        Assert.Equal(expectedFingerprint, fingerprints.Current.GetString());
        Assert.False(fingerprints.MoveNext());
    }

    private sealed class DatabaseEvidenceKestrelHost : IAsyncDisposable
    {
        private const string Secret = "runtime-cache-database-attribution-secret";
        private readonly WebApplication _app;
        private readonly HttpClient _client;

        private DatabaseEvidenceKestrelHost(
            WebApplication app,
            HttpClient client,
            string serverIdentity)
        {
            _app = app;
            _client = client;
            ServerIdentity = serverIdentity;
        }

        internal string ServerIdentity
        {
            get;
        }

        internal static async Task<DatabaseEvidenceKestrelHost> StartAsync(string connectionString)
        {
            WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
            {
                EnvironmentName = "Test"
            });
            builder.Configuration[RuntimeCacheEvidenceMiddleware.SecretConfigurationKey] = Secret;
            builder.Configuration["ConnectionStrings:DefaultConnection"] = connectionString;
            builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
            builder.Services.AddRouting();
            builder.Services.AddSingleton<RuntimeCacheEvidenceStore>();
            builder.Services.AddSingleton<ICacheDiagnostics, EmptyCacheDiagnostics>();
            builder.Services.AddSingleton<ICacheSingleFlightCoordinator>(static _ =>
                new CacheSingleFlightCoordinator(
                    new TestCacheKeyResolver(),
                    TimeSpan.FromSeconds(1),
                    8));
            builder.Services.AddSingleton<PublicAotInvalidationTracker>();
            builder.Services.AddSingleton<SitemapArtifactCache>();
            builder.Services.AddSqlSugar();

            WebApplication app = builder.Build();
            app.UseMiddleware<RuntimeCacheEvidenceMiddleware>();
            app.MapGet("/direct-npgsql", async (IConfiguration configuration) =>
            {
                string configured = configuration.GetConnectionString("DefaultConnection")
                    ?? throw new InvalidOperationException("DefaultConnection is required.");
                await using var connection = new NpgsqlConnection(configured);
                await connection.OpenAsync();
                await using var command = new NpgsqlCommand("SELECT 42 WHERE 1 = @value", connection);
                command.Parameters.AddWithValue("value", 1);
                object? value = await command.ExecuteScalarAsync();
                return Results.Text(Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture));
            });
            app.MapGet("/sqlsugar", async (ISqlSugarClient db) =>
                Results.Text((await db.Ado.GetIntAsync("SELECT 43")).ToString(
                    System.Globalization.CultureInfo.InvariantCulture)));
            app.MapRuntimeCacheEvidenceEndpoints();
            await app.StartAsync();

            IServer server = app.Services.GetRequiredService<IServer>();
            IServerAddressesFeature addresses = server.Features.Get<IServerAddressesFeature>()
                ?? throw new InvalidOperationException("Kestrel did not expose a bound address.");
            var client = new HttpClient(new HttpClientHandler { UseProxy = false })
            {
                BaseAddress = new Uri(addresses.Addresses.Single()),
                Timeout = TimeSpan.FromSeconds(15)
            };
            return new DatabaseEvidenceKestrelHost(
                app,
                client,
                server.GetType().AssemblyQualifiedName ?? server.GetType().FullName ?? server.GetType().Name);
        }

        internal async Task<JsonElement> ObserveAsync(string requestId, string path)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Get, path))
            {
                request.Headers.TryAddWithoutValidation(
                    RuntimeCacheEvidenceMiddleware.RequestIdHeader,
                    requestId);
                request.Headers.TryAddWithoutValidation(
                    RuntimeCacheEvidenceMiddleware.SecretHeader,
                    Secret);
                using HttpResponseMessage response = await _client.SendAsync(request);
                response.EnsureSuccessStatusCode();
            }

            using var evidenceRequest = new HttpRequestMessage(
                HttpMethod.Get,
                $"/_fsus/testing/runtime-cache/observations/{requestId}");
            evidenceRequest.Headers.TryAddWithoutValidation(
                RuntimeCacheEvidenceMiddleware.SecretHeader,
                Secret);
            using HttpResponseMessage evidenceResponse = await _client.SendAsync(evidenceRequest);
            evidenceResponse.EnsureSuccessStatusCode();
            await using Stream payload = await evidenceResponse.Content.ReadAsStreamAsync();
            using JsonDocument document = await JsonDocument.ParseAsync(payload);
            return document.RootElement.Clone();
        }

        internal async Task<JsonElement> RuntimeSnapshotAsync()
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Get,
                "/_fsus/testing/runtime-cache/runtime-snapshot");
            request.Headers.TryAddWithoutValidation(
                RuntimeCacheEvidenceMiddleware.SecretHeader,
                Secret);
            using HttpResponseMessage response = await _client.SendAsync(request);
            response.EnsureSuccessStatusCode();
            await using Stream payload = await response.Content.ReadAsStreamAsync();
            using JsonDocument document = await JsonDocument.ParseAsync(payload);
            return document.RootElement.Clone();
        }

        public async ValueTask DisposeAsync()
        {
            _client.Dispose();
            await _app.StopAsync();
            await _app.DisposeAsync();
        }

        private sealed class EmptyCacheDiagnostics : ICacheDiagnostics
        {
        }

        private sealed class TestCacheKeyResolver : ICacheKeyResolver
        {
            public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
                => $"{policyId}:{identity}:{version}";
        }
    }
}
