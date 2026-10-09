using System.Net;

using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Tests.Unit;
using FsusBlog.Shared.Contracts.AuthoringPreferences;

using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class WritingAidPreferenceEndpointPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task Read_MissingRowUsesProductionDefaultsAcrossReloadWithoutWrites()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient other = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using EndpointSecurityTestServer server = WritingAidPreferenceEndpointTests.CreateServer(Service(db));
        using HttpClient client = server.CreateClient();
        using HttpRequestMessage request = WritingAidPreferenceEndpointTests.Request(HttpMethod.Get);
        using HttpResponseMessage response = await client.SendAsync(request);
        WritingAidPreferenceSnapshot first = await WritingAidPreferenceEndpointTests.ReadSnapshotAsync(response);

        Assert.Equal(0, first.Revision);
        Assert.Equal(WritingAidPreferenceContract.Defaults, first.Values);
        using EndpointSecurityTestServer reloadedServer = WritingAidPreferenceEndpointTests.CreateServer(Service(other));
        using HttpClient reloadedClient = reloadedServer.CreateClient();
        using HttpRequestMessage reloadedRequest = WritingAidPreferenceEndpointTests.Request(HttpMethod.Get);
        using HttpResponseMessage reloadedResponse = await reloadedClient.SendAsync(reloadedRequest);
        Assert.Equal(first, await WritingAidPreferenceEndpointTests.ReadSnapshotAsync(reloadedResponse));
        await AssertEmptyPersistenceAsync(db);
    }

    [Fact]
    public async Task UpdateAndInitialize_DeviceRefusalLeavesSolePreferenceAndJournalEmpty()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        UserLocalePreferenceService service = Service(db);
        using EndpointSecurityTestServer server = WritingAidPreferenceEndpointTests.CreateServer(service, service, service);
        using HttpClient client = server.CreateClient();
        Guid operationId = Guid.NewGuid();
        for (int attempt = 0; attempt < 2; attempt++)
        {
            using HttpRequestMessage update = WritingAidPreferenceEndpointTests.Request(HttpMethod.Put,
                new(0, operationId, new(1, true, false, true)));
            using HttpResponseMessage response = await client.SendAsync(update);
            await WritingAidPreferenceEndpointTests.AssertDeviceRefusalAsync(response);
        }
        using HttpRequestMessage initialize = WritingAidPreferenceEndpointTests.Request(HttpMethod.Post,
            new(0, operationId, WritingAidPreferenceContract.Defaults), "/initialize");
        using HttpResponseMessage initialized = await client.SendAsync(initialize);
        await WritingAidPreferenceEndpointTests.AssertDeviceRefusalAsync(initialized);
        await AssertEmptyPersistenceAsync(db);
        Assert.Equal(0, (await service.GetWritingAidPreferenceAsync(WritingAidPreferenceEndpointTests.Owner)).Snapshot!.Revision);
    }

    [Fact]
    public async Task Read_UnavailableOriginalPersistenceReturnsUnifiedFailure()
    {
        // A fresh disposable database with no preference tables proves the real
        // service's unavailable outcome, without replacing its persistence port.
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        using EndpointSecurityTestServer server = WritingAidPreferenceEndpointTests.CreateServer(Service(db));
        using HttpClient client = server.CreateClient();
        using HttpRequestMessage request = WritingAidPreferenceEndpointTests.Request(HttpMethod.Get);
        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("writing_aid_preference_unavailable",
            (await EndpointSecurityTestServer.ReadErrorAsync(response)).Message);
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        try
        {
            // Only the original schema definition, in a fixture-owned empty DB.
            string sql = Assert.IsType<RawSqlStep>(Assert.Single(
                WritingAidPreferenceMigrationDefinitions.BuildMigration().Steps)).Sql;
            await db.Ado.ExecuteCommandAsync(sql);
            return db;
        }
        catch
        {
            db.Dispose();
            throw;
        }
    }

    private static UserLocalePreferenceService Service(SqlSugarClient db)
        => new(db, NullLogger<UserLocalePreferenceService>.Instance, TestTemporalContext.CreateCanonical().BusinessClock);

    private static async Task AssertEmptyPersistenceAsync(SqlSugarClient db)
    {
        await using var connection = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT count(*) FROM user_authoring_preference;";
        Assert.Equal(0L, (long)(await command.ExecuteScalarAsync())!);
        command.CommandText = "SELECT count(*) FROM user_authoring_preference_operation;";
        Assert.Equal(0L, (long)(await command.ExecuteScalarAsync())!);
    }
}
