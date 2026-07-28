using FsusBlog.Server.Tests.Fixtures;
using FsusBlog.Server.Tests.TestInfrastructure;

using Npgsql;

namespace FsusBlog.Server.Tests.Integration;

[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class TemporalContextPostgresIntegrationTests(
    PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task PostgreSqlSession_ReturnsInjectedEpochAndRejectsTimezoneMismatch()
    {
        TestTemporalContext temporal = TestTemporalContext.CreateCanonical();
        string connectionString = await PostgresSqlSugarTestClient
            .CreateConnectionStringAsync(fixture);

        await using (var connection = new NpgsqlConnection(connectionString))
        {
            await connection.OpenAsync();
            (string timezone, string epoch) = await ObserveAsync(connection);
            PostgresSqlSugarTestClient.VerifyTemporalObservation(temporal, timezone, epoch);
        }

        var mismatched = new NpgsqlConnectionStringBuilder(connectionString)
        {
            Options =
                $"-c timezone=Asia/Shanghai -c fsusblog.test_business_epoch_utc={temporal.BusinessEpochUtc:O}"
        };
        await using var mismatchConnection = new NpgsqlConnection(mismatched.ConnectionString);
        await mismatchConnection.OpenAsync();
        (string mismatchTimezone, string mismatchEpoch) =
            await ObserveAsync(mismatchConnection);
        Assert.Throws<InvalidOperationException>(() =>
            PostgresSqlSugarTestClient.VerifyTemporalObservation(
                temporal,
                mismatchTimezone,
                mismatchEpoch));
    }

    private static async Task<(string Timezone, string Epoch)> ObserveAsync(
        NpgsqlConnection connection)
    {
        await using var command = new NpgsqlCommand(
            """
            SELECT
                current_setting('TimeZone'),
                current_setting('fsusblog.test_business_epoch_utc', true)
            """,
            connection);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        return (reader.GetString(0), reader.GetString(1));
    }
}
